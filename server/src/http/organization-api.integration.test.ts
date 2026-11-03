import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { loadIdentityConfiguration } from '../modules/identity/config.ts'
import { LocalAuthService } from '../modules/identity/local-auth-service.ts'
import { IdentitySessionRepository } from '../modules/identity/session-repository.ts'
import { IdentityAdministrationService } from '../modules/identity/administration-service.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { PostgresOrganizationService, type OrganizationSnapshot } from '../modules/organization/postgres-organization-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { registerOrganizationRoutes } from './admin/organization-routes.ts'
import { Router } from './router.ts'

// ORG-01～ORG-04（e2e/catalog/organization.md，企业组织架构方案 ORG-S1）：部门树维护与约束、
// 成员与主部门、新建账号选择部门、上线清空历史部门文本、AI Hub 登录与目录同步不覆盖部门。
// ORG-05～ORG-07（ORG-S2）：按部门授予角色、展开与重算、管理类角色限制、来源显示。

const tenantId = 'tenant-dsh-work'
const base = '/api/admin/v1/organization'
const password = 'Initial12345'

let database: ThrowawayDatabase
let auth: LocalAuthService
let server: Server
let baseUrl = ''
let adminId = ''

function identity(userId: string, audience: ApiAudience, permissions: string[]): RequestIdentity {
  return {
    audience, applicationId: 'organization-test', sessionHash: `session-${userId}`, userId, subject: userId,
    profile: { id: userId, name: userId, title: '管理员', department: '', avatarText: '管', role: 'platform_admin', dataScopes: [] },
    roleIds: [], permissions, dataScopes: [], authorizationVersion: 1, identityProvider: 'local-password',
  }
}

/** 默认以平台管理员（写权限）访问；x-test-readonly 模拟只有读取权限的管理员。 */
function authenticator(request: import('node:http').IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
  const readonly = request.headers['x-test-readonly'] === '1'
  return Promise.resolve(identity(adminId, audience, readonly ? ['admin:read'] : ['admin:*', 'admin:read', 'admin:write']))
}

async function listen(router: Router) {
  const created = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { created.once('error', reject); created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  assert.ok(address && typeof address !== 'string')
  return { server: created, url: `http://127.0.0.1:${address.port}` }
}

async function api(method: string, path: string, options: { body?: unknown; readonly?: boolean; url?: string } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.readonly) headers['x-test-readonly'] = '1'
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${options.url ?? baseUrl}${path}`, init)
  const body = await response.json().catch(() => null) as { data?: OrganizationSnapshot; error?: { code: string; message: string } }
  return { status: response.status, body }
}

async function ok(method: string, path: string, body?: unknown): Promise<OrganizationSnapshot> {
  const result = await api(method, path, body === undefined ? {} : { body })
  assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.body)}`)
  return result.body.data!
}

async function snapshot() { return ok('GET', base) }

function root(view: OrganizationSnapshot) {
  const found = view.departments.find(department => department.parentId === null)
  assert.ok(found, '应有根部门')
  return found
}

function departmentNamed(view: OrganizationSnapshot, name: string, parentId?: string) {
  const found = view.departments.find(department => department.name === name && (parentId === undefined || department.parentId === parentId))
  assert.ok(found, `应有部门 ${name}`)
  return found
}

async function createDepartment(parentId: string, name: string) {
  return departmentNamed(await ok('POST', `${base}/departments`, { parentId, name }), name, parentId)
}

async function createEmployee(name: string) {
  const suffix = Math.random().toString(16).slice(2, 10)
  return (await auth.createAccount({ username: `org.${suffix}@example.invalid`, password, name }, adminId)).userId
}

async function displayDepartment(userId: string) {
  const [row] = await database.client<{ department: string | null }[]>`
    select department_id as department from users where tenant_id = ${tenantId} and id = ${userId}
  `
  return row?.department ?? null
}

function membershipsOf(view: OrganizationSnapshot, userId: string) {
  return view.members.filter(member => member.userId === userId)
}

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_work_organization_test', maxConnections: 6 })
  const config = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'organization-integration-secret-32-characters',
    DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  })
  assert.equal(config.mode, 'local')
  auth = new LocalAuthService(config, database.client)
  adminId = (await auth.bootstrap({ username: 'org.admin@example.invalid', name: '组织管理员', password })).userId

  const router = new Router({ authenticateApi: authenticator })
  registerOrganizationRoutes(router, new PostgresOrganizationService(database.client))
  ;({ server, url: baseUrl } = await listen(router))
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await database.dispose()
})

test('ORG-03 迁移创建唯一根部门并清空历史部门文本；初始化管理员不写部门文本', async () => {
  const [tenant] = await database.client<{ name: string }[]>`select name from tenants where id = ${tenantId}`
  const roots = await database.client`select id from org_departments where tenant_id = ${tenantId} and parent_id is null`
  assert.equal(roots.length, 1)
  const view = await snapshot()
  assert.equal(root(view).name, tenant!.name)
  const auditBefore = await database.client`select 1 from audit_events where action like 'organization.%'`
  await snapshot()
  const auditAfter = await database.client`select 1 from audit_events where action like 'organization.%'`
  assert.equal(auditAfter.length, auditBefore.length, '读取组织架构不写入数据')

  const seeded = await database.client<{ count: number }[]>`
    select count(*)::integer as count from users where tenant_id = ${tenantId} and department_id is not null
  `
  assert.equal(seeded[0]!.count, 0, '上线迁移后不保留任何历史部门文本')
  assert.equal(await displayDepartment(adminId), null)
})

test('ORG-01 部门树：新建、重名、改名、排序、移动子树与删除约束', async () => {
  const rootId = root(await snapshot()).id
  const sales = await createDepartment(rootId, '销售部')
  const east = await createDepartment(sales.id, '华东销售部')
  const team = await createDepartment(east.id, '一组')
  const finance = await createDepartment(rootId, '财务部')

  const duplicate = await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '  销售部 ' } })
  assert.equal(duplicate.status, 409)
  await createDepartment(finance.id, '一组')
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '  ' } })).status, 422)
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '长'.repeat(61) } })).status, 422)
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: 'dept-missing', name: '无上级' } })).status, 404)

  let view = await ok('PATCH', `${base}/departments/${sales.id}`, { name: '销售中心' })
  assert.equal(departmentNamed(view, '销售中心').id, sales.id)

  view = await ok('POST', `${base}/departments/${finance.id}/reorder`, { direction: 'up' })
  const order = view.departments.filter(department => department.parentId === rootId).sort((a, b) => a.sortOrder - b.sortOrder).map(department => department.name)
  assert.deepEqual(order.slice(0, 2), ['财务部', '销售中心'])
  assert.equal((await api('POST', `${base}/departments/${finance.id}/reorder`, { body: { direction: 'sideways' } })).status, 422)

  view = await ok('PATCH', `${base}/departments/${east.id}`, { parentId: finance.id })
  assert.equal(view.departments.find(department => department.id === east.id)!.parentId, finance.id)
  assert.equal(view.departments.find(department => department.id === team.id)!.parentId, east.id, '下级部门随之移动')
  const [paths] = await database.client<{ path: string }[]>`select path from org_departments where id = ${team.id}`
  assert.equal(paths!.path, `/${rootId}/${finance.id}/${east.id}/${team.id}/`)

  assert.equal((await api('PATCH', `${base}/departments/${finance.id}`, { body: { parentId: team.id } })).status, 409, '不能移到自己的下级之下')
  assert.equal((await api('PATCH', `${base}/departments/${finance.id}`, { body: { parentId: finance.id } })).status, 409)
  assert.equal((await api('PATCH', `${base}/departments/${rootId}`, { body: { parentId: finance.id } })).status, 409, '根部门不能移动')
  assert.equal((await api('DELETE', `${base}/departments/${rootId}`)).status, 409, '根部门不能删除')
  await ok('PATCH', `${base}/departments/${rootId}`, { name: '示例企业（改名）' })

  const renamedMove = await createDepartment(rootId, '财务部（待合并）')
  await createDepartment(finance.id, '财务部（待合并）')
  view = await ok('PATCH', `${base}/departments/${renamedMove.id}`, { parentId: finance.id, name: '资金组' })
  const moved = view.departments.find(department => department.id === renamedMove.id)!
  assert.deepEqual([moved.parentId, moved.name], [finance.id, '资金组'], '同时移动和改名时按新名称检查重名')
  assert.equal((await api('PATCH', `${base}/departments/${renamedMove.id}`, { body: { parentId: rootId, name: '销售中心' } })).status, 409)

  const blocked = await api('DELETE', `${base}/departments/${east.id}`)
  assert.equal(blocked.status, 409)
  assert.match(blocked.body.error!.message, /下级部门/)
  const member = await createEmployee('删除拦截员工')
  await ok('POST', `${base}/departments/${team.id}/members`, { userIds: [member] })
  const withMember = await api('DELETE', `${base}/departments/${team.id}`)
  assert.equal(withMember.status, 409)
  assert.match(withMember.body.error!.message, /成员/)
  await api('DELETE', `${base}/departments/${team.id}/members/${member}`)
  view = await ok('DELETE', `${base}/departments/${team.id}`)
  assert.equal(view.departments.some(department => department.id === team.id), false)
  await createDepartment(east.id, '一组')

  const audits = await database.client<{ action: string }[]>`
    select action from audit_events where actor_id = ${adminId} and action like 'organization.department.%'
  `
  for (const action of ['create', 'update', 'reorder', 'remove']) {
    assert.ok(audits.some(row => row.action === `organization.department.${action}`), `应有 ${action} 审计`)
  }
})

test('ORG-01 只读管理员可以读取但不能写入；并发移动不会形成环', async () => {
  const rootId = root(await snapshot()).id
  assert.equal((await api('GET', base, { readonly: true })).status, 200)
  assert.equal((await api('POST', `${base}/departments`, { readonly: true, body: { parentId: rootId, name: '只读新建' } })).status, 403)

  const left = await createDepartment(rootId, '并发甲')
  const right = await createDepartment(rootId, '并发乙')
  const results = await Promise.all([
    api('PATCH', `${base}/departments/${left.id}`, { body: { parentId: right.id } }),
    api('PATCH', `${base}/departments/${right.id}`, { body: { parentId: left.id } }),
  ])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  const rows = await database.client<{ id: string; path: string }[]>`
    select id, path from org_departments where id in ${database.client([left.id, right.id])}
  `
  for (const row of rows) {
    assert.equal(row.path.split('/').filter(Boolean).filter(id => id === row.id).length, 1, '路径中不出现自己两次')
    assert.ok(row.path.startsWith(`/${rootId}/`), '仍挂在根部门之下')
  }
})

test('ORG-02 成员：多选加入、主部门、显示部门与移出主部门', async () => {
  const rootId = root(await snapshot()).id
  const supply = await createDepartment(rootId, '供应链中心')
  const buy = await createDepartment(supply.id, '采购部')
  const alice = await createEmployee('甲员工')
  const bob = await createEmployee('乙员工')
  const disabled = await createEmployee('停用员工')
  await auth.setStatus(disabled, 'disabled', adminId)

  let view = await ok('POST', `${base}/departments/${supply.id}/members`, { userIds: [alice, bob, alice] })
  assert.deepEqual(membershipsOf(view, alice), [{ departmentId: supply.id, userId: alice, primary: true }])
  assert.equal(await displayDepartment(alice), '供应链中心')
  assert.ok(view.employees.some(employee => employee.id === alice && employee.status === 'active'))
  await ok('POST', `${base}/departments/${supply.id}/members`, { userIds: [alice] })

  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: [disabled] } })).status, 422)
  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: ['U-missing'] } })).status, 422)
  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: [] } })).status, 422)

  view = await ok('POST', `${base}/departments/${buy.id}/members`, { userIds: [alice] })
  assert.deepEqual(membershipsOf(view, alice).filter(member => member.primary).map(member => member.departmentId), [supply.id], '已有主部门的员工保持原主部门')

  view = await ok('PUT', `${base}/departments/${buy.id}/members/${alice}/primary`)
  assert.deepEqual(membershipsOf(view, alice).filter(member => member.primary).map(member => member.departmentId), [buy.id])
  assert.equal(await displayDepartment(alice), '采购部')
  await ok('PATCH', `${base}/departments/${buy.id}`, { name: '采购管理部' })
  assert.equal(await displayDepartment(alice), '采购管理部', '主部门改名后显示部门同步更新')

  const missingPrimary = await api('DELETE', `${base}/departments/${buy.id}/members/${alice}`)
  assert.equal(missingPrimary.status, 422)
  const wrongPrimary = await api('DELETE', `${base}/departments/${buy.id}/members/${alice}?new_primary_department_id=${rootId}`)
  assert.equal(wrongPrimary.status, 422)
  view = await ok('DELETE', `${base}/departments/${buy.id}/members/${alice}?new_primary_department_id=${supply.id}`)
  assert.deepEqual(membershipsOf(view, alice), [{ departmentId: supply.id, userId: alice, primary: true }])
  assert.equal(await displayDepartment(alice), '供应链中心')

  view = await ok('DELETE', `${base}/departments/${supply.id}/members/${bob}`)
  assert.deepEqual(membershipsOf(view, bob), [])
  assert.equal(await displayDepartment(bob), null, '移出唯一部门后变为未分配')
  assert.equal((await api('DELETE', `${base}/departments/${supply.id}/members/${bob}`)).status, 404)
  assert.equal((await api('PUT', `${base}/departments/${buy.id}/members/${bob}/primary`)).status, 404)

  const [primaries] = await database.client<{ count: number }[]>`
    select count(*)::integer as count from (
      select user_id from org_department_members where tenant_id = ${tenantId} and is_primary group by user_id having count(*) > 1
    ) duplicated
  `
  assert.equal(primaries!.count, 0, '每名员工至多一个主部门')
})

test('ORG-03 新建账号从部门树选择部门；不接受自由填写的部门文字', async () => {
  const rootId = root(await snapshot()).id
  const hr = await createDepartment(rootId, '人力资源部')
  const created = await auth.createAccount({ username: 'org.new.hire@example.invalid', password, name: '新入职员工', departmentId: hr.id }, adminId)
  const view = await snapshot()
  assert.deepEqual(membershipsOf(view, created.userId), [{ departmentId: hr.id, userId: created.userId, primary: true }])
  assert.equal(await displayDepartment(created.userId), '人力资源部')

  const legacy = await auth.createAccount({ username: 'org.legacy@example.invalid', password, name: '旧字段员工', department: '自填部门' } as never, adminId)
  assert.equal(await displayDepartment(legacy.userId), null, '自由填写的部门文字被忽略')

  await assert.rejects(
    auth.createAccount({ username: 'org.bad.dept@example.invalid', password, name: '错误部门员工', departmentId: 'dept-missing' }, adminId),
    (error: { code?: string }) => error.code === 'resource_not_found',
  )
  const [orphan] = await database.client`
    select 1 from local_user_credentials where tenant_id = ${tenantId} and username = 'org.bad.dept@example.invalid'
  `
  assert.equal(orphan, undefined, '部门无效时不创建账号')
})

test('ORG-04 AI Hub 账号登录与目录同步不覆盖组织架构维护的部门', async () => {
  const rootId = root(await snapshot()).id
  const department = await createDepartment(rootId, 'AI Hub 员工所在部门')
  const identities = new IdentitySessionRepository(database.client)
  const external = {
    externalUserId: 'org-aihub-user', subject: 'org-aihub-subject', displayName: 'AI Hub 员工',
    email: 'org.aihub@example.invalid', businessUser: true, status: 'ACTIVE',
  }
  const { userId } = await identities.synchronizeIdentity(external)
  assert.equal(await displayDepartment(userId), null, '首次同步不写入 AI Hub 的组织名')
  await ok('POST', `${base}/departments/${department.id}/members`, { userIds: [userId] })
  assert.equal(await displayDepartment(userId), 'AI Hub 员工所在部门')

  await identities.synchronizeIdentity({ ...external, displayName: 'AI Hub 员工（改名）' })
  assert.equal(await displayDepartment(userId), 'AI Hub 员工所在部门', '再次同步不覆盖组织架构维护的部门')
  const view = await snapshot()
  assert.deepEqual(membershipsOf(view, userId), [{ departmentId: department.id, userId, primary: true }])

  // 迁移 0116：以前同步写进来的旧组织名统一为主部门名称，没有主部门的清空。
  const stale = await identities.synchronizeIdentity({ ...external, externalUserId: 'org-aihub-stale', subject: 'org-aihub-stale', displayName: '旧同步员工' })
  await database.client`update users set department_id = 'AI Hub 平台团队' where tenant_id = ${tenantId} and id in ${database.client([stale.userId, userId])}`
  const migration = await readFile(new URL('../../migrations/0116_org_department_display_resync.sql', import.meta.url), 'utf8')
  await database.client.unsafe(migration)
  assert.equal(await displayDepartment(stale.userId), null, '没有主部门的 AI Hub 老账号清空旧组织名')
  assert.equal(await displayDepartment(userId), 'AI Hub 员工所在部门', '有主部门的显示主部门名称')
  await database.client.unsafe(migration)
  assert.equal(await displayDepartment(userId), 'AI Hub 员工所在部门', '迁移可重复执行')
})

async function departmentRoleRows(userId: string) {
  const rows = await database.client<{ roleId: string; sourceKey: string }[]>`
    select role_id as "roleId", source_key as "sourceKey" from user_roles
     where tenant_id = ${tenantId} and user_id = ${userId} order by role_id, source_key
  `
  return rows.map(row => ({ roleId: row.roleId, sourceKey: row.sourceKey }))
}

async function authorizationVersion(userId: string) {
  const [row] = await database.client<{ version: number }[]>`
    select local_authorization_version::integer as version from users where tenant_id = ${tenantId} and id = ${userId}
  `
  return row!.version
}

async function canUseWorkbench(userId: string) {
  return new PostgresAuthorizationService(database.client).authorizeWorkbench({ userId }).then(() => true, () => false)
}

test('ORG-05 部门授予角色：覆盖下级、随成员与部门变化重算、删除部门后授权失效', async () => {
  const rootId = root(await snapshot()).id
  const sales = await createDepartment(rootId, '授权销售部')
  const east = await createDepartment(sales.id, '授权华东')
  const other = await createDepartment(rootId, '授权其他部门')
  const direct = await createEmployee('直属员工')
  const child = await createEmployee('下级员工')
  await ok('POST', `${base}/departments/${sales.id}/members`, { userIds: [direct] })
  await ok('POST', `${base}/departments/${east.id}/members`, { userIds: [child] })
  assert.equal(await canUseWorkbench(direct), false, '新账号没有角色时不能使用员工端')

  const versionBefore = await authorizationVersion(child)
  let view = await ok('POST', `${base}/departments/${sales.id}/grants`, { roleId: 'role-employee' })
  const grant = view.grants.find(item => item.departmentId === sales.id && item.roleId === 'role-employee')!
  assert.equal(grant.includeDescendants, true, '默认包含下级部门')
  for (const userId of [direct, child]) {
    assert.deepEqual(await departmentRoleRows(userId), [{ roleId: 'role-employee', sourceKey: `department:${grant.id}` }])
    assert.equal(await canUseWorkbench(userId), true, '部门授予的角色在授权判定中生效')
    assert.ok(view.roleAssignments.some(item => item.userId === userId && typeof item.source === 'object' && item.source.grantId === grant.id))
  }
  assert.ok(await authorizationVersion(child) > versionBefore, '权限变化时授权版本递增')

  await ok('PATCH', `${base}/departments/${east.id}`, { parentId: other.id })
  assert.deepEqual(await departmentRoleRows(child), [], '部门移出授权范围后收回角色')
  assert.equal(await canUseWorkbench(child), false)
  await ok('PATCH', `${base}/departments/${east.id}`, { parentId: sales.id })
  assert.equal(await canUseWorkbench(child), true)

  await ok('DELETE', `${base}/grants/${grant.id}`)
  view = await ok('POST', `${base}/departments/${sales.id}/grants`, { roleId: 'role-employee', includeDescendants: false })
  const directOnly = view.grants.find(item => item.departmentId === sales.id && item.status === 'active')!
  assert.equal(directOnly.includeDescendants, false)
  assert.equal(await canUseWorkbench(direct), true)
  assert.equal(await canUseWorkbench(child), false, '不含下级时下级部门成员不获得角色')

  await ok('DELETE', `${base}/departments/${sales.id}/members/${direct}`)
  assert.equal(await canUseWorkbench(direct), false, '移出部门后收回来自部门的角色')
  await ok('DELETE', `${base}/departments/${east.id}/members/${child}`)
  await ok('DELETE', `${base}/departments/${east.id}`)
  view = await ok('DELETE', `${base}/departments/${sales.id}`)
  const invalid = view.grants.find(item => item.id === directOnly.id)!
  assert.deepEqual([invalid.status, invalid.departmentName], ['invalid', '授权销售部'], '删除部门后授权失效并保留原部门名称')
  view = await ok('DELETE', `${base}/grants/${directOnly.id}`)
  assert.equal(view.grants.some(item => item.id === directOnly.id), false, '失效授权可以清除')
})

test('ORG-06 管理类角色不能授给部门；已授给部门的角色不能加入管理权限', async () => {
  const rootId = root(await snapshot()).id
  const team = await createDepartment(rootId, '限制测试部')
  const forbidden = await api('POST', `${base}/departments/${team.id}/grants`, { body: { roleId: 'role-platform-admin' } })
  assert.equal(forbidden.status, 409)
  assert.match(forbidden.body.error!.message, /管理类权限/)
  const view = await snapshot()
  assert.equal(view.roles.find(role => role.id === 'role-platform-admin')!.assignable, false)
  assert.equal(view.roles.find(role => role.id === 'role-employee')!.assignable, true)

  const administration = new IdentityAdministrationService(database.client, true)
  const role = await administration.createRole({ code: 'org_grant_probe', name: '部门授权探针', permissions: ['workbench:use'], actorId: adminId })
  const roleId = (role as { id: string }).id
  await ok('POST', `${base}/departments/${team.id}/grants`, { roleId })
  assert.equal((await api('POST', `${base}/departments/${team.id}/grants`, { body: { roleId } })).status, 409, '同一部门不能重复授予同一角色')
  await assert.rejects(
    administration.updateRole({ roleId, name: '部门授权探针', status: 'active', permissions: ['workbench:use', 'admin:write'], dataScopes: [], actorId: adminId }),
    (error: { message?: string }) => /已授给部门/.test(error.message ?? ''),
  )
  await administration.updateRole({ roleId, name: '部门授权探针', status: 'disabled', permissions: ['workbench:use'], dataScopes: [], actorId: adminId })
  const disabled = await createDepartment(rootId, '停用角色测试部')
  assert.equal((await api('POST', `${base}/departments/${disabled.id}/grants`, { body: { roleId } })).status, 409, '停用的角色不能授给部门')
  assert.equal((await api('POST', `${base}/departments/${team.id}/grants`, { body: { roleId: 'role-missing' } })).status, 404)
  assert.equal((await api('POST', `${base}/departments/${team.id}/grants`, { readonly: true, body: { roleId: 'role-employee' } })).status, 403)

  // 并发：同时“给角色加管理权限”和“把角色授给部门”，最多一个成功，不能出现授给部门的管理类角色。
  for (let round = 0; round < 5; round += 1) {
    const race = await administration.createRole({ code: `org_grant_race_${round}`, name: `并发探针${round}`, permissions: ['workbench:use'], actorId: adminId })
    const raceRoleId = (race as { id: string }).id
    const raceDepartment = await createDepartment(rootId, `并发授权部${round}`)
    await Promise.allSettled([
      administration.updateRole({ roleId: raceRoleId, name: `并发探针${round}`, status: 'active', permissions: ['workbench:use', 'admin:write'], dataScopes: [], actorId: adminId }),
      api('POST', `${base}/departments/${raceDepartment.id}/grants`, { body: { roleId: raceRoleId } }),
    ])
    const [violation] = await database.client`
      select 1 from org_department_grants g join roles r on r.tenant_id = g.tenant_id and r.id = g.role_id
       where g.status = 'active' and g.role_id = ${raceRoleId} and r.permissions ? 'admin:write'
    `
    assert.equal(violation, undefined, '并发下也不会出现授给部门的管理类角色')
  }
})

test('ORG-07 员工列表区分直接授予与来自部门的角色；撤销直接授予不影响部门来源', async () => {
  const rootId = root(await snapshot()).id
  const ops = await createDepartment(rootId, '来源测试部')
  const employee = await createEmployee('来源测试员工')
  await ok('POST', `${base}/departments/${ops.id}/members`, { userIds: [employee] })
  await ok('POST', `${base}/departments/${ops.id}/grants`, { roleId: 'role-employee' })
  const administration = new IdentityAdministrationService(database.client, true)
  await administration.grantRole({ userId: employee, roleId: 'role-employee', actorId: adminId })

  const page = await administration.listUsers({ query: '来源测试员工' })
  const summary = (page as { items: Array<{ id: string; roles: Array<{ id: string }>; departmentRoles: Array<{ id: string; departmentName: string }> }> }).items.find(item => item.id === employee)!
  assert.deepEqual(summary.roles.map(role => role.id), ['role-employee'])
  assert.deepEqual(summary.departmentRoles.map(role => [role.id, role.departmentName]), [['role-employee', '来源测试部']])

  await administration.revokeRole({ userId: employee, roleId: 'role-employee', actorId: adminId })
  assert.deepEqual((await departmentRoleRows(employee)).map(row => row.sourceKey.startsWith('department:')), [true], '撤销直接授予只删除直接来源')
  assert.equal(await canUseWorkbench(employee), true, '仍通过部门获得员工角色')
})

