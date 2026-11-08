/**
 * P0 browser smoke API: deterministic in-memory data and test identities.
 * Test-only. The application entry point (main.ts) never imports this module;
 * production always uses PostgreSQL with password or AI Hub sessions.
 */
import { registerAssistantRoutes } from '../../http/admin/assistant-routes.ts'
import { registerModelGovernanceRoutes } from '../../http/admin/model-routes.ts'
import { registerOrganizationRoutes } from '../../http/admin/organization-routes.ts'
import { registerKnowledgeAdminRoutes } from '../../http/admin/knowledge-admin-routes.ts'
import { registerSkillInstallationRoutes } from '../../http/admin/skill-installation-routes.ts'
import { registerUserPreferenceRoutes } from '../../http/workbench/preference-routes.ts'
import { registerConversationTargetRoutes } from '../../http/workbench/conversation-target-routes.ts'
import { registerUserNotificationRoutes } from '../../http/workbench/user-notification-routes.ts'
import { registerKnowledgeRoutes } from '../../http/workbench/knowledge-routes.ts'
import { registerWorkspaceTimelineRoutes } from '../../http/workbench/workspace-timeline-routes.ts'
import { Router, envelope, readJsonBody } from '../../http/router.ts'
import { MemoryModelGovernanceRepository } from '../../modules/model/memory-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { testApiAuthenticator } from '../test-identity.ts'
import { AdminQueryService } from './admin-query-service.ts'
import { MemoryUserPreferenceStore } from './memory-user-preferences.ts'
import { MemoryDingTalkBindingStore } from './memory-dingtalk-binding.ts'
import { registerDingTalkBindingRoutes } from '../../http/workbench/dingtalk-binding-routes.ts'
import { MemoryConversationTargetStore } from './memory-conversation-targets.ts'
import { MemoryOrganizationStore } from './memory-organization.ts'
import { MemoryUserNotificationStore } from './memory-user-notifications.ts'
import { MemoryKnowledgeBaseStore } from './memory-knowledge.ts'
import { MemoryKnowledgeAdminStore } from './memory-knowledge-admin.ts'
import { MemoryWorkspaceTimeline } from './memory-workspace-timeline.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { registerModelUsageRoutes } from '../../http/admin/model-usage-routes.ts'
import { SmokeModelUsageService } from './model-usage-service.ts'
import { registerSmokeProjectRoutes } from './project-routes.ts'
import { SmokeRepository } from './smoke-repository.ts'
import { registerUnavailableWorkbenchCommandRoutes } from './unavailable-routes.ts'
import { WorkbenchQueryService } from './workbench-query-service.ts'
import { registerPrototypeArtifactFileRoutes, registerWorkbenchRoutes } from './workbench-routes.ts'

export function createSmokeRouter() {
  const repository = new SmokeRepository()
  const workbenchQueries = new WorkbenchQueryService(repository)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  // The login pages treat this mode as "already signed in with a test identity".
  for (const audience of ['workbench', 'admin']) {
    router.get(`/auth/${audience}/configuration`, () => ({ mode: 'prototype', localEnabled: false, aiHubEnabled: false }))
  }
  // Same registration order as the former in-memory server mode.
  registerUnavailableWorkbenchCommandRoutes(router)
  registerPrototypeArtifactFileRoutes(router, workbenchQueries)
  registerAssistantRoutes(router)
  registerSkillInstallationRoutes(router)
  registerWorkbenchRoutes(router, workbenchQueries)
  registerSmokeProjectRoutes(router)
  registerUserPreferenceRoutes(router, new MemoryUserPreferenceStore(), 'prototype-memory')
  registerDingTalkBindingRoutes(router, new MemoryDingTalkBindingStore(), 'prototype-memory')
  registerConversationTargetRoutes(router, new MemoryConversationTargetStore(repository), undefined, 'prototype-memory')
  registerUserNotificationRoutes(router, new MemoryUserNotificationStore(), undefined, 'prototype-memory')
  const knowledge = new MemoryKnowledgeBaseStore()
  registerKnowledgeRoutes(router, knowledge, undefined, 'prototype-memory')
  // 测试专用：切换测试身份的知识库权限级别（KB-P0-01 在三种权限下运行）。
  router.post('/api/testing/p0/knowledge-level', async request => {
    const body = await readJsonBody<{ level?: string }>(request)
    if (body.level !== 'none' && body.level !== 'view' && body.level !== 'docs' && body.level !== 'bases') throw new Error('invalid level')
    knowledge.level = body.level
    return { level: knowledge.level }
  })
  // 冒烟只有一个测试身份：授权直接通过，成员与归档口径由 PostgreSQL 集成测试覆盖。
  registerWorkspaceTimelineRoutes(router, new MemoryWorkspaceTimeline(repository), { authorizeWorkbench: async () => undefined as never }, 'prototype-memory')
  const modelUsage = new SmokeModelUsageService()
  registerAdminRoutes(router, new AdminQueryService(repository, modelUsage))
  registerModelUsageRoutes(router, modelUsage, 'prototype-memory')
  registerModelGovernanceRoutes(router, new ModelGovernanceService(new MemoryModelGovernanceRepository()))
  registerOrganizationRoutes(router, new MemoryOrganizationStore(), 'prototype-memory')
  registerKnowledgeAdminRoutes(router, new MemoryKnowledgeAdminStore(), 'prototype-memory')
  router.get('/health/live', () => ({ status: 'ok', service: 'dsh-work-p0-smoke' }))
  router.get('/health/ready', () => ({ status: 'ready', core: true, testOnly: true }))
  router.get('/health', () => envelope('system', {
    service: 'dsh-work-p0-smoke',
    status: 'ok',
    testOnly: true,
    persistence: 'prototype-memory',
    dshRuntime: 'not-configured',
    database: 'not-configured',
  }))
  return router
}
