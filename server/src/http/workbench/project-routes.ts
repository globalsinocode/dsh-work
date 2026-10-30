import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresProjectArchiveService } from '../../modules/workbench/application/postgres-project-archive-service.ts'
import type { PostgresProjectService } from '../../modules/workbench/application/postgres-project-service.ts'
import {
  projectAllRoles as allRoles,
  projectGovernanceRoles as governanceRoles,
  projectWriterRoles as writerRoles,
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
import { requireTeamActor } from './workspace-member-routes.ts'

const basePath = '/api/workbench/v1'
const projectOnly = { teamOnlyMessage: '仅项目空间支持简报与任务' }
const archiveOnly = { teamOnlyMessage: '仅项目空间支持项目档案' }

/**
 * 项目空间 S1/S2：项目简报、项目任务与项目档案（docs/design/project-space-plan.md 第 4～7 节）。
 * 读取走读取轨（归档空间现任成员可读），写入走执行轨；服务层在事务内复核角色与空间状态。
 */
export function registerProjectRoutes(
  router: Router,
  projects: PostgresProjectService,
  authorization: PostgresAuthorizationService,
  archive: PostgresProjectArchiveService,
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
    await requireTeamActor(authorization, identity, workspaceId, governanceRoles, projectOnly)
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
    return envelope('workbench', await projects.listTasks(workspaceId, identity.userId, {
      limit: context.url.searchParams.get('limit') ?? undefined,
      cursor: context.url.searchParams.get('cursor') ?? undefined,
      sessionId: context.url.searchParams.get('sessionId') ?? undefined,
    }), 'postgres')
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...projectOnly, allowArchived: true })
    return envelope('workbench', await projects.getTask(workspaceId, context.params['taskId'] ?? '', identity.userId), 'postgres')
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/events`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...projectOnly, allowArchived: true })
    return envelope('workbench', await projects.listTaskEvents(workspaceId, context.params['taskId'] ?? '', identity.userId), 'postgres')
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
      schedule: body.schedule,
      startNow: body.startNow,
    }, sessionAuthorizationContext(identity))
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
      schedule: body.schedule,
    }, sessionAuthorizationContext(identity)), 'postgres')
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
      prompt: body.prompt,
      authorizationContext: sessionAuthorizationContext(identity),
    })
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/status`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    const body = await readObject(request)
    return envelope('workbench', await projects.setTaskStatus(workspaceId, context.params['taskId'] ?? '', identity.userId, {
      status: body.status,
      completionNote: body.completionNote,
      deliverableFileIds: body.deliverableFileIds,
    }), 'postgres')
  })

  // S4：恢复因连续失败或规则设置人失效而暂停的定时执行。
  router.post(`${basePath}/workspaces/:workspaceId/project-tasks/:taskId/schedule/resume`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], projectOnly)
    return envelope('workbench', await projects.resumeTaskSchedule(workspaceId, context.params['taskId'] ?? '', identity.userId), 'postgres')
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-archive`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...archiveOnly, allowArchived: true })
    return envelope('workbench', await archive.getArchive(workspaceId, identity.userId), 'postgres')
  })

  router.put(`${basePath}/workspaces/:workspaceId/project-archive`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], archiveOnly)
    const body = await readObject(request)
    return envelope('workbench', await archive.saveArchive(workspaceId, identity.userId, {
      baseVersionNo: body.baseVersionNo,
      items: body.items,
    }), 'postgres')
  })

  router.get(`${basePath}/workspaces/:workspaceId/project-archive/versions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...allRoles], { ...archiveOnly, allowArchived: true })
    return envelope('workbench', await archive.listVersions(workspaceId, identity.userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/project-archive/rollback`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, [...writerRoles], archiveOnly)
    const body = await readObject(request)
    return envelope('workbench', await archive.rollbackArchive(workspaceId, identity.userId, {
      versionNo: body.versionNo,
      baseVersionNo: body.baseVersionNo,
    }), 'postgres')
  })
}

async function readObject(request: Parameters<typeof readJsonBody>[0]): Promise<Record<string, unknown>> {
  const body = await readJsonBody<unknown>(request)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw routeValidationFailed('请求体必须是 JSON 对象')
  return body as Record<string, unknown>
}
