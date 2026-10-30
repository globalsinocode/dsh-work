/**
 * Agent validation & publish P1 browser harness.
 *
 * Creates a disposable PostgreSQL database and exposes the real Agent, validation,
 * authorization and Run orchestration services behind the admin routes. Validation
 * cases still go through Run/Attempt → Runtime port (background lane); the Runtime is a
 * deterministic synthetic responder, so this harness proves page and governance
 * behaviour only. It does not contact OIDC, a model, MCP services or real DSH.
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { testApiAuthenticator } from '../../server/src/testing/test-identity.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import { PostgresAgentAccessService } from '../../server/src/modules/agent/agent-access-service.ts'
import { PostgresAgentValidationService } from '../../server/src/modules/agent/agent-validation-service.ts'
import { PostgresAgentRunHistory } from '../../server/src/modules/agent/agent-run-history.ts'
import { PostgresMcpConnectorService } from '../../server/src/modules/tool/postgres-mcp-connector-service.ts'
import { PostgresToolConnectorService } from '../../server/src/modules/tool/postgres-tool-connector-service.ts'
import { PostgresSkillService } from '../../server/src/modules/skill/postgres-skill-service.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../server/src/modules/run/run-orchestration-service.ts'
import { ModelGovernanceService } from '../../server/src/modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../server/src/modules/model/postgres-model-governance-repository.ts'
import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'
import { registerAgentRoutes } from '../../server/src/http/admin/agent-routes.ts'
import { registerAgentAccessRoutes } from '../../server/src/http/admin/agent-access-routes.ts'
import { registerAgentValidationRoutes } from '../../server/src/http/admin/agent-validation-routes.ts'
import { registerToolRoutes } from '../../server/src/http/admin/tool-routes.ts'
import { PostgresToolConnectorService } from '../../server/src/modules/tool/postgres-tool-connector-service.ts'
import { envelope, Router, requireRequestIdentity } from '../../server/src/http/router.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../server/src/modules/runtime/runtime-types.ts'

/** Inputs containing this marker make the synthetic Runtime fail, to exercise failure UI. */
export const SYNTHETIC_FAILURE_MARKER = '#模拟执行失败'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4492)
const database = await createThrowawayDatabase({ namePrefix: 'dsh_agent_release_browser', maxConnections: 6 })

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
}

class SyntheticTrialRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    if (manifest.purpose !== 'agent-release-trial') throw new Error('验证与发布夹具只执行验证案例')
    let resolve: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(next => { resolve = next })
    const now = new Date().toISOString()
    const execution: Execution = {
      manifest, events: [], listeners: new Set(), resolve,
      snapshot: {
        runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
        startedAt: null, endedAt: null, manifestSha256: 'synthetic', attemptDirectory: '/synthetic',
        errorCode: null, errorMessage: null,
      },
    }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '已排队')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '已启动')
      setTimeout(() => this.complete(execution), 600)
    }, 300)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  private complete(execution: Execution) {
    if (execution.snapshot.status === 'cancelled') return
    const message = execution.manifest.input.message
    if (message.includes(SYNTHETIC_FAILURE_MARKER)) {
      execution.snapshot.status = 'failed'
      execution.snapshot.errorCode = 'SYNTHETIC_FAILURE'
      this.emit(execution, 'run.failed', '合成 Runtime 按测试标记返回失败', { error_code: 'SYNTHETIC_FAILURE' })
    } else {
      const answer = `【合成回答，非模型输出】已收到请求：「${message}」。\n根据职责定义，我会先核对输入是否完整，再说明可以完成的部分与依据；超出授权或能力范围的内容会明确拒绝，不虚构执行结果。`
      this.emit(execution, 'assistant.delta', answer)
      this.emit(execution, 'assistant.completed', answer)
      execution.snapshot.status = 'completed'
      this.emit(execution, 'run.completed', '已完成')
    }
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution || ['completed', 'cancelled', 'failed'].includes(execution.snapshot.status)) return { accepted: false }
    execution.snapshot.status = 'cancelled'
    this.emit(execution, 'run.cancelled', '已取消')
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
    return { accepted: true }
  }

  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async inspectMcpConnection() {
    return { latencyMs: 1, capabilities: [
      { name: 'lookup', description: '查询可丢弃的合成数据', inputSchema: { type: 'object', properties: {} } },
    ] }
  }
  async health() {
    return {
      status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true,
      dshRepository: '/synthetic/agent-release-browser', transport: 'acp-stdio' as const,
      message: 'Agent release browser synthetic Runtime',
    }
  }
  async close() {}

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], display: string, safeMetadata: Record<string, unknown> = {}) {
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: execution.manifest.run_id, attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
      display_message: display, safe_metadata: safeMetadata, trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}

const runtime = new SyntheticTrialRuntime()
const authorization = new PostgresAuthorizationService(database.client)
const mcp = new PostgresMcpConnectorService(database.client, runtime)
const toolService = new PostgresToolConnectorService(database.client, runtime)
const skills = new PostgresSkillService(database.client)
const agents = new PostgresAgentService(database.client, undefined, skills, toolService)
const orchestration = new RunOrchestrationService(
  new PostgresRunRepository(database.client),
  new PostgresConversationRepository(database.client),
  new ModelGovernanceService(new PostgresModelGovernanceRepository(database.client)),
  runtime, undefined, undefined, agents, undefined, authorization,
  { toolChecks: { assertPinnedConnections: pins => mcp.assertPinnedConnections(pins) } },
)
const validation = new PostgresAgentValidationService(database.client, agents, skills, orchestration, mcp)
await validation.recoverInterruptedValidations()

const router = new Router({ authenticateApi: testApiAuthenticator })
const base = '/api/admin/v1'
router.get(`${base}/session`, (_request, context) => {
  const identity = requireRequestIdentity(context, 'admin')
  return envelope('admin', {
    user: identity.profile, identityProvider: identity.identityProvider,
    apiAudience: 'admin', permissions: ['admin:read', 'admin:write'],
  }, 'postgres')
})
for (const path of ['tasks', 'runtimes', 'workspaces', 'skills', 'skill-versions', 'skill-release-records', 'health', 'usage', 'assistant/sessions']) {
  router.get(`${base}/${path}`, () => envelope('admin', [], 'postgres'))
}
router.get(`${base}/skills/builtin`, () => envelope('admin', { skills: [], scenarios: [], disabledBuiltinSkills: [] }, 'postgres'))
router.get(`${base}/platform-status`, () => envelope('admin', {
  mode: 'test', identity: 'prototype', persistence: 'postgres', runtime: 'synthetic',
}, 'postgres'))
router.get(`${base}/identity/roles`, async () => envelope('admin', await database.client`
  select id, code, name, description, status, permissions,
    '[]'::jsonb as "dataScopes", 0 as "userCount", false as system, now() as "updatedAt"
    from roles where tenant_id = 'tenant-dsh-work' order by name
`, 'postgres'))
registerAgentRoutes(router, agents)
registerAgentAccessRoutes(router, new PostgresAgentAccessService(database.client))
registerAgentValidationRoutes(router, agents, validation, new PostgresAgentRunHistory(database.client))
registerToolRoutes(router, toolService)
router.get('/health', () => ({ status: 'ok', testOnly: true, runtime: 'synthetic-agent-release-trial' }))

const server = createServer((request, response) => void router.handle(request, response))
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
console.log(`Agent validation browser harness ready on ${port}; throwaway PostgreSQL and synthetic validation Runtime, no OIDC/model/MCP/DSH.`)

let closing = false
async function close() {
  if (closing) return
  closing = true
  await new Promise<void>(resolve => server.close(() => resolve()))
  await orchestration.close()
  await database.dispose()
  process.exit(0)
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
