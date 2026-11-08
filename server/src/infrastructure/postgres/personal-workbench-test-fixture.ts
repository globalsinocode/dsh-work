/** Isolated test harness only. Never imported by the application bootstrap. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createThrowawayDatabase } from './test-database.ts'
import { DataProtectionInputPreflight } from '../../modules/data-protection/data-protection-input-preflight.ts'
import { PostgresDataProtectionStore } from '../../modules/data-protection/data-protection-service.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import type { ArtifactTextExtractorPort } from '../../modules/workbench/application/container-artifact-text-extractor.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { UnavailableRuntime } from '../../modules/runtime/execution-capabilities.ts'
import { testApiAuthenticator } from '../../testing/test-identity.ts'
import type { AgentRuntimePort } from '../../modules/runtime/runtime-types.ts'
import { registerWorkbenchAgentRoutes } from '../../http/workbench/agent-routes.ts'
import { registerConversationTargetRoutes } from '../../http/workbench/conversation-target-routes.ts'
import { registerWorkspaceTimelineRoutes } from '../../http/workbench/workspace-timeline-routes.ts'
import { PostgresWorkspaceTimelineService } from '../../modules/workbench/application/postgres-workspace-timeline-service.ts'
import { registerUserPreferenceRoutes } from '../../http/workbench/preference-routes.ts'
import { PostgresConversationTargetService } from '../../modules/workbench/application/postgres-conversation-target-service.ts'
import { PostgresUserPreferenceService } from '../../modules/workbench/application/postgres-user-preference-service.ts'
import { Router, envelope, requireRequestIdentity } from '../../http/router.ts'
import { AgentRecommendationService } from '../../modules/agent/agent-recommendation-service.ts'
import { registerConversationRoutes } from '../../http/workbench/conversation-routes.ts'
import { registerContentRoutes } from '../../http/workbench/content-routes.ts'
import { registerAutomationRoutes } from '../../http/workbench/automation-routes.ts'
import { AutomationService } from '../../modules/automation/automation-service.ts'
import { PostgresAutomationRepository } from '../../modules/automation/postgres-automation-repository.ts'
import { defaultAutomationConfig } from '../../modules/automation/automation-types.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'
import { PostgresProjectArchiveService } from '../../modules/workbench/application/postgres-project-archive-service.ts'
import { PostgresProjectService } from '../../modules/workbench/application/postgres-project-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceMemberService } from '../../modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceLifecycleService } from '../../modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { PostgresWorkspaceActivityService } from '../../modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceUsageService } from '../../modules/workbench/application/postgres-workspace-usage-service.ts'
import { PostgresWorkspaceService } from '../../modules/workbench/application/postgres-workspace-service.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import { registerProjectRoutes } from '../../http/workbench/project-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from '../../http/workbench/workspace-agent-member-routes.ts'
import { registerWorkspaceMemberRoutes } from '../../http/workbench/workspace-member-routes.ts'
import { registerWorkspaceLifecycleRoutes } from '../../http/workbench/workspace-lifecycle-routes.ts'
import { registerWorkspaceActivityRoutes } from '../../http/workbench/workspace-activity-routes.ts'
import { registerWorkspaceUsageRoutes } from '../../http/workbench/workspace-usage-routes.ts'
import { registerSkillSubmissionRoutes } from '../../http/workbench/skill-submission-routes.ts'
import { registerUserNotificationRoutes } from '../../http/workbench/user-notification-routes.ts'
import { PostgresUserNotificationService } from '../../modules/workbench/application/postgres-user-notification-service.ts'
import { SkillSubmissionService } from '../../modules/skill/skill-submission-service.ts'
import { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'

export const testTenant = 'tenant-dsh-work'
export async function personalWorkbenchFixture(prefix: string, options: {
  port?: number
  runtime?: AgentRuntimePort
  browser?: boolean
  automationMaxConcurrent?: number
  /** P1 项目空间浏览器夹具：额外注册成员、Agent 成员、项目、生命周期、动态与用量路由。 */
  projectSpace?: boolean
  /** 二进制成果解析的测试替身（不启动容器）；未传时二进制成果没有解析文本。 */
  artifactTextExtractor?: ArtifactTextExtractorPort
} = {}) {
  const db = await createThrowawayDatabase({ namePrefix: prefix, maxConnections: 6 })
  const root = await mkdtemp(join(tmpdir(), prefix))
  const auth = new PostgresAuthorizationService(db.client)
  const content = new PostgresContentService(db.client, new LocalObjectStorage(root), auth, undefined, undefined, { artifactTextExtractor: options.artifactTextExtractor })
  const conversations = new PostgresConversationRepository(db.client)
  const runs = new PostgresRunRepository(db.client)
  const agents = new PostgresAgentService(db.client)
  const recommendations = new AgentRecommendationService(db.client, agents, auth)
  conversations.setRecommendationReader(recommendations)
  // SKC-01：Skill 草稿按真实包规则保存在本次夹具的临时目录中；合成运行经服务登记草稿。
  const skillSubmissions = new SkillSubmissionService({
    database: db.client, skills: new PostgresSkillService(db.client), authorization: auth,
    artifactStore: new SkillArtifactStore(new LocalObjectStorage(join(root, 'skills'))),
    // 合成环境没有执行容器；按“沙箱可用”核对，含脚本的样例草稿才不会被判为不兼容。
    pythonSandboxAvailable: true,
  })
  conversations.setSkillDraftReader(skillSubmissions)
  const automationRepository = new PostgresAutomationRepository(db.client)
  const runtime = options.runtime ?? new UnavailableRuntime('runtime-local-01')
  const projectArchive = options.projectSpace ? new PostgresProjectArchiveService(db.client) : undefined
  const workspaceAgentMembers = options.projectSpace
    ? new PostgresWorkspaceAgentMemberService(db.client, auth, agents)
    : undefined
  const projects = projectArchive && workspaceAgentMembers
    ? new PostgresProjectService(db.client, workspaceAgentMembers, projectArchive)
    : undefined
  // 输入预检用真实实现；默认路由固定按外部厂商处理（DLP-01、DLP-02）。
  const inputPolicy = new DataProtectionInputPreflight({
    store: new PostgresDataProtectionStore(db.client), tenantId: 'tenant-dsh-work', routeTrustLevel: async () => 'external',
  })
  const orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), runtime,
    content, undefined, agents, undefined, auth, {
      automationMaxConcurrent: options.automationMaxConcurrent,
      automationStatusLookup: runId => automationRepository.automationStatusForRun(runId),
      agentMembers: workspaceAgentMembers,
      tasks: new PostgresTaskRepository(db.client),
      projectTasks: projects,
      projectArchive,
      inputPolicy,
    })
  if (projects) projects.attachRunStarter(orchestration)
  const automationService = new AutomationService(
    db.client,
    automationRepository,
    conversations,
    runs,
    orchestration,
    auth,
    agents,
    content,
    undefined,
    defaultAutomationConfig,
    inputPolicy,
  )
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await testApiAuthenticator(request, audience)
    const user = request.headers['x-test-user-id']
    return user ? { ...identity, userId: String(user) } : identity
  } })
  registerConversationRoutes(router, conversations, orchestration, runs, agents, auth)
  registerContentRoutes(router, content, auth)
  registerSkillSubmissionRoutes(router, skillSubmissions)
  // 站内通知（NC-S1/S2）：两种模式的铃铛都会请求，与 main.ts 一致挂上。
  registerUserNotificationRoutes(router, new PostgresUserNotificationService(db.client), auth)
  let projectResources: {
    projectArchive: PostgresProjectArchiveService
    workspaceAgentMembers: PostgresWorkspaceAgentMemberService
    projects: PostgresProjectService
    workspaceMembers: PostgresWorkspaceMemberService
    lifecycle: PostgresWorkspaceLifecycleService
    activity: PostgresWorkspaceActivityService
    usage: PostgresWorkspaceUsageService
  } | undefined
  if (options.projectSpace && projects && projectArchive && workspaceAgentMembers) {
    const workspaceService = new PostgresWorkspaceService(db.client)
    const workspaceMembers = new PostgresWorkspaceMemberService(db.client, auth)
    const lifecycle = new PostgresWorkspaceLifecycleService(db.client)
    const activity = new PostgresWorkspaceActivityService(db.client, workspaceService)
    const usage = new PostgresWorkspaceUsageService(db.client, workspaceService, auth)
    registerWorkspaceMemberRoutes(router, workspaceMembers, auth)
    registerWorkspaceAgentMemberRoutes(router, workspaceAgentMembers, auth)
    registerProjectRoutes(router, projects, auth, projectArchive)
    registerWorkspaceLifecycleRoutes(router, lifecycle, auth)
    registerWorkspaceActivityRoutes(router, activity, auth)
    registerWorkspaceUsageRoutes(router, usage, auth)
    registerWorkspaceTimelineRoutes(router, new PostgresWorkspaceTimelineService(db.client, workspaceService), auth)
    projectResources = { projectArchive, workspaceAgentMembers, projects, workspaceMembers, lifecycle, activity, usage }
  }
  if (options.browser) {
    registerWorkbenchAgentRoutes(router, agents, auth)
    registerAutomationRoutes(router, automationService)
    // 员工端双模式（S5）：浏览器旅程需要与生产同一组偏好与对话对象接口。
    registerUserPreferenceRoutes(router, new PostgresUserPreferenceService(db.client))
    registerConversationTargetRoutes(router, new PostgresConversationTargetService(db.client, agents), auth)
    router.get('/api/workbench/v1/session', (_request, context) => {
      const identity = requireRequestIdentity(context, 'workbench')
      return envelope('workbench', { user: identity.profile, identityProvider: 'prototype-sso', apiAudience: 'workbench' })
    })
    router.get('/api/workbench/v1/skills', () => envelope('workbench', []))
    router.get('/health', () => ({ status: 'ok', testOnly: true, runtime: 'synthetic-no-model' }))
  }
  const server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}/api/workbench/v1`
  return {
    db, root, auth, content, conversations, runs, orchestration, agents, recommendations, skillSubmissions, automationRepository,
    automationService, origin, router,
    ...projectResources,
    async api(path: string, init?: RequestInit) {
      const response = await fetch(origin + path, init)
      return { status: response.status, body: await response.json() }
    },
    async team() {
      const team = await content.createWorkspace({ name: '合成测试团队', description: 'not business data' }, 'U00008')
      assert.ok(team)
      await db.client`insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${testTenant}, ${team.id}, 'U00001', 'member', 'U00008')`
      return team.id
    },
    async run(sessionId: string, status = 'succeeded') {
      const id = `run-${randomUUID()}`
      await db.client`insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
        values (${id}, ${testTenant}, ${sessionId}, 'U00001', ${id}, ${status})`
      return id
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await orchestration.close(); await db.dispose(); await rm(root, { recursive: true, force: true })
    },
  }
}
