import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { testAttemptManifest } from './test-attempt-manifest.ts'

let throwaway: ThrowawayDatabase

let database: DatabaseClient
let storageRoot = ''
let content: PostgresContentService
let authorization: PostgresAuthorizationService
let operations: PostgresOperationsService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据干扰断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m5_security_test', maxConnections: 5 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-m5-security-'))
  authorization = new PostgresAuthorizationService(database)
  content = new PostgresContentService(database, storageRoot, authorization)
  operations = new PostgresOperationsService(database, undefined, authorization)
})

after(async () => {
  await throwaway.dispose()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

test('cross-user and cross-workspace file reads fail closed', async () => {
  const uploaded = await content.storeWorkspaceFile(
    'ws-supply',
    'security-scope.txt',
    'text/plain',
    Buffer.from('仅供应链工作空间成员可读'),
    'U00001',
  )

  const outsiderWorkspaces = await content.listWorkspaces('U00008')
  assert.equal(outsiderWorkspaces.some(workspace => workspace.id === 'ws-supply'), false)
  await assert.rejects(content.readFile(uploaded.id, 'U00008'), /不存在或不可访问/)
  await assert.rejects(
    content.storeWorkspaceFile('ws-supply', 'blocked.txt', 'text/plain', Buffer.from('blocked'), 'U00008'),
    /工作空间不存在.*无权访问/,
  )
})

test('malicious content and database-injected traversal paths never reach storage outside the root', async () => {
  await assert.rejects(
    content.storeWorkspaceFile(
      'ws-supply',
      '../../disguised-malware.txt',
      'text/plain',
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
      'U00001',
    ),
    /可执行文件签名/,
  )
  const [malware] = await database<{ count: number }[]>`
    select count(*)::integer as count from file_objects
     where tenant_id = 'tenant-dsh-work' and original_name = '../../disguised-malware.txt'
  `
  assert.equal(malware?.count, 0)

  const fileId = `file-traversal-${randomUUID()}`
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${fileId}, 'tenant-dsh-work', 'ws-supply', '../../outside-security.txt',
      'outside-security.txt', 'text/plain', 8, ${'f'.repeat(64)}, 'clean', 'U00001'
    )
  `
  await assert.rejects(content.readFile(fileId, 'U00001'), /非法存储路径/)
})

test('authorization denies non-admin changes and records blocked decisions without granting access', async () => {
  await assert.rejects(authorization.requirePlatformAdmin('林岚'), /不是平台管理员/)
  await assert.rejects(
    authorization.authorizeRuntime({
      userId: 'U00008',
      workspaceId: 'ws-supply',
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
    /不是成员/,
  )

  const [audit] = await database<{ blocked: number }[]>`
    select count(*) filter (where result = 'blocked')::integer as blocked
      from audit_events where tenant_id = 'tenant-dsh-work' and object_type = 'authorization'
  `
  assert.ok((audit?.blocked ?? 0) >= 1)
})

test('audit and Tool metadata are redacted before persistence and on read', async () => {
  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  const session = await conversations.createSession({
    userId: 'U00001',
    title: '安全审计脱敏验证',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  const attempt = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    runtimeId: 'runtime-local-01',
    manifest: testAttemptManifest(run.taskId, run.id),
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: { providerKey: 'dsh-default', modelKey: 'dsh-default' },
  })

  try {
    await operations.appendAudit(
      'U00008',
      'security.redaction.test',
      'security-object',
      'success',
      'trace-security-redaction',
      'Authorization: Bearer bearer-value-123 password=pass-value-456',
    )
    await operations.recordToolAudit({
      runId: run.id,
      attemptId: attempt.id,
      traceId: 'trace-tool-redaction',
      metadata: {
        tool_name: 'read',
        inputTokens: 12,
        nested: { apiKey: 'key-value-789', access_token: 'access-value-012' },
      },
    })

    const [management] = await database<{ safeContext: Record<string, unknown> }[]>`
      select safe_context as "safeContext" from audit_events
       where tenant_id = 'tenant-dsh-work' and trace_id = 'trace-security-redaction'
    `
    const [tool] = await database<{ summary: Record<string, unknown> }[]>`
      select parameter_summary as summary from tool_audit_logs
       where tenant_id = 'tenant-dsh-work' and trace_id = 'trace-tool-redaction'
    `
    const serialized = JSON.stringify({ management, tool, events: (await operations.getAuditEvents()).items })
    assert.doesNotMatch(serialized, /bearer-value|pass-value|key-value|access-value/)
    assert.match(serialized, /\[REDACTED\]/)
    assert.equal(tool?.summary['inputTokens'], 12)
  } finally {
    await runs.transitionAttempt(run.tenantId, attempt.id, 'cancelled')
    await runs.transitionRun(run.tenantId, run.id, 'cancelled')
  }
})
