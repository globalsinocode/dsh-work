import type { PostgresAuthorizationService, TeamMemberRole } from '../../modules/authorization/postgres-authorization-service.ts'
import type { RequestIdentity } from '../../modules/identity/types.ts'
import {
  isMemberRole,
  type MemberRole,
  type PostgresWorkspaceMemberService,
} from '../../modules/workbench/application/postgres-workspace-member-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  routePermissionDenied,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Team-space-only employee member management (1A-T3). Personal workspaces are
 * rejected before any role check so personal-space behavior stays unchanged.
 */
export function registerWorkspaceMemberRoutes(
  router: Router,
  members: PostgresWorkspaceMemberService,
  authorization: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces/:workspaceId/member-candidates`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const limit = parseLimit(context.url.searchParams.get('limit'))
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope('workbench', await members.listMemberCandidates(workspaceId, { query, cursor, limit }), 'postgres')
  })

  // Any current member may read the roster (it is not a management action);
  // the response carries the caller's own role so the client renders allowed
  // actions from the server instead of guessing ownership.
  // 成员名册属读取轨（3-T1）：归档空间的详情仍需展示成员与 Agent 身份，
  // 因此这里允许归档的现任成员读取。**候选人列表保持执行轨**（见上方候选端点）：
  // 归档空间不允许新增成员，不应暴露候选。
  router.get(`${basePath}/workspaces/:workspaceId/members`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin', 'member', 'viewer'], { allowArchived: true })
    return envelope('workbench', await members.listMembers(workspaceId, identity.userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/members`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const body = await readJsonBody<{ userId?: unknown; role?: unknown }>(request)
    const targetUserId = requireNonEmptyString(body.userId, 'userId')
    const role = parseMemberRole(body.role)
    const result = await members.addMember(workspaceId, targetUserId, role, identity.userId)
    return httpResult(result.created ? 201 : 200, envelope('workbench', result.member, 'postgres'))
  })

  router.patch(`${basePath}/workspaces/:workspaceId/members/:userId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const targetUserId = context.params['userId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const body = await readJsonBody<{ role?: unknown }>(request)
    const role = parseMemberRole(body.role)
    const member = await members.changeMemberRole(workspaceId, targetUserId, role, identity.userId)
    return envelope('workbench', member, 'postgres')
  })

  router.delete(`${basePath}/workspaces/:workspaceId/members/:userId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const targetUserId = context.params['userId'] ?? ''
    // 3-T1 治理例外：归档空间仍必须能执行紧急收权（撤销访问），否则「只读保留」
    // 会连带冻结撤权能力。仅此路径显式允许归档。
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'], { allowArchived: true })
    const result = await members.removeMember(workspaceId, targetUserId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/exit`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin', 'member', 'viewer'])
    const result = await members.exitWorkspace(workspaceId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/owner-transfer`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    // 3-T1 治理例外：归档空间仍必须能转交负责人（负责人不可被直接移除，转交是
    // 归档后唯一的负责人治理动作）。仅此路径显式允许归档。
    await requireTeamActor(authorization, identity, workspaceId, ['owner'], { allowArchived: true })
    const body = await readJsonBody<{ toUserId?: unknown }>(request)
    const toUserId = requireNonEmptyString(body.toUserId, 'toUserId')
    const result = await members.transferWorkspaceOwner(workspaceId, toUserId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })
}

/**
 * Identity + workspace resolution + team-only boundary + role check, per the
 * 1A-T3 contract. Only requireTeamRole's two known denial messages are
 * re-thrown as typed 403s so the shared error classifier surfaces them as
 * permission_denied; anything else — e.g. a database outage — propagates
 * unchanged and is classified on its own merits. Shared by the 1A-T4 agent
 * member routes.
 *
 * 3-T1: execution by default. `allowArchived` is the explicit governance
 * exception for emergency revocation and owner transfer on an archived
 * workspace, and is passed only by those two routes.
 *
 * 3-T2: `teamOnlyMessage` lets the archive/restore routes keep the same guard
 * while naming their own team-only boundary (personal workspaces stay 422, the
 * AC-23 convention for team-only endpoints).
 */
export async function requireTeamActor(
  authorization: PostgresAuthorizationService,
  identity: RequestIdentity,
  workspaceId: string,
  allowedRoles: TeamMemberRole[],
  options: { allowArchived?: boolean; teamOnlyMessage?: string } = {},
) {
  const allowArchived = options.allowArchived === true
  const access = await authorization.authorizeWorkbench({
    userId: identity.userId,
    workspaceId,
    ...sessionAuthorizationContext(identity),
    allowArchived,
  })
  if (access.workspaceType !== 'team') {
    throw new Error(options.teamOnlyMessage ?? '仅支持团队工作空间进行成员管理')
  }
  try {
    await authorization.requireTeamRole(workspaceId, identity.userId, allowedRoles, {
      purpose: allowArchived ? 'read' : 'execution',
    })
  } catch (error) {
    if (isTeamRoleDenial(error)) throw routePermissionDenied(error.message)
    throw error
  }
}

/**
 * The two denial messages PostgresAuthorizationService.requireTeamRole
 * raises: missing workspace/membership and role outside the allowed set.
 */
function isTeamRoleDenial(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  return error.message === '工作空间不存在、已归档或当前用户不是成员'
    || error.message.startsWith('当前用户角色无权执行此操作')
}

function parseMemberRole(value: unknown): MemberRole {
  if (!isMemberRole(value)) throw routeValidationFailed(`无效的角色：${String(value)}`)
  return value
}

export function requireNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') throw routeValidationFailed(`${field} 不能为空`)
  return value.trim()
}

export function parseLimit(raw: string | null) {
  if (raw === null || raw === '') return 20
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw routeValidationFailed('limit 必须为 1 到 100 之间的整数')
  return limit
}
