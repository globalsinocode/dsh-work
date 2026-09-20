/**
 * B-05 / I-08 P1 browser harness.
 *
 * This process is test-only: it creates a disposable PostgreSQL database and
 * uses a deterministic synthetic Runtime. It never imports the production
 * bootstrap, a real identity provider, DSH, or a model endpoint.
 */
import { randomUUID } from 'node:crypto'

import { personalWorkbenchFixture, testTenant } from '../../server/src/infrastructure/postgres/personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from '../../server/src/infrastructure/postgres/personal-browser-runtime.ts'
import { envelope } from '../../server/src/http/router.ts'

const ownerUserId = 'U00001'
const runtime = new PersonalBrowserRuntime()
const fixture = await personalWorkbenchFixture('dsh_b05_automation_browser', {
  port: Number(process.env.DSH_WORK_AUTOMATION_SERVER_PORT ?? 4391),
  runtime,
  browser: true,
  // Leave one platform slot available for an interactive Run while one
  // automation Attempt occupies the automation lane.
  automationMaxConcurrent: 1,
})

const [seed] = await fixture.db.client<{ workspaceId: string; agentId: string; versionId: string }[]>`
  select w.id as "workspaceId", a.id as "agentId", a.active_version_id as "versionId"
    from workspaces w
    cross join lateral (
      select id, active_version_id from agents
       where tenant_id = ${testTenant} and status = 'published' and active_version_id is not null
       order by created_at asc limit 1
    ) a
   where w.tenant_id = ${testTenant} and w.workspace_type = 'personal'
     and w.created_by = ${ownerUserId} and w.status = 'active'
   order by w.created_at asc limit 1
`
if (!seed) throw new Error('自动任务 P1 夹具缺少个人空间或已发布 Agent')

fixture.router.get('/api/workbench/v1/test/automation/fixtures', () => envelope('workbench', {
  ownerUserId,
  workspaceId: seed.workspaceId,
  agentId: seed.agentId,
  agentVersionId: seed.versionId,
  synthetic: true,
}))

/** Seed the exact post-commit/pre-dispatch crash shape, then run production recovery. */
fixture.router.post('/api/workbench/v1/test/automations/:automationId/interrupted', async (_request, context) => {
  const automationId = context.params['automationId'] ?? ''
  const task = await fixture.automationService.getMine(ownerUserId, automationId)
  await fixture.db.client.begin(async transaction => {
    const session = await fixture.conversations.createSession({
      userId: ownerUserId,
      title: `[自动任务] ${task.name} · 中断夹具`,
      workspaceId: task.workspaceId,
      agentVersionId: task.agentVersionId,
    }, transaction)
    const run = await fixture.runs.createRun({
      tenantId: testTenant,
      sessionId: session.id,
      requestedBy: ownerUserId,
      idempotencyKey: `automation-interrupted-${randomUUID()}`,
    }, transaction)
    await fixture.automationRepository.insertExecution(transaction, {
      automationId,
      triggerId: `test-interrupted-${randomUUID()}`,
      kind: 'manual',
      plannedSlotUtc: new Date().toISOString(),
      taskRevision: task.revision,
      scheduleRevision: task.scheduleRevision,
      sessionId: session.id,
      runId: run.id,
      admissionStatus: 'accepted',
    })
  })
  const recovered = await fixture.automationService.recoverInterruptedPreparations()
  return envelope('workbench', { recovered }, 'postgres')
})

/** Browser visibility fixture; calendar and cursor mechanics stay in service tests. */
fixture.router.post('/api/workbench/v1/test/automations/:automationId/missed', async (_request, context) => {
  const automationId = context.params['automationId'] ?? ''
  const task = await fixture.automationService.getMine(ownerUserId, automationId)
  await fixture.db.client.begin(async transaction => {
    await fixture.automationRepository.insertExecution(transaction, {
      automationId,
      triggerId: `test-missed-${randomUUID()}`,
      kind: 'missed',
      plannedSlotUtc: null,
      missedFromUtc: new Date(Date.now() - 7_200_000).toISOString(),
      missedToUtc: new Date(Date.now() - 3_600_000).toISOString(),
      taskRevision: task.revision,
      scheduleRevision: task.scheduleRevision,
      admissionStatus: 'skipped',
      reasonCode: 'slot_expired',
    })
  })
  return envelope('workbench', { recorded: true }, 'postgres')
})

fixture.router.post('/api/workbench/v1/test/automation/revoke-owner', async () => {
  await fixture.db.client`update users set status = 'disabled' where tenant_id = ${testTenant} and id = ${ownerUserId}`
  return envelope('workbench', { status: 'disabled' }, 'postgres')
})

fixture.router.post('/api/workbench/v1/test/automation/restore-owner', async () => {
  await fixture.db.client`update users set status = 'active' where tenant_id = ${testTenant} and id = ${ownerUserId}`
  return envelope('workbench', { status: 'active' }, 'postgres')
})

fixture.router.post('/api/workbench/v1/test/automations/:automationId/publish-agent-v2', async (_request, context) => {
  const task = await fixture.automationService.getMine(ownerUserId, context.params['automationId'] ?? '')
  if (!task.agentId) throw new Error('固定版本所属 Agent 不存在')
  const versionId = `agent-version-${randomUUID()}`
  await fixture.db.client`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, system_prompt,
      visible_role_ids, data_scopes, skill_refs, tool_refs, status, created_by
    )
    select ${versionId}, tenant_id, agent_id, '2.0.0', name, description, system_prompt,
           visible_role_ids, data_scopes, skill_refs, tool_refs, 'published', ${ownerUserId}
      from agent_versions
     where tenant_id = ${testTenant} and id = ${task.agentVersionId}
  `
  await fixture.db.client`
    update agents set active_version_id = ${versionId}, updated_at = now()
     where tenant_id = ${testTenant} and id = ${task.agentId}
  `
  return envelope('workbench', {
    pinnedVersionId: task.agentVersionId,
    activeVersionId: versionId,
  }, 'postgres')
})

fixture.router.get('/api/workbench/v1/test/automations/:automationId/evidence', async (_request, context) => {
  const task = await fixture.automationService.getMine(ownerUserId, context.params['automationId'] ?? '')
  const executions = await fixture.automationService.listExecutions(ownerUserId, task.id)
  const [agent] = task.agentId
    ? await fixture.db.client<{ activeVersionId: string | null }[]>`
        select active_version_id as "activeVersionId" from agents
         where tenant_id = ${testTenant} and id = ${task.agentId}
      `
    : []
  return envelope('workbench', {
    pinnedVersionId: task.agentVersionId,
    activeVersionId: agent?.activeVersionId ?? null,
    executions,
  }, 'postgres')
})

console.log('P1 automation workbench ready; throwaway PostgreSQL, synthetic Runtime, no OIDC/DSH/model.')

let closing = false
async function close() {
  if (closing) return
  closing = true
  await fixture.close()
  process.exit(0)
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
