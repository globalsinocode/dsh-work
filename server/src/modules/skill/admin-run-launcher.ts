import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { RuntimeSkillConfiguration } from './postgres-skill-service.ts'

/**
 * What Skill installation needs from run orchestration: start, cancel and retry the DSH-driven
 * installation assistant and Skill trial runs. Defined by the consumer so the skill module does
 * not depend on the run module. Implemented by RunOrchestrationService.
 */
export interface AdminRunLauncher {
  startAdminRun(input: {
    userId: string
    sessionId: string
    prompt: string
    idempotencyKey: string
    source: string
    testSkill?: RuntimeSkillConfiguration
    history?: RuntimeManifest['input']['conversation_history']
  }): Promise<{ id: string }>
  cancelAdminRun(runId: string, userId: string): Promise<unknown>
  retryAdminRun(runId: string, userId: string): Promise<unknown>
}
