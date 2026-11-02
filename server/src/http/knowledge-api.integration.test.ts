import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { PostgresOperationsService } from '../modules/admin/application/postgres-operations-service.ts'
import { PostgresKnowledgeBaseService } from '../modules/knowledge/postgres-knowledge-base-service.ts'
import { PostgresKnowledgeConnection } from '../modules/knowledge/knowledge-connection.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { WeKnoraDouble } from '../testing/weknora-double.ts'
import { registerKnowledgeRoutes } from './workbench/knowledge-routes.ts'
import { Router } from './router.ts'

// KB-01～KB-06（e2e/catalog/knowledge.md，weknora-knowledge-plan WK-S2）：员工端知识库与文档管理、
// 可见部门调整、会话所选知识库与服务不可用。WeKnora 用按 v0.9.0 接口实现的测试 HTTP 服务。

const tenantId = 'tenant-dsh-work'
const base = '/api/workbench/v1'
const root = `dept-root-${tenantId}`
const users = { viewer: 'U-kb-viewer', docs: 'U-kb-docs', bases: 'U-kb-bases', nodept: 'U-kb-nodept', outsider: 'U-kb-outsider' }

let throwaway: ThrowawayDatabase
let database: DatabaseClient
let server: Server
let baseUrl = ''
const double = new WeKnoraDouble()
let doubleUrl = ''
let connectionId = ''

function identity(userId: string, audience: ApiAudience): RequestIdentity {
  return {
    audience, applicationId: 'knowledge-test', sessionHash: `session-${userId}`, userId, subject: userId,
    profile: { id: userId, name: userId, title: '员工', department: '', avatarText: '员', role: 'employee', dataScopes: [] },
    roleIds: [], permissions: ['workbench:use'], dataScopes: [], authorizationVersion: 1, identityProvider: 'local-password',
  }
}

async function api(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { Accept: 'application/json', 'x-test-user': user, ...headers } }
  if (body instanceof Buffer) init.body = new Uint8Array(body)
  else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let json: { data?: any; error?: { code: string; message: string } } | null = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, data: json?.data, error: json?.error, text }
}

async function ok(user: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const result = await api(user, method, path, body, headers)
  assert.ok(result.status === 200 || result.status === 201, `${method} ${path}: ${result.status} ${result.text}`)
  return result.data
}

async function addUser(id: string, roles: string[]) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${id}, ${tenantId}, ${`test:${id}`}, ${id}, 'active')
  `
  for (const role of roles) {
    await database`insert into user_roles (tenant_id, user_id, role_id) values (${tenantId}, ${id}, ${role})`
  }
}

async function member(userId: string, departmentId: string, primary = false) {
  await database`
    insert into org_department_members (tenant_id, department_id, user_id, is_primary)
    values (${tenantId}, ${departmentId}, ${userId}, ${primary})
  `
}

async function adminBase(id: string, name: string, owner: string, grantTo: string, includeDescendants: boolean, externalId = `ext-${id}`) {
  await database`
    insert into external_knowledge_bases (id, tenant_id, connection_id, external_id, name, owner_department_id, created_by)
    values (${id}, ${tenantId}, ${connectionId}, ${externalId}, ${name}, ${owner}, 'U00008')
  `
  await database`
    insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
    values (${`grant-${id}`}, ${tenantId}, ${id}, ${grantTo}, ${includeDescendants}, 'U00008', 'admin')
  `
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_knowledge_api_test', maxConnections: 4 })
  database = throwaway.client
  doubleUrl = await double.start()
  const connection = new PostgresKnowledgeConnection(database, { bootstrap: { baseUrl: doubleUrl, apiKey: double.apiKey, embeddingModelId: 'embed-1' } })
  await connection.ensureBootstrap()
  connectionId = connection.connectionId
  const service = new PostgresKnowledgeBaseService(database, new PostgresOperationsService(database), connection)
  const router = new Router({
    authenticateApi: (request: IncomingMessage, audience: ApiAudience) =>
      Promise.resolve(identity(String(request.headers['x-test-user']), audience)),
  })
  registerKnowledgeRoutes(router, service)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`

  await database`
    insert into roles (id, tenant_id, code, name, permissions) values
      ('role-kb-docs', ${tenantId}, 'kb_docs', '知识库文档管理', '["workbench:use","knowledge:docs"]'),
      ('role-kb-bases', ${tenantId}, 'kb_bases', '知识库管理', '["workbench:use","knowledge:bases"]')
  `
  await addUser(users.viewer, ['role-employee'])
  await addUser(users.docs, ['role-employee', 'role-kb-docs'])
  await addUser(users.bases, ['role-employee', 'role-kb-bases'])
  await addUser(users.nodept, ['role-employee', 'role-kb-bases'])
  await addUser(users.outsider, ['role-employee', 'role-kb-bases'])
  // 根 → 供应链部 → 计划组；根 → 采购组；根 → 财务部。
  await database`
    insert into org_departments (id, tenant_id, parent_id, name, path) values
      ('dept-supply', ${tenantId}, ${root}, '供应链部', ${`/${root}/dept-supply/`}),
      ('dept-plan', ${tenantId}, 'dept-supply', '计划组', ${`/${root}/dept-supply/dept-plan/`}),
      ('dept-proc', ${tenantId}, ${root}, '采购组', ${`/${root}/dept-proc/`}),
      ('dept-finance', ${tenantId}, ${root}, '财务部', ${`/${root}/dept-finance/`})
  `
  for (const user of [users.viewer, users.docs]) await member(user, 'dept-plan', true)
  await member(users.bases, 'dept-plan', true)
  await member(users.bases, 'dept-proc')
  await member(users.bases, root)
  await member(users.outsider, 'dept-finance', true)
  await adminBase('kb-supply', '供应链制度库', 'dept-supply', 'dept-supply', true)
  await adminBase('kb-supply-only', '供应链部内部库', 'dept-supply', 'dept-supply', false)
  await adminBase('kb-all', '全员制度汇编', 'dept-finance', root, true)
})

after(async () => {
  server?.close()
  await double.stop()
  await throwaway?.dispose()
})

beforeEach(() => {
  double.failWith = null
})

let planBase = ''

test('KB-02 新建知识库：归属部门默认授给本部门含下级，WeKnora 建库带统一嵌入模型', async () => {
  const created = await ok(users.bases, 'POST', `${base}/knowledge-bases`, { name: '计划组工作手册', description: '排产与补货', ownerDepartmentId: 'dept-plan' })
  planBase = created.id
  assert.equal(created.ownerDepartmentName, '计划组')
  assert.equal(created.canManageBase, true)
  assert.deepEqual(created.grants.map((grant: any) => [grant.departmentName, grant.includeDescendants, grant.grantedVia]), [['计划组', true, 'employee']])
  const [request] = [...double.knowledgeBases.values()]
  assert.equal(request?.embedding_model_id, 'embed-1')
  assert.equal(request?.type, 'document')

  assert.equal((await api(users.bases, 'POST', `${base}/knowledge-bases`, { name: '根部门库', ownerDepartmentId: root })).status, 422)
  assert.equal((await api(users.bases, 'POST', `${base}/knowledge-bases`, { name: '别人的库', ownerDepartmentId: 'dept-finance' })).status, 422)
  assert.equal((await api(users.docs, 'POST', `${base}/knowledge-bases`, { name: '无权新建', ownerDepartmentId: 'dept-plan' })).status, 403)
  assert.equal((await api(users.nodept, 'POST', `${base}/knowledge-bases`, { name: '没有部门', ownerDepartmentId: 'dept-plan' })).status, 422)
  assert.equal((await api(users.bases, 'POST', `${base}/knowledge-bases`, { name: '   ', ownerDepartmentId: 'dept-plan' })).status, 422)
})

test('KB-01 可见范围按部门与“包含下级”计算，没有部门时为空', async () => {
  const names = async (user: string) => (await ok(user, 'GET', `${base}/knowledge-bases`)).map((item: any) => item.name).sort()
  assert.deepEqual(await names(users.viewer), ['供应链制度库', '全员制度汇编', '计划组工作手册'].sort())
  assert.deepEqual(await names(users.outsider), ['全员制度汇编'])
  assert.deepEqual(await names(users.nodept), [])
  // 不可见与不存在同样回答，不泄露名称。
  const hidden = await api(users.outsider, 'GET', `${base}/knowledge-bases/kb-supply`)
  assert.equal(hidden.status, 404)
  assert.doesNotMatch(hidden.text, /供应链/)
  assert.equal((await api(users.outsider, 'GET', `${base}/knowledge-bases/${planBase}/documents`)).status, 404)
  const status = await ok(users.viewer, 'GET', `${base}/knowledge/status`)
  assert.deepEqual(status, { enabled: true, level: 'view' })
})

test('KB-01 操作权限：查看、文档管理与知识库管理只对归属本人所在部门的知识库生效', async () => {
  const file = Buffer.from('安全库存按七天用量计算。')
  const upload = (user: string, id: string, name: string) =>
    api(user, 'POST', `${base}/knowledge-bases/${id}/documents`, file, { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'text/plain' })
  assert.equal((await upload(users.viewer, planBase, 'a.txt')).status, 403)
  assert.equal((await upload(users.docs, 'kb-supply', 'a.txt')).status, 403, '可见但归属上级部门的知识库不能管理')
  assert.equal((await upload(users.docs, 'kb-all', 'a.txt')).status, 403, '管理员授给全员的知识库不能管理')
  const uploaded = await upload(users.docs, planBase, '安全库存口径.txt')
  assert.equal(uploaded.status, 201, uploaded.text)
  assert.equal(uploaded.data.status, 'parsing')
  assert.equal(uploaded.data.uploadedBy, users.docs)
  assert.equal((await upload(users.docs, planBase, '安全库存口径.txt')).status, 409)
  assert.equal((await api(users.docs, 'PATCH', `${base}/knowledge-bases/${planBase}`, { name: '改名' })).status, 403)
  assert.equal((await api(users.docs, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-proc' })).status, 403)
  assert.equal((await api(users.bases, 'PATCH', `${base}/knowledge-bases/kb-supply`, { name: '改名' })).status, 403)
})

test('KB-04 文档列表、修改、重新解析、删除、预览与下载；文档必须属于该知识库', async () => {
  const listed = await ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents`)
  const document = listed.items.find((item: any) => item.fileName === '安全库存口径.txt')
  assert.ok(document)
  assert.equal(document.uploadedBy, users.docs, '上传人取自平台审计')
  assert.equal((await ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents?status=parsing`)).items.length, 1)
  assert.equal((await ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents?status=completed`)).items.length, 0)

  // “解析中”包含 WeKnora 的 pending、processing、finalizing，“解析失败”包含 cancelled，与列表显示一致。
  const externalId = double.documents.find(item => item.fileName === '安全库存口径.txt')!.knowledgeBaseId
  double.documents.push(
    { id: 'doc-pending', knowledgeBaseId: externalId, title: '待解析', fileName: 'pending.txt', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', parseStatus: 'pending' },
    // 创建得早、更新得晚：顺序按创建时间（与 WeKnora 一致），不按更新时间。
    { id: 'doc-finalizing', knowledgeBaseId: externalId, title: '收尾中', fileName: 'finalizing.txt', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-11-02T09:00:00Z', parseStatus: 'finalizing' },
    { id: 'doc-cancelled', knowledgeBaseId: externalId, title: '已取消', fileName: 'cancelled.txt', updatedAt: '2026-11-02T00:00:00Z', parseStatus: 'cancelled' },
  )
  try {
    const documentsOf = (query: string) => ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents?${query}`)
    const parsing = await documentsOf('status=parsing')
    assert.equal(parsing.total, 3)
    assert.deepEqual(parsing.items.map((item: any) => item.fileName), ['安全库存口径.txt', 'pending.txt', 'finalizing.txt'])
    // 每个状态只有一篇：若直接把第 2 页透传给 WeKnora，第 2 页会是空的。
    assert.deepEqual((await documentsOf('status=parsing&page=2&pageSize=2')).items.map((item: any) => item.fileName), ['finalizing.txt'])
    assert.deepEqual((await documentsOf('status=failed')).items.map((item: any) => item.fileName), ['cancelled.txt'])
    // WeKnora 的 page_size 上限为 1000：合并窗口超出时明确拒绝，而不是返回残缺的页。
    assert.equal((await api(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents?status=parsing&page=21&pageSize=50`)).status, 422)
  } finally {
    double.documents = double.documents.filter(item => !['doc-pending', 'doc-finalizing', 'doc-cancelled'].includes(item.id))
  }

  await ok(users.docs, 'PATCH', `${base}/knowledge-bases/${planBase}/documents/${document.id}`, { title: '安全库存计算口径' })
  await ok(users.docs, 'POST', `${base}/knowledge-bases/${planBase}/documents/${document.id}/reparse`)
  const preview = await ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents/${document.id}/preview`)
  assert.equal(preview.text, 'preview:安全库存计算口径')
  const download = await api(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents/${document.id}/download`)
  assert.equal(download.status, 200)
  assert.equal(download.text, 'download:安全库存计算口径')

  // 文档属于其他知识库：同一员工可见的另一个知识库下访问它被拒绝。
  assert.equal((await api(users.viewer, 'GET', `${base}/knowledge-bases/kb-supply/documents/${document.id}/download`)).status, 404)
  assert.equal((await api(users.viewer, 'DELETE', `${base}/knowledge-bases/${planBase}/documents/${document.id}`)).status, 403)
  await ok(users.docs, 'DELETE', `${base}/knowledge-bases/${planBase}/documents/${document.id}`)
  assert.equal((await ok(users.viewer, 'GET', `${base}/knowledge-bases/${planBase}/documents`)).items.length, 0)

  const actions = await database<{ action: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and action like 'knowledge.document.%' order by occurred_at
  `
  assert.deepEqual(actions.map(row => row.action), [
    'knowledge.document.upload', 'knowledge.document.update', 'knowledge.document.reparse',
    'knowledge.document.download', 'knowledge.document.delete',
  ])
})

test('KB-03 可见部门：只能授给本人所属的非根部门，不能撤销管理员授权或撤到为空', async () => {
  const added = await ok(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-proc', includeDescendants: false })
  assert.deepEqual(added.grants.map((grant: any) => grant.departmentName), ['计划组', '采购组'])
  await ok(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-proc' })
  assert.equal((await ok(users.bases, 'GET', `${base}/knowledge-bases/${planBase}`)).grants.length, 2, '重复授予幂等')
  assert.equal((await api(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: root })).status, 403, '本人属于根部门也不能授给根部门')
  assert.equal((await api(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-finance' })).status, 403)
  // 采购组的成员（本人）因此可见；撤销后回到只有计划组。
  const procurement = added.grants.find((grant: any) => grant.departmentName === '采购组')
  const revoked = await ok(users.bases, 'DELETE', `${base}/knowledge-bases/${planBase}/grants/${procurement.id}`)
  assert.equal(revoked.grants.length, 1)
  assert.equal((await api(users.bases, 'DELETE', `${base}/knowledge-bases/${planBase}/grants/${revoked.grants[0].id}`)).status, 409)
  // 可选部门不含根部门，即使本人属于根部门。
  assert.deepEqual((await ok(users.bases, 'GET', `${base}/knowledge/departments`)).map((item: any) => item.name), ['计划组', '采购组'])
  // 并发撤销两条授权：只能成功一条，知识库仍保留一个可见部门。
  const twice = await ok(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-proc' })
  const results = await Promise.all(twice.grants.map((grant: any) => api(users.bases, 'DELETE', `${base}/knowledge-bases/${planBase}/grants/${grant.id}`)))
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.equal((await ok(users.bases, 'GET', `${base}/knowledge-bases/${planBase}`)).grants.length, 1)
  const remaining = (await ok(users.bases, 'GET', `${base}/knowledge-bases/${planBase}`)).grants[0]
  if (remaining.departmentName !== '计划组') {
    // 留下的是采购组时补回计划组，后续用例仍按计划组成员可见。
    await ok(users.bases, 'POST', `${base}/knowledge-bases/${planBase}/grants`, { departmentId: 'dept-plan' })
  }

  await database`
    insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
    values ('grant-admin-plan', ${tenantId}, ${planBase}, 'dept-finance', false, 'U00008', 'admin')
  `
  assert.equal((await api(users.bases, 'DELETE', `${base}/knowledge-bases/${planBase}/grants/grant-admin-plan`)).status, 403)
  assert.deepEqual((await ok(users.outsider, 'GET', `${base}/knowledge-bases`)).map((item: any) => item.name).sort(), ['全员制度汇编', '计划组工作手册'].sort())
})

test('KB-05 会话所选知识库：只能为本人个人空间的会话添加当前可见的知识库', async () => {
  const personal = { id: `ws-personal-${users.viewer}` }
  const [agentVersion] = await database<{ id: string }[]>`select id from agent_versions where tenant_id = ${tenantId} limit 1`
  const session = async (id: string, workspaceId: string, createdBy: string) => database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${id}, ${tenantId}, ${workspaceId}, ${createdBy}, ${agentVersion!.id}, '制度问答', 'active')
  `
  await session('session-kb-personal', personal.id, users.viewer)
  const path = `${base}/sessions/session-kb-personal/knowledge-bases`
  assert.deepEqual(await ok(users.viewer, 'GET', path), [])
  const selected = await ok(users.viewer, 'PUT', path, { knowledgeBaseIds: [planBase, 'kb-supply'] })
  assert.deepEqual(selected.map((item: any) => [item.name, item.available]), [['计划组工作手册', true], ['供应链制度库', true]])
  assert.equal((await api(users.viewer, 'PUT', path, { knowledgeBaseIds: [planBase, 'kb-supply-only'] })).status, 404, '不可见的知识库不能添加')
  assert.equal((await api(users.outsider, 'GET', path)).status, 404, '不能读取他人的会话')

  const [team] = await database<{ id: string }[]>`select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'team' limit 1`
  if (team) {
    await session('session-kb-team', team.id, users.viewer)
    assert.equal((await api(users.viewer, 'PUT', `${base}/sessions/session-kb-team/knowledge-bases`, { knowledgeBaseIds: [planBase] })).status, 422)
  }

  // KB-02 删除：知识库立即不在列表中，会话中标为不可用。
  await ok(users.bases, 'DELETE', `${base}/knowledge-bases/${planBase}`)
  assert.ok(!(await ok(users.viewer, 'GET', `${base}/knowledge-bases`)).some((item: any) => item.id === planBase))
  assert.deepEqual((await ok(users.viewer, 'GET', path)).map((item: any) => item.available), [false, true])
  const removed = await ok(users.viewer, 'PUT', path, { knowledgeBaseIds: ['kb-supply'] })
  assert.deepEqual(removed.map((item: any) => item.name), ['供应链制度库'])
})

test('KB-06 WeKnora 不可用时返回明确提示，不含密钥与正文', async () => {
  double.failWith = 503
  const result = await api(users.viewer, 'GET', `${base}/knowledge-bases`)
  assert.equal(result.status, 503)
  assert.match(result.error?.message ?? '', /知识库服务暂不可用/)
  assert.doesNotMatch(result.text, new RegExp(double.apiKey))
  // 对话中的选择器不读取 WeKnora 统计，WeKnora 不可用时仍可选择。
  const picker = await ok(users.viewer, 'GET', `${base}/knowledge-bases?stats=false`)
  assert.ok(picker.length > 0)
  // “用这个知识库提问”带入单个知识库同样不读取统计。
  assert.equal((await api(users.viewer, 'GET', `${base}/knowledge-bases/${picker[0].id}`)).status, 503)
  assert.equal((await ok(users.viewer, 'GET', `${base}/knowledge-bases/${picker[0].id}?stats=false`)).id, picker[0].id)

  // 连接被停用时与执行前检索同一口径：员工端不显示入口，接口回答不可用。
  double.failWith = null
  await database`update external_knowledge_connections set status = 'disabled' where tenant_id = ${tenantId}`
  try {
    assert.deepEqual(await ok(users.viewer, 'GET', `${base}/knowledge/status`), { enabled: false, level: 'view' })
    assert.equal((await api(users.viewer, 'GET', `${base}/knowledge-bases`)).status, 503)
  } finally {
    await database`update external_knowledge_connections set status = 'active' where tenant_id = ${tenantId}`
  }
})
