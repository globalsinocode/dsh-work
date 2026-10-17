import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresProjectService } from '../../modules/workbench/application/postgres-project-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  routeValidationFailed,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'
import { requireTeamActor } from './workspace-member-routes.ts'

const basePath = '/api/workbench/v1'
const allRoles = ['owner', 'admin', 'member', 'viewer'] as const
const writerRoles = ['owner', 'admin', 'member'] as const
const projectOnly = { teamOnlyMessage: '仅项目空间支持简报与任务' }

/**
 * 项目空间 S1：项目简报与项目任务（docs/design/project-space-plan.md 第 4～6 节）。
 * 读取走读取轨（归档空间现任成员可读），写入走执行轨；服务层在事务内复核角色与空间状态。
 */
export function registerProjectRoutes(
  router: Router,
  projects: PostgresProjectService,
  authorization: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces/:workspaceId/brief`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...projectOnly, allowArchived: true })
    return envelope('workbench', await projects.getBrief(workspaceId, identity.userId), 'postgres')
  })

  router.put(`${basePath}/workspaces/:workspaceId/brief`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'], projectOnly)
    const body = await readObject(request)
    return envelope('workbench', await projects.saveBrief(workspaceId, identity.userId, {
      content: body.content,
      dueDate: body.dueDate,
    }), 'postgres')
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-tasks`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...projectOnly, allowArchived: true })
    return envelope('workbench', await projects.listTasks(workspaceId, identity.userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/project-tasks`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    const task = await projects.createTask(workspaceId, identity.userId, {
      title: body.title,
      description: body.description,
      assignee: body.assignee,
      inputFileIds: body.inputFileIds,
      dueDate: body.dueDate,
    })
    return httpResult(201, envelope('workbench', task, 'postgres'))
  })

  router.patch(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    return envelope('workbench', await projects.updateTask(workspaceId, context.params['taskId'] ?? '', identity.userId, {
      title: body.title,
      description: body.description,
      assignee: body.assignee,
      inputFileIds: body.inputFileIds,
      dueDate: body.dueDate,
    }), 'postgres')
  })

  router.delete(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    await projects.removeTask(workspaceId, context.params['taskId'] ?? '', identity.userId)
    return envelope('workbench', { removed: true }, 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/start`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    const headerKey = request.headers['idempotency-key']
    const task = await projects.startAgentTask(workspaceId, context.params['taskId'] ?? '', identity.userId, {
      idempotencyKey: body.idempotencyKey ?? (Array.isArray(headerKey) ? headerKey[0] : headerKey),
      authorizationContext: sessionAuthorizationContext(identity),
    })
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/status`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    return envelope('workbench', await projects.setEmployeeTaskStatus(workspaceId, context.params['taskId'] ?? '', identity.userId, {
      status: body.status,
      completionNote: body.completionNote,
      deliverableFileIds: body.deliverableFileIds,
    }), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/sessions/:sessionId/project-task`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    const task = await projects.markThreadAsTask(workspaceId, context.params['sessionId'] ?? '', identity.userId, {
      title: body.title,
    })
    return httpResult(201, envelope('workbench', task, 'postgres'))
  })
}

async function readObject(request: Parameters<typeof readJsonBody>[0]): Promise<Record<string, unknown>> {
  const body = await readJsonBody<unknown>(request)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw routeValidationFailed('请求体必须是 JSON 对象')
  return body as Record<string, unknown>
}
