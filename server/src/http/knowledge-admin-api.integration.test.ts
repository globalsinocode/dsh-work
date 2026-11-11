import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { PostgresOperationsService } from '../modules/admin/application/postgres-operations-service.ts'
import { PostgresKnowledgeAdminService } from '../modules/knowledge/postgres-knowledge-admin-service.ts'
import { PostgresKnowledgeBaseService } from '../modules/knowledge/postgres-knowledge-base-service.ts'
import { PostgresKnowledgeConnection } from '../modules/knowledge/knowledge-connection.ts'
import { PostgresEncryptedCredentialStore } from '../modules/tool/postgres-encrypted-credential-store.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { WeKnoraDouble } from '../testing/weknora-double.ts'
import { registerKnowledgeAdminRoutes } from './admin/knowledge-admin-routes.ts'
import { registerKnowledgeRoutes } from './workbench/knowledge-routes.ts'
import { Router } from './router.ts'

// KB-ADM-01、KB-ADM-02（e2e/catalog/knowledge.md，weknora-knowledge-plan WK-S3）：管理端连接配置与加密凭据、
// 全部知识库与跨部门授权。WeKnora 用按 v0.9.0 接口实现的测试 HTTP 服务。

const tenantId = 'tenant-dsh-work'
const adminBase = '/api/admin/v1/knowledge'
const root = `dept-root-${tenantId}`
const ADMIN = 'U00008'
const READER = 'U-kb-admin-reader'
const EMPLOYEE = 'U-kb-admin-employee'

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: Server
let baseUrl = ''
let doubleUrl = ''
let connection: PostgresKnowledgeConnection
const double = new WeKnoraDouble()

function identity(userId: string, audience: ApiAudience): RequestIdentity {
  const permissions = audience === 'admin' ? (userId === ADMIN ? ['admin:*'] : ['admin:read']) : ['workbench:use']
  return {
    audience, applicationId: 'knowledge-admin-test', sessionHash: `session-${userId}`, userId, subject: userId,
    profile: { id: userId, name: userId, title: '管理员', department: '', avatarText: '管', role: 'platform_admin', dataScopes: [] },
    roleIds: [], permissions, dataScopes: [], authorizationVersion: 1, identityProvider: 'local-password',
  }
}

async function api(user: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Accept: 'application/json', 'x-test-user': user } }
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let json: { data?: any; error?: { message: string } } | null = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, data: json?.data, text }
}

async function ok(method: string, path: string, body?: unknown, user = ADMIN) {
  const result = await api(user, method, path, body)
  assert.equal(result.status, 200, `${method} ${path}: ${result.text}`)
  return result.data
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_knowledge_admin_test', maxConnections: 4 })
  database = throwaway.client
  doubleUrl = await double.start()
  const credentials = new PostgresEncryptedCredentialStore(database, { masterKeyBase64: randomBytes(32).toString('base64') })
  connection = new PostgresKnowledgeConnection(database, {
    credentials,
    bootstrap: { baseUrl: doubleUrl, apiKey: double.apiKey, embeddingModelId: 'embed-1' },
  })
  await connection.ensureBootstrap()
  const operations = new PostgresOperationsService(database)
  const router = new Router({
    authenticateApi: (request: IncomingMessage, audience: ApiAudience) =>
      Promise.resolve(identity(String(request.headers['x-test-user']), audience)),
  })
  registerKnowledgeAdminRoutes(router, new PostgresKnowledgeAdminService(database, operations, connection, credentials))
  registerKnowledgeRoutes(router, new PostgresKnowledgeBaseService(database, operations, connection))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`

  for (const [id, role] of [[READER, 'role-employee'], [EMPLOYEE, 'role-employee']] as const) {
    await database`insert into users (id, tenant_id, external_subject, display_name, status) values (${id}, ${tenantId}, ${`test:${id}`}, ${id}, 'active')`
    await database`insert into user_roles (tenant_id, user_id, role_id) values (${tenantId}, ${id}, ${role})`
  }
  await database`
    insert into org_departments (id, tenant_id, parent_id, name, path, status) values
      ('dept-supply', ${tenantId}, ${root}, '供应链部', ${`/${root}/dept-supply/`}, 'active'),
      ('dept-plan', ${tenantId}, 'dept-supply', '计划组', ${`/${root}/dept-supply/dept-plan/`}, 'active'),
      ('dept-finance', ${tenantId}, ${root}, '财务部', ${`/${root}/dept-finance/`}, 'active'),
      ('dept-quality', ${tenantId}, ${root}, '质量部', ${`/${root}/dept-quality/`}, 'removed')
  `
  await database`insert into org_department_members (tenant_id, department_id, user_id, is_primary) values (${tenantId}, 'dept-finance', ${EMPLOYEE}, true)`
})

after(async () => {
  server?.close()
  await double.stop()
  await throwaway?.dispose()
})

test('KB-ADM-01 连接配置：API Key 加密保存、只返回末四位，测试连接与停用立即生效', async () => {
  const initial = await ok('GET', adminBase)
  assert.equal(initial.connection.credentialSource, 'deployment')
  assert.equal(initial.connection.enabled, true)
  assert.equal(initial.connection.credentialReadable, true)

  // 管理员只改嵌入模型（Key 仍来自部署配置）：重启时部署配置不覆盖管理端的修改。
  await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, embeddingModelId: 'embed-x', enabled: true })
  await connection.ensureBootstrap()
  assert.equal((await ok('GET', adminBase)).connection.embeddingModelId, 'embed-x')

  // 已保存的 Key 只发往已保存的地址：测试或保存其他地址必须填写 Key。
  const other = new WeKnoraDouble()
  const otherUrl = await other.start()
  try {
    assert.deepEqual(await ok('POST', `${adminBase}/connection/test`, { baseUrl: otherUrl }), { ok: false, reason: 'api_key_required' })
    assert.equal((await api(ADMIN, 'PUT', `${adminBase}/connection`, { baseUrl: otherUrl, enabled: true })).status, 422)
    assert.equal(other.requests.length, 0, '其他地址没有收到任何请求')

    // Key 仍来自部署配置时，地址跟随部署配置（规范化后），部署配置的 Key 不会发往管理端留下的旧地址；管理端改过的嵌入模型保留。
    await new PostgresKnowledgeConnection(database, { bootstrap: { baseUrl: `${otherUrl}/`, apiKey: double.apiKey } }).ensureBootstrap()
    const moved = (await ok('GET', adminBase)).connection
    assert.equal(moved.baseUrl, otherUrl)
    assert.equal(moved.embeddingModelId, 'embed-x')
    await connection.ensureBootstrap()
    assert.equal((await ok('GET', adminBase)).connection.baseUrl, doubleUrl)
  } finally {
    await other.stop()
  }

  // 测试连接：填写的错误 Key 返回认证失败分类，已保存的配置可用。
  assert.deepEqual(await ok('POST', `${adminBase}/connection/test`, { apiKey: 'wrong-weknora-key-0000' }), { ok: false, reason: 'auth' })
  assert.equal((await api(ADMIN, 'POST', `${adminBase}/connection/test`, { apiKey: 'bad key' })).status, 422)
  // 已保存的连接测试成功后，之前的失败不再显示为“暂不可用”。
  await database`update external_knowledge_connections set last_success_at = now() - interval '1 hour', last_failure_at = now() - interval '1 minute', last_failure_reason = 'timeout'`
  assert.deepEqual(await ok('POST', `${adminBase}/connection/test`, {}), { ok: true, reason: null })
  const tested = (await ok('GET', adminBase)).connection
  assert.ok(tested.lastSuccessAt > tested.lastFailureAt)

  const saved = await ok('PUT', `${adminBase}/connection`, {
    baseUrl: `${doubleUrl}/api/v1/`, apiKey: double.apiKey, credentialExpiresAt: '2027-05-01T00:00:00Z', embeddingModelId: 'embed-2', enabled: true,
  })
  assert.equal(saved.connection.credentialSource, 'admin')
  assert.equal(saved.connection.credentialHint, double.apiKey.slice(-4))
  assert.equal(saved.connection.baseUrl, doubleUrl, '去掉末尾斜杠与 /api/v1')
  assert.equal(saved.connection.embeddingModelId, 'embed-2')
  assert.equal(saved.connection.lastFailureAt, null, '换了 Key 后清除旧的失败记录')
  const overviewText = (await api(ADMIN, 'GET', adminBase)).text
  assert.doesNotMatch(overviewText, new RegExp(double.apiKey), '读取接口不返回明文')
  const [secret] = await database<{ ciphertext: Uint8Array }[]>`select ciphertext from credential_secrets where tenant_id = ${tenantId}`
  assert.ok(secret && !Buffer.from(secret.ciphertext).toString('utf8').includes(double.apiKey), '数据库只存密文')

  // 不更换 Key 时保存其他字段，原 Key 继续可用。
  await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, embeddingModelId: 'embed-2', enabled: true })
  assert.ok(await connection.client(), '原 Key 保持不变')
  assert.equal((await ok('GET', adminBase)).connection.credentialExpiresAt, '2027-05-01T00:00:00.000Z')
  // 换新 Key 且未填写到期时间：不沿用旧 Key 的到期时间。
  const rotated = await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, apiKey: double.apiKey, embeddingModelId: 'embed-2', enabled: true })
  assert.equal(rotated.connection.credentialExpiresAt, null)
  assert.ok(await connection.client(), '新 Key 立即生效')
  assert.equal((await api(ADMIN, 'PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, apiKey: 'key with\nnewline', enabled: true })).status, 422)

  assert.equal((await api(ADMIN, 'PUT', `${adminBase}/connection`, { baseUrl: 'ftp://weknora', enabled: true })).status, 422)
  assert.equal((await api(ADMIN, 'PUT', `${adminBase}/connection`, { baseUrl: `${doubleUrl}/api/v1?x=1`, enabled: true })).status, 422, '地址不能带查询参数')
  assert.equal((await api(READER, 'PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, enabled: true })).status, 403)
  assert.equal((await api(READER, 'GET', adminBase)).status, 200)

  // 停用后员工端立即不可用，启用后恢复。
  await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, embeddingModelId: 'embed-2', enabled: false })
  assert.equal(await connection.client(), null)
  assert.equal((await ok('GET', '/api/workbench/v1/knowledge/status', undefined, EMPLOYEE)).enabled, false)
  await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, embeddingModelId: 'embed-2', enabled: true })
  assert.equal((await ok('GET', '/api/workbench/v1/knowledge/status', undefined, EMPLOYEE)).enabled, true)

  // 规则调整前保存的地址（带 /api/v1）：规范化后相同，不算更换地址，不要求重填 Key。
  await database`update external_knowledge_connections set base_url = ${`${doubleUrl}/api/v1`}`
  assert.deepEqual(await ok('POST', `${adminBase}/connection/test`, { baseUrl: doubleUrl }), { ok: true, reason: null })
  assert.equal((await ok('PUT', `${adminBase}/connection`, { baseUrl: doubleUrl, embeddingModelId: 'embed-2', enabled: true })).connection.baseUrl, doubleUrl)

  // 未配置凭据主密钥时不能保存 API Key。
  const withoutMasterKey = new PostgresKnowledgeAdminService(database, new PostgresOperationsService(database), connection)
  await assert.rejects(
    withoutMasterKey.updateConnection(ADMIN, { baseUrl: doubleUrl, apiKey: 'another-weknora-key-1', enabled: true }),
    (error: { status?: number }) => error.status === 409,
  )

  const [audit] = await database<{ count: number; leaked: number }[]>`
    select count(*)::int as count, count(*) filter (where safe_context::text like ${`%${double.apiKey}%`})::int as leaked
      from audit_events where tenant_id = ${tenantId} and action = 'knowledge.connection.update'
  `
  assert.equal(audit?.count, 7)
  assert.equal(audit?.leaked, 0, '审计不含 API Key')
})

test('KB-ADM-02 全部知识库：跨部门授权、归属部门、需重建与删除', async () => {
  const departments = await ok('GET', `${adminBase}/departments`)
  assert.deepEqual(departments.map((item: any) => item.label), ['全公司', '财务部', '供应链部', '供应链部 / 计划组'])

  let list = await ok('POST', `${adminBase}/bases`, { name: '全员安全制度', ownerDepartmentId: 'dept-supply' })
  const created = list.items.find((item: any) => item.name === '全员安全制度')
  assert.equal(created.embeddingModelId, 'embed-2')
  assert.equal(created.needsRebuild, false)
  assert.deepEqual(created.grants.map((grant: any) => [grant.departmentName, grant.includeDescendants, grant.grantedVia]), [['供应链部', true, 'admin']])
  assert.equal([...double.knowledgeBases.values()].at(-1)?.embedding_model_id, 'embed-2')
  assert.equal((await api(ADMIN, 'POST', `${adminBase}/bases`, { name: '根部门库', ownerDepartmentId: root })).status, 422)

  // 财务部员工此时看不到；管理员授给全公司后可见，撤销后又不可见。
  const visible = async () => (await ok('GET', '/api/workbench/v1/knowledge-bases?stats=false', undefined, EMPLOYEE)).map((item: any) => item.name)
  assert.deepEqual(await visible(), [])
  list = await ok('POST', `${adminBase}/bases/${created.id}/grants`, { departmentId: root })
  const rootGrant = list.items.find((item: any) => item.id === created.id).grants.find((grant: any) => grant.departmentName === '全公司')
  assert.ok(rootGrant)
  assert.deepEqual(await visible(), ['全员安全制度'])
  list = await ok('DELETE', `${adminBase}/bases/${created.id}/grants/${rootGrant.id}`)
  assert.deepEqual(await visible(), [])

  const auditOf = async (action: string) => (await database<{ text: string }[]>`
    select safe_context::text as text from audit_events where tenant_id = ${tenantId} and action = ${action} order by occurred_at desc limit 1
  `)[0]?.text ?? ''
  assert.match(await auditOf('knowledge.grant.revoke'), /对全公司的授权/, '审计写部门名称')

  // 再次授给已有授权的部门：按本次选择更新“含下级”。
  list = await ok('POST', `${adminBase}/bases/${created.id}/grants`, { departmentId: 'dept-supply', includeDescendants: false })
  assert.deepEqual(list.items.find((item: any) => item.id === created.id).grants.map((grant: any) => [grant.departmentName, grant.includeDescendants]), [['供应链部', false]])

  // 管理员可以撤到没有任何授权（包括员工或管理员授予的最后一条）。
  const ownerGrant = list.items.find((item: any) => item.id === created.id).grants[0]
  list = await ok('DELETE', `${adminBase}/bases/${created.id}/grants/${ownerGrant.id}`)
  assert.deepEqual(list.items.find((item: any) => item.id === created.id).grants, [])

  // 归属部门：只能是有效的非根部门。
  list = await ok('PATCH', `${adminBase}/bases/${created.id}`, { ownerDepartmentId: 'dept-plan' })
  assert.equal(list.items.find((item: any) => item.id === created.id).ownerDepartmentName, '计划组')
  assert.equal((await api(ADMIN, 'PATCH', `${adminBase}/bases/${created.id}`, { ownerDepartmentId: 'dept-quality' })).status, 422)

  // 归属部门已删除、嵌入模型与当前配置不同的知识库被标出。
  await database`
    insert into external_knowledge_bases (id, tenant_id, connection_id, external_id, name, owner_department_id, embedding_model_id, created_by)
    values ('kb-legacy', ${tenantId}, ${connection.connectionId}, 'ext-legacy', '旧版质量手册', 'dept-quality', 'embed-1', ${ADMIN})
  `
  const legacy = (await ok('GET', `${adminBase}/bases`)).items.find((item: any) => item.id === 'kb-legacy')
  assert.equal(legacy.ownerDepartmentActive, false)
  assert.equal(legacy.needsRebuild, true)
  assert.deepEqual(legacy.grants, [])

  assert.equal((await api(READER, 'POST', `${adminBase}/bases/${created.id}/grants`, { departmentId: root })).status, 403)
  list = await ok('DELETE', `${adminBase}/bases/${created.id}`)
  assert.ok(!list.items.some((item: any) => item.id === created.id))

  double.failWith = 503
  try {
    const unavailable = await ok('GET', `${adminBase}/bases`)
    assert.equal(unavailable.statsAvailable, false, 'WeKnora 不可用时仍可查看知识库与授权')
    assert.equal(unavailable.items[0].documentCount, null)
  } finally {
    double.failWith = null
  }
})

test('KB-ADM-05 配置提示：摘要模型标记、重排序结果，管理员再次授予的授权归管理员（优化方案 O5、O7、O12）', async () => {
  let list = await ok('POST', `${adminBase}/bases`, { name: '摘要检查库', ownerDepartmentId: 'dept-finance' })
  const created = list.items.find((item: any) => item.name === '摘要检查库')
  const externalId = [...double.knowledgeBases.keys()].at(-1)!
  assert.ok(!('summary_model_id' in (double.knowledgeBases.get(externalId) ?? {})), '平台建库不带摘要模型')
  assert.equal(created.summaryModelConfigured, false)
  assert.equal(created.status, 'active')
  double.summaryModels.set(externalId, 'chat-model-online')
  list = await ok('GET', `${adminBase}/bases`)
  assert.equal(list.items.find((item: any) => item.id === created.id).summaryModelConfigured, true)

  await database`update external_knowledge_connections set last_rerank_outcome = 'model_unavailable', last_rerank_at = now() where tenant_id = ${tenantId}`
  const overview = await ok('GET', adminBase)
  assert.equal(overview.connection.lastRerankOutcome, 'model_unavailable')
  assert.ok(overview.connection.lastRerankAt)
  // 不可用次数按失败审计统计（连接停用不写该审计，评审 #116）。
  await database`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id)
    values ('audit-kb-unavailable-1', ${tenantId}, 'user', ${EMPLOYEE}, 'knowledge.retrieve.unavailable', 'run', 'run-x', 'failed', 'trace-x')
  `
  const counted = await ok('GET', adminBase)
  assert.equal(counted.health.unavailable24h, overview.health.unavailable24h + 1)
  assert.equal(counted.health.retrievals24h, overview.health.retrievals24h + 1)

  // 员工授予的授权被管理员再次授予（含相同或不同的“含下级”）后归管理员，员工不能再撤销。
  await database`
    insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
    values ('grant-employee-plan', ${tenantId}, ${created.id}, 'dept-plan', true, ${EMPLOYEE}, 'employee')
  `
  list = await ok('POST', `${adminBase}/bases/${created.id}/grants`, { departmentId: 'dept-plan', includeDescendants: true })
  const plan = list.items.find((item: any) => item.id === created.id).grants.find((grant: any) => grant.departmentId === 'dept-plan')
  assert.equal(plan.grantedVia, 'admin')
  assert.equal(plan.id, 'grant-employee-plan', '更新原授权，不新增')
  await ok('DELETE', `${adminBase}/bases/${created.id}`)
})

test('KB-ADM-04 更换连接地址：原有知识库标为原连接已更换，确认新地址中存在后才能恢复（优化方案 O9）', async () => {
  let list = await ok('POST', `${adminBase}/bases`, { name: '迁移验证库', ownerDepartmentId: 'dept-finance' })
  const created = list.items.find((item: any) => item.name === '迁移验证库')
  const externalId = [...double.knowledgeBases.keys()].at(-1)!
  const visible = async () => (await ok('GET', '/api/workbench/v1/knowledge-bases?stats=false', undefined, EMPLOYEE)).map((item: any) => item.name)
  const statusOf = (items: any[], id: string) => items.find(item => item.id === id)?.status
  assert.deepEqual(await visible(), ['迁移验证库'])

  // 只改末尾斜杠或补上 /api/v1：规范化后相同，不算更换。
  await ok('PUT', `${adminBase}/connection`, { baseUrl: `${doubleUrl}/api/v1/`, embeddingModelId: 'embed-2', enabled: true })
  assert.equal(statusOf((await ok('GET', `${adminBase}/bases`)).items, created.id), 'active')

  // 新地址是另一个 WeKnora，其中只有“迁移验证库”（例如同一实例换了访问地址）。
  const other = new WeKnoraDouble(double.apiKey)
  const otherUrl = await other.start()
  try {
    other.knowledgeBases.set(externalId, { name: '迁移验证库' })
    await ok('PUT', `${adminBase}/connection`, { baseUrl: otherUrl, apiKey: double.apiKey, embeddingModelId: 'embed-2', enabled: true })
    list = await ok('GET', `${adminBase}/bases`)
    assert.equal(statusOf(list.items, created.id), 'unavailable')
    assert.equal(statusOf(list.items, 'kb-legacy'), 'unavailable')
    assert.deepEqual(await visible(), [], '员工端不显示原连接的知识库')
    const [audit] = await database<{ text: string }[]>`
      select safe_context::text as text from audit_events
       where tenant_id = ${tenantId} and action = 'knowledge.connection.update' order by occurred_at desc limit 1
    `
    assert.match(audit?.text ?? '', /标为原连接已更换/)

    assert.equal((await api(READER, 'POST', `${adminBase}/bases/${created.id}/restore`)).status, 403)
    list = await ok('POST', `${adminBase}/bases/${created.id}/restore`)
    assert.equal(statusOf(list.items, created.id), 'active')
    assert.deepEqual(await visible(), ['迁移验证库'])
    assert.equal((await api(ADMIN, 'POST', `${adminBase}/bases/kb-legacy/restore`)).status, 409, '新地址中没有的知识库不能恢复')
    assert.equal((await api(ADMIN, 'POST', `${adminBase}/bases/${created.id}/restore`)).status, 409, '有效的知识库不需要恢复')
  } finally {
    await other.stop()
  }

  // 部署配置提供连接、管理员从未保存过 Key 时，部署配置的地址变化同样标为原连接已更换。
  await database`update external_knowledge_connections set credential_ref = null, base_url = ${doubleUrl} where tenant_id = ${tenantId}`
  await database`update external_knowledge_bases set status = 'active' where tenant_id = ${tenantId} and status = 'unavailable'`
  const moved = new PostgresKnowledgeConnection(database, { bootstrap: { baseUrl: 'http://127.0.0.1:9', apiKey: double.apiKey } })
  await moved.ensureBootstrap()
  const [row] = await database<{ count: number }[]>`
    select count(*)::int as count from external_knowledge_bases where tenant_id = ${tenantId} and status = 'unavailable'
  `
  assert.ok((row?.count ?? 0) >= 2)
})
