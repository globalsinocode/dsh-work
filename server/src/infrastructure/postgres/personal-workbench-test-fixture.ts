/** Isolated test harness only. Never imported by the application bootstrap. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createThrowawayDatabase } from './test-database.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { UnavailableRuntime } from '../../modules/runtime/execution-capabilities.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import { Router } from '../../http/router.ts'
import { registerConversationRoutes } from '../../http/workbench/conversation-routes.ts'
import { registerContentRoutes } from '../../http/workbench/content-routes.ts'

export const testTenant = 'tenant-dsh-work'
export async function personalWorkbenchFixture(prefix: string) {
  const db = await createThrowawayDatabase({ namePrefix: prefix, maxConnections: 6 })
  const root = await mkdtemp(join(tmpdir(), prefix))
  const auth = new PostgresAuthorizationService(db.client)
  const content = new PostgresContentService(db.client, root, auth)
  const conversations = new PostgresConversationRepository(db.client)
  const runs = new PostgresRunRepository(db.client)
  const agents = new PostgresAgentService(db.client)
  const runtime = new UnavailableRuntime('runtime-local-01')
  const orchestration = new RunOrchestrationService(runs, conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(db.client)), runtime,
    content, undefined, agents, undefined, auth)
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await prototypeApiAuthenticator(request, audience)
    const user = request.headers['x-test-user-id']
    return user ? { ...identity, userId: String(user) } : identity
  } })
  registerConversationRoutes(router, conversations, orchestration, runs, agents, auth)
  registerContentRoutes(router, content, auth)
  const server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}/api/workbench/v1`
  return {
    db, root, auth, content, conversations, runs, orchestration, origin,
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
