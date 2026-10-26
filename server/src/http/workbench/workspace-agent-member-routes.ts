import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type {
  AgentMemberPatchAction,
  PostgresWorkspaceAgentMemberService,
} from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import {
  projectAllRoles as allRoles,
  projectGovernanceRoles as governanceRoles,
  projectOwnerRoles as ownerRoles,
} from '../../domain/project-roles.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'
import { parseLimit, requireNonEmptyString, requireTeamActor } from './workspace-member-routes.ts'

const basePath = '/api/workbench/v1'

/**
 * Team-space-only agent member management (1A-T4). Agents join pinned to an
 * exact published version; joins, disables, upgrades and removes maintain
 * the workspace capability grant sources in the same transaction. Personal
 * workspaces are rejected before any role check so personal-space behavior
 * stays unchanged (AC-23).
 */
export function registerWorkspaceAgentMemberRoutes(
  router: Router,
  agentMembers: PostgresWorkspaceAgentMemberService,
  authorization: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces/:workspaceId/agent-candidates`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles)
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const limit = parseLimit(context.url.searchParams.get('limit'))
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope('workbench', await agentMembers.listAgentCandidates(
      workspaceId,
      identity.userId,
      sessionAuthorizationContext(identity).roleIds,
      { query, cursor, limit },
    ), 'postgres')
  })

  // Agent 成员名册属读取轨（3-T1）：与成员名册同理，归档详情仍需展示；
  // Agent 候选与加入/停用/升级/移出保持执行轨。
  router.get(`${basePath}/workspaces/:workspaceId/agent-members`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, allRoles, { allowArchived: true })
    return envelope('workbench', await agentMembers.listAgentMembers(workspaceId, identity.userId), 'postgres')
  })

  // 项目空间 S0：添加“员工”前预览对 Agent 可交付数据范围的影响（只读，不改状态）。
  // 与添加员工同权限（负责人与管理员）；Agent 成员的添加/停用/移出仍是负责人专属。
  router.get(`${basePath}/workspaces/:workspaceId/agent-members/disclosure-impact`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, governanceRoles)
    const userId = requireNonEmptyString(context.url.searchParams.get('userId') ?? undefined, 'userId')
    return envelope('workbench', await agentMembers.previewMemberDisclosureImpact(workspaceId, userId, identity.userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/agent-members`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles)
    const body = await readJsonBody<{ agentId?: unknown }>(request)
    const agentId = requireNonEmptyString(body.agentId, 'agentId')
    const member = await agentMembers.addAgentMember(
      workspaceId,
      agentId,
      identity.userId,
      sessionAuthorizationContext(identity).roleIds,
    )
    return httpResult(201, envelope('workbench', member, 'postgres'))
  })

  router.patch(`${basePath}/workspaces/:workspaceId/agent-members/:id`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const memberId = context.params['id'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles)
    const body = await readJsonBody<{ action?: unknown }>(request)
    const action = parseAgentMemberAction(body.action)
    const member = await agentMembers.updateAgentMember(workspaceId, memberId, action, identity.userId)
    return envelope('workbench', member, 'postgres')
  })

  router.delete(`${basePath}/workspaces/:workspaceId/agent-members/:id`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const memberId = context.params['id'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ownerRoles)
    const result = await agentMembers.removeAgentMember(workspaceId, memberId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })
}

const patchActions: AgentMemberPatchAction[] = ['disable', 'enable', 'upgrade']

export function isAgentMemberPatchAction(value: unknown): value is AgentMemberPatchAction {
  return typeof value === 'string' && patchActions.includes(value as AgentMemberPatchAction)
}

function parseAgentMemberAction(value: unknown): AgentMemberPatchAction {
  if (!isAgentMemberPatchAction(value)) throw routeValidationFailed(`无效的操作：${String(value)}`)
  return value
}
