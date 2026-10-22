/**
 * P1 browser harness for main-flow hardening batches (B1–B5).
 * Disposable PostgreSQL + synthetic Runtime only.
 */
import { randomUUID } from 'node:crypto'

if (!process.env.DSH_WORK_TEST_DATABASE_URL && process.env.DSH_WORK_DATABASE_URL) {
  const maintenance = new URL(process.env.DSH_WORK_DATABASE_URL)
  maintenance.pathname = '/postgres'
  process.env.DSH_WORK_TEST_DATABASE_URL = maintenance.toString()
}

import { personalWorkbenchFixture, testTenant } from '../../server/src/infrastructure/postgres/personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from '../../server/src/infrastructure/postgres/personal-browser-runtime.ts'
import { envelope } from '../../server/src/http/router.ts'

const ownerUserId = 'U00001'
const memberUserId = 'U00002'
const viewerUserId = 'U00003'
const runtime = new PersonalBrowserRuntime()
const port = Number(process.env.DSH_WORK_HARDENING_SERVER_PORT ?? 4392)
const fixture = await personalWorkbenchFixture('dsh_main_flow_hardening_browser', {
  port,
  runtime,
  browser: true,
  teamCollaboration: true,
})

await fixture.db.client`
  insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
  values (${memberUserId}, ${testTenant}, ${`directory:${memberUserId}`}, '协作成员', null, 'active', 'ai-hub', true)
  on conflict do nothing
`
await fixture.db.client`
  insert into user_roles (tenant_id, user_id, role_id, source_key)
  values (${testTenant}, ${memberUserId}, 'role-employee', 'local')
  on conflict do nothing
`

const teamId = await fixture.team()
await fixture.db.client`
  insert into users (id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user)
  values (${viewerUserId}, ${testTenant}, ${`directory:${viewerUserId}`}, '只读访客', null, 'active', 'ai-hub', true)
  on conflict do nothing
`
await fixture.db.client`
  insert into user_roles (tenant_id, user_id, role_id, source_key)
  values (${testTenant}, ${viewerUserId}, 'role-employee', 'local')
  on conflict do nothing
`
await fixture.db.client`
  insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
  values (${testTenant}, ${teamId}, ${memberUserId}, 'member', ${ownerUserId})
  on conflict do nothing
`
await fixture.db.client`
  insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
  values (${testTenant}, ${teamId}, ${viewerUserId}, 'viewer', ${ownerUserId})
  on conflict do nothing
`

const discussionSession = await fixture.conversations.createSession({
  userId: ownerUserId,
  title: '发布排期讨论',
  workspaceId: teamId,
  agentVersionId: null,
  clientIntentId: `intent-${randomUUID()}`,
})
await fixture.conversations.activateSession(discussionSession.id)
await fixture.orchestration.postDiscussionMessage({
  userId: ownerUserId,
  sessionId: discussionSession.id,
  content: '确认发布时间',
  idempotencyKey: `msg-${randomUUID()}`,
})

const [agentRow] = await fixture.db.client<{ id: string; versionId: string }[]>`
  select id, active_version_id as "versionId" from agents
   where tenant_id = ${testTenant} and status = 'published' and active_version_id is not null
   order by created_at asc limit 1
`
let agentMemberId: string | null = null
if (agentRow) {
  agentMemberId = `wam-${randomUUID()}`
  await fixture.db.client`
    insert into workspace_agent_members (
      id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by
    ) values (
      ${agentMemberId}, ${testTenant}, ${teamId}, ${agentRow.id}, ${agentRow.versionId},
      'available', ${ownerUserId}
    )
  `
}

const fileBuffer = Buffer.from('team,file,1\n', 'utf8')
const uploadResponse = await fetch(`${fixture.origin}/workspaces/${teamId}/files`, {
  method: 'POST',
  headers: {
    'x-test-user-id': ownerUserId,
    Accept: 'application/json',
    'Content-Type': 'text/csv',
    'X-File-Name': encodeURIComponent('月报.csv'),
  },
  body: fileBuffer,
})
const uploadBody = await uploadResponse.json() as { data?: { logicalFileId?: string } }
const workspaceFileLogicalId = uploadBody.data?.logicalFileId ?? null

fixture.router.get('/api/workbench/v1/test/hardening/fixtures', () => envelope('workbench', {
  synthetic: true,
  ownerUserId,
  memberUserId,
  viewerUserId,
  teamId,
  discussionSessionId: discussionSession.id,
  discussionTitle: discussionSession.title,
  agentMemberId,
  workspaceFileLogicalId,
}))

console.log(`Main-flow hardening P1 ready on :${port}; team=${teamId}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await fixture.close()
  process.exit(0)
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
