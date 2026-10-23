/**
 * P0 browser smoke API: deterministic in-memory data and test identities.
 * Test-only. The application entry point (main.ts) never imports this module;
 * production always uses PostgreSQL with password or AI Hub sessions.
 */
import { registerAssistantRoutes } from '../../http/admin/assistant-routes.ts'
import { registerModelGovernanceRoutes } from '../../http/admin/model-routes.ts'
import { registerSkillInstallationRoutes } from '../../http/admin/skill-installation-routes.ts'
import { registerUserPreferenceRoutes } from '../../http/workbench/preference-routes.ts'
import { registerConversationTargetRoutes } from '../../http/workbench/conversation-target-routes.ts'
import { Router, envelope } from '../../http/router.ts'
import { MemoryModelGovernanceRepository } from '../../modules/model/memory-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { testApiAuthenticator } from '../test-identity.ts'
import { AdminQueryService } from './admin-query-service.ts'
import { MemoryUserPreferenceStore } from './memory-user-preferences.ts'
import { MemoryConversationTargetStore } from './memory-conversation-targets.ts'
import { registerAdminRoutes } from './admin-routes.ts'
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
  registerConversationTargetRoutes(router, new MemoryConversationTargetStore(repository), undefined, 'prototype-memory')
  registerAdminRoutes(router, new AdminQueryService(repository))
  registerModelGovernanceRoutes(router, new ModelGovernanceService(new MemoryModelGovernanceRepository()))
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
