import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { IdentityAdministrationService } from '../../modules/identity/administration-service.ts'
import { assertAgentCapabilityWithinActor, PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { loadLocalAdminPermissions } from '../../modules/authorization/admin-actor.ts'
import { listGrantCeilingExceptions } from '../../modules/authorization/grant-ceiling-report.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresOrganizationService, type OrganizationSnapshot } from '../../modules/organization/postgres-organization-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

// 管理端模块权限方案（docs/design/admin-module-permission-plan.md）AMP-S1 的 P1 证据：
// 服务层按模块复核、只认本地授予；授出不超过自身（组织架构与 Agent 岗位权限）；管理 Run 用途按模块判定。

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const SCOPE = 'enterprise:authorized'
const OTHER_SCOPE = 'workspace:authorized'
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let authorization: PostgresAuthorizationService
let organization: PostgresOrganizationService

const ids = {
  platformAdmin: '', orgAdmin: '', agentAdmin: '', knowledgeAdmin: '', employee: '',
}
const roles = {
  orgAdmin: `role-amp-org-${randomUUID().slice(0, 8)}`,
  agentAdmin: `role-amp-agent-${randomUUID().slice(0, 8)}`,
  knowledgeAdmin: `role-amp-knowledge-${randomUUID().slice(0, 8)}`,
  sales: `role-amp-sales-${randomUUID().slice(0, 8)}`,
  basic: `role-amp-basic-${randomUUID().slice(0, 8)}`,
  modelReader: `role-amp-model-${randomUUID().slice(0, 8)}`,
}

async function createUser(name: string, roleIds: string[]) {
  const id = `user-amp-${randomUUID()}`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${id}, ${tenantId}, ${`directory:${id}`}, ${name}, 'active', 'ai-hub', true)
  `
  for (const roleId of roleIds) {
    await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${id}, ${roleId}, 'local')`
  }
  return id
}

async function createRole(id: string, permissions: string[], scopes: string[] = []) {
  await database`
    insert into roles (id, tenant_id, code, name, permissions)
    values (${id}, ${tenantId}, ${id.replaceAll('-', '_')}, ${id}, ${database.json(permissions)})
  `
  for (const scope of scopes) {
    await database`
      insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
      values (${`grant-${randomUUID()}`}, ${tenantId}, 'role', ${id}, 'capability', ${scope})
    `
  }
}

function rootOf(view: OrganizationSnapshot) {
  return view.departments.find(department => department.parentId === null)!.id
}

async function createDepartment(actor: string, name: string, parentId?: string) {
  const parent = parentId ?? rootOf(await organization.snapshot())
  const view = await organization.createDepartment({ parentId: parent, name, actorId: actor })
  return view.departments.find(department => department.name === name && department.parentId === parent)!.id
}

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_admin_module_permissions_test', maxConnections: 4 })
  database = throwaway.client
  authorization = new PostgresAuthorizationService(database)
  organization = new PostgresOrganizationService(database)
  await createRole(roles.orgAdmin, ['admin:org:write', 'workbench:use'], [SCOPE])
  await createRole(roles.agentAdmin, ['admin:agent:write', 'workbench:use'], [SCOPE])
  await createRole(roles.knowledgeAdmin, ['admin:knowledge:write', 'workbench:use'])
  await createRole(roles.sales, ['workbench:use', 'knowledge:docs'])
  await createRole(roles.basic, ['workbench:use'])
  await createRole(roles.modelReader, ['admin:model:read'])
  ids.platformAdmin = await createUser('平台管理员', ['role-platform-admin', 'role-employee'])
  ids.orgAdmin = await createUser('组织管理员', [roles.orgAdmin])
  ids.agentAdmin = await createUser('Agent 管理员', [roles.agentAdmin])
  ids.knowledgeAdmin = await createUser('知识库管理员', [roles.knowledgeAdmin])
  ids.employee = await createUser('普通员工', [roles.basic])
})

after(async () => {
  await throwaway?.dispose()
})

test('服务层按模块复核：模块管理员只能写自己的模块，普通员工没有管理权限', async () => {
  await authorization.requireAdminModule(ids.orgAdmin, 'org', 'write')
  await authorization.requireAdminModule(ids.orgAdmin, 'org', 'read')
  await assert.rejects(authorization.requireAdminModule(ids.orgAdmin, 'agent', 'write'), { code: 'permission_denied' })
  await assert.rejects(authorization.requireAdminModule(ids.knowledgeAdmin, 'org', 'read'), /没有组织架构的查看权限/)
  await authorization.requireAdminModule(ids.platformAdmin, 'knowledge', 'write')
  await authorization.requireAdminAccess(ids.knowledgeAdmin)
  await assert.rejects(authorization.requireAdminAccess(ids.employee), { code: 'permission_denied' })
})

test('管理 Run 用途按模块判定：管理助手任一模块管理员可用，专用 Run 需要所属模块的修改权限', async () => {
  await authorization.requireAdminRunPurpose(ids.knowledgeAdmin, 'admin-assistant')
  await assert.rejects(authorization.requireAdminRunPurpose(ids.knowledgeAdmin, 'admin-skill-install'), /没有Skill的修改权限/)
  await assert.rejects(authorization.requireAdminRunPurpose(ids.knowledgeAdmin, 'admin-agent-manage'), /没有Agent的修改权限/)
  await authorization.requireAdminRunPurpose(ids.agentAdmin, 'admin-agent-manage')
  await authorization.requireAdminRunPurpose(ids.agentAdmin, 'agent-release-trial')
  await assert.rejects(authorization.requireAdminRunPurpose(ids.agentAdmin, 'admin-unknown'), /未登记权限归属/)
})

test('组织架构：授出不超过自身、不能变更自己的部门归属，部门移动与成员变更同样受约束', async () => {
  const d1 = await createDepartment(ids.orgAdmin, `销售一部-${randomUUID().slice(0, 6)}`)
  await organization.addMembers({ departmentId: d1, userIds: [ids.employee], actorId: ids.orgAdmin })

  // 空部门同样在授权时判定角色本身（PR #126 评审第 1 条）。
  const empty = await createDepartment(ids.orgAdmin, `空部门-${randomUUID().slice(0, 6)}`)
  await assert.rejects(
    organization.grantRole({ departmentId: empty, roleId: roles.sales, actorId: ids.orgAdmin }),
    /授给部门的角色.*超出了你自己的授权：缺少权限 knowledge:docs/,
  )
  // 授给部门的角色不超过操作人：workbench:use 可以，knowledge:docs 不行。
  await organization.grantRole({ departmentId: d1, roleId: roles.basic, actorId: ids.orgAdmin })
  await assert.rejects(
    organization.grantRole({ departmentId: d1, roleId: roles.sales, actorId: ids.orgAdmin }),
    /超出了你自己的授权：缺少权限 knowledge:docs/,
  )
  // 管理类角色连平台管理员也不能授给部门（前缀规则覆盖新增的模块权限码）。
  await assert.rejects(
    organization.grantRole({ departmentId: d1, roleId: roles.modelReader, actorId: ids.platformAdmin }),
    /含管理类权限/,
  )

  // 平台管理员建一个带高权限授权的部门；组织管理员不能把员工加进去，也不能把 d1 挪到它下面。
  const d2 = await createDepartment(ids.platformAdmin, `知识部-${randomUUID().slice(0, 6)}`)
  await organization.grantRole({ departmentId: d2, roleId: roles.sales, includeDescendants: true, actorId: ids.platformAdmin })
  await assert.rejects(
    organization.addMembers({ departmentId: d2, userIds: [ids.employee], actorId: ids.orgAdmin }),
    /超出了你自己的授权/,
  )
  await assert.rejects(
    organization.updateDepartment({ departmentId: d1, parentId: d2, actorId: ids.orgAdmin }),
    /超出了你自己的授权/,
  )
  const [held] = await database<{ count: number }[]>`
    select count(*)::integer as count from user_roles
     where tenant_id = ${tenantId} and user_id = ${ids.employee} and role_id = ${roles.sales}
  `
  assert.equal(held!.count, 0, '被拒绝的变更不留下任何部门角色')

  // 不能变更自己的部门归属；平台管理员可以。
  await assert.rejects(
    organization.addMembers({ departmentId: d1, userIds: [ids.orgAdmin], actorId: ids.orgAdmin }),
    /不能变更自己的部门归属/,
  )
  await organization.addMembers({ departmentId: d1, userIds: [ids.orgAdmin], actorId: ids.platformAdmin })
  await assert.rejects(
    organization.setPrimaryDepartment({ departmentId: d1, userId: ids.orgAdmin, actorId: ids.orgAdmin }),
    /不能变更自己的部门归属/,
  )
  await assert.rejects(
    organization.removeMember({ departmentId: d1, userId: ids.orgAdmin, actorId: ids.orgAdmin }),
    /不能变更自己的部门归属/,
  )

  // 只读或其他模块的管理员不能写组织架构。
  await assert.rejects(
    organization.createDepartment({ parentId: d1, name: '越权部门', actorId: ids.knowledgeAdmin }),
    /没有组织架构的修改权限/,
  )
})

test('部门授予的角色不构成管理权限：服务层只认本地授予', async () => {
  const permissions = await loadLocalAdminPermissions(database, ids.employee)
  assert.ok(!permissions.some(code => code.startsWith('admin:')))
  await assert.rejects(authorization.requireAdminAccess(ids.employee), { code: 'permission_denied' })
})

test('Agent 岗位权限：非平台管理员授出不超过自身，管理类角色只有平台管理员能授', async () => {
  const agentId = `agent-amp-${randomUUID().slice(0, 20)}`
  await new PostgresAgentService(database).createAgent({
    id: agentId, name: '模块权限测试 Agent', description: '验证 Agent 管理员授权上限。', owner: '平台管理员', department: '平台治理',
    visibleRoleIds: ['role-employee'], welcomeMessage: '', examplePrompts: ['整理这段文字'],
    systemPrompt: '你是文本整理 Agent，只使用当前输入。', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], changeSummary: '创建模块权限测试草稿', actor: ids.platformAdmin,
  })
  const access = new PostgresAgentAccessService(database)
  const update = async (actor: string, change: { visibleRoleIds?: string[]; roleIds?: string[]; dataScopes?: string[] }) => {
    const current = await access.getAccess(agentId)
    return access.updateAccess({
      agentId, actor, expectedRevision: current.revision,
      visibleRoleIds: change.visibleRoleIds ?? current.visibleRoleIds,
      roleIds: change.roleIds ?? current.roleIds,
      dataScopes: change.dataScopes ?? current.dataScopes,
    })
  }

  // 自身范围内：可以授予。
  await update(ids.agentAdmin, { roleIds: [roles.basic], dataScopes: [SCOPE] })
  // 超出自身的角色或数据范围、管理类角色：拒绝。
  await assert.rejects(update(ids.agentAdmin, { roleIds: [roles.basic, roles.sales] }), /缺少权限 knowledge:docs/)
  await assert.rejects(update(ids.agentAdmin, { dataScopes: [SCOPE, OTHER_SCOPE] }), new RegExp(`缺少数据范围 ${OTHER_SCOPE}`))
  await assert.rejects(update(ids.agentAdmin, { roleIds: [roles.basic, roles.modelReader] }), /只有平台管理员/)
  // 知识库管理员不能改 Agent。
  await assert.rejects(update(ids.knowledgeAdmin, { roleIds: [] }), /没有Agent的修改权限/)

  // 平台管理员给 Agent 加了超出 Agent 管理员的角色后：Agent 管理员不能再把它开放给新的人，
  // 也不能把它设为主动任务的接收方；只收窄可以。
  await update(ids.platformAdmin, { roleIds: [roles.basic, roles.sales] })
  await assert.rejects(update(ids.agentAdmin, { visibleRoleIds: ['role-employee', roles.basic] }), /超出了你自己的授权/)
  await assert.rejects(assertAgentCapabilityWithinActor(database, ids.agentAdmin, agentId), /超出了你自己的授权/)
  // 只移除可见角色是收窄，不受限制（PR #126 评审第 3 条）。
  await update(ids.agentAdmin, { visibleRoleIds: [] })
  await update(ids.platformAdmin, { visibleRoleIds: ['role-employee'] })
  await update(ids.agentAdmin, { roleIds: [roles.basic] })
  await update(ids.agentAdmin, { visibleRoleIds: ['role-employee', roles.basic] })
  await assertAgentCapabilityWithinActor(database, ids.agentAdmin, agentId)
})

test('存量清单：列出由非平台管理员授出、超出其当前权限的部门授权与 Agent 岗位权限', async () => {
  // 模拟规则上线前留下的授权：组织管理员给部门授了自己没有的角色。
  const view = await organization.snapshot()
  const legacyDepartment = await createDepartment(ids.platformAdmin, `历史部门-${randomUUID().slice(0, 6)}`, rootOf(view))
  const grantId = `dept-grant-legacy-${randomUUID()}`
  await database`
    insert into org_department_grants (id, tenant_id, department_id, role_id, include_descendants, granted_by)
    values (${grantId}, ${tenantId}, ${legacyDepartment}, ${roles.sales}, true, ${ids.orgAdmin})
  `
  const report = await listGrantCeilingExceptions(database)
  const legacy = report.find(item => item.objectId === grantId)
  assert.ok(legacy, '应列出超出授予人权限的部门授权')
  assert.deepEqual(legacy.missingPermissions, ['knowledge:docs'])
  assert.equal(legacy.grantedBy, ids.orgAdmin)
  assert.ok(!report.some(item => item.grantedBy === ids.platformAdmin), '平台管理员授出的不列入')

  // 从未修改过岗位权限的 Agent，按创建人判定（创建时可带执行授权）。
  const createdId = `agent-amp-r-${randomUUID().slice(0, 16)}`
  await new PostgresAgentService(database).createAgent({
    id: createdId, name: '存量清单测试', description: '验证存量清单按创建人判定授予人。', owner: 'Agent 管理员', department: '平台治理',
    visibleRoleIds: ['role-employee'], welcomeMessage: '', examplePrompts: ['整理这段文字'],
    systemPrompt: '你是文本整理 Agent，只使用当前输入。', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], changeSummary: '创建测试草稿', actor: ids.agentAdmin, executionRoleIds: [roles.basic],
  })
  await database`insert into agent_principal_role_grants (tenant_id, principal_id, role_id) values (${tenantId}, ${`principal-agent-${createdId}`}, ${roles.sales})`
  const byCreator = (await listGrantCeilingExceptions(database)).find(item => item.objectId === createdId)
  assert.equal(byCreator?.grantedBy, ids.agentAdmin)
  assert.deepEqual(byCreator?.missingPermissions, ['knowledge:docs'])
})

test('Agent 创建与重新启用：执行授权与开放能力同样不超过操作人', async () => {
  const agents = new PostgresAgentService(database)
  const draft = (id: string, actor: string, executionRoleIds: string[]) => agents.createAgent({
    id, name: '创建授权测试', description: '验证创建时的执行授权上限。', owner: 'Agent 管理员', department: '平台治理',
    visibleRoleIds: ['role-employee'], welcomeMessage: '', examplePrompts: ['整理这段文字'],
    systemPrompt: '你是文本整理 Agent，只使用当前输入。', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
    skills: [], changeSummary: '创建测试草稿', actor, executionRoleIds,
  })
  await assert.rejects(draft(`agent-amp-c-${randomUUID().slice(0, 16)}`, ids.agentAdmin, [roles.sales]), /缺少权限 knowledge:docs/)
  const allowedId = `agent-amp-c-${randomUUID().slice(0, 16)}`
  await draft(allowedId, ids.agentAdmin, [roles.basic])
  await database`insert into agent_principal_role_grants (tenant_id, principal_id, role_id) values (${tenantId}, ${`principal-agent-${allowedId}`}, ${roles.sales})`
  await assert.rejects(agents.setStatus({ agentId: allowedId, status: 'published', actor: ids.agentAdmin }), /超出了你自己的授权/)
})

test('AMP-01 员工与权限模块：授出不超过自身、只读超出自身的角色、不能操作自己与权限更高的账号、编码系统生成', async () => {
  const administration = new IdentityAdministrationService(database, false)
  const hrRole = `role-amp-hr-${randomUUID().slice(0, 8)}`
  await createRole(hrRole, ['admin:identity:write', 'workbench:use'])
  const hr = await createUser('人事管理员', [hrRole, 'role-employee'])
  const plain = await createUser('普通员工二', ['role-employee'])
  const strong = await createUser('知识库文档员', ['role-employee', roles.sales])

  // 新建角色：编码由系统生成；授出超出本人或 admin:* 被拒绝。
  const created = await administration.createRole({ name: `人事助理-${randomUUID().slice(0, 6)}`, permissions: ['workbench:use'], actorId: hr })
  assert.match(created.code, /^role_[0-9a-f]{8}$/)
  await assert.rejects(administration.createRole({ name: '越权角色', permissions: ['knowledge:docs'], actorId: hr }), /缺少权限 knowledge:docs/)
  await assert.rejects(administration.createRole({ name: '平台角色', permissions: ['admin:*'], actorId: hr }), /只有平台管理员可以授出/)

  // 平台管理员角色与含超出权限的角色只读。
  await assert.rejects(administration.updateRole({ roleId: 'role-platform-admin', name: '平台管理员', status: 'active', permissions: ['admin:*'], dataScopes: [], actorId: hr }), /平台管理员角色只有平台管理员可以修改/)
  await assert.rejects(administration.updateRole({ roleId: roles.knowledgeAdmin, name: '知识库管理员', status: 'active', permissions: [], dataScopes: [], actorId: hr }), /这个角色现有的权限超出了你自己的授权/)
  await administration.updateRole({ roleId: created.id, name: '人事助理（改名）', status: 'active', permissions: ['workbench:use'], dataScopes: [], actorId: hr })
  // 停用的角色重新启用后会恢复权限：含超出权限的停用角色同样只读。
  await database`update roles set status = 'disabled' where tenant_id = ${tenantId} and id = ${roles.sales}`
  await assert.rejects(administration.updateRole({ roleId: roles.sales, name: '销售（改名）', status: 'disabled', permissions: [], dataScopes: [], actorId: hr }), /这个角色现有的权限超出了你自己的授权/)
  await database`update roles set status = 'active' where tenant_id = ${tenantId} and id = ${roles.sales}`

  // 减权会让持有人降权（AP13 ④，2026-11-15）：持有人有平台管理员或权限更高的人时只能加权、改名称说明。
  const shared = `role-amp-shared-${randomUUID().slice(0, 8)}`
  await createRole(shared, ['workbench:use'])
  const sharedHolder = await createUser('共享角色持有人', [shared])
  await administration.updateRole({ roleId: shared, name: '共享（改名）', status: 'active', permissions: ['workbench:use'], dataScopes: [], actorId: hr })
  await administration.updateRole({ roleId: shared, name: '共享', status: 'disabled', permissions: ['workbench:use'], dataScopes: [], actorId: hr })
  await administration.updateRole({ roleId: shared, name: '共享', status: 'active', permissions: ['workbench:use'], dataScopes: [], actorId: hr })
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${ids.platformAdmin}, ${shared}, 'local')`
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${strong}, ${shared}, 'local')`
  await administration.updateRole({ roleId: shared, name: '共享（再改名）', status: 'active', permissions: ['workbench:use', 'admin:identity:read'], dataScopes: [], actorId: hr })
  // 读改成写只存写码，按包含关系仍是升级，不算减权。
  await administration.updateRole({ roleId: shared, name: '共享（再改名）', status: 'active', permissions: ['workbench:use', 'admin:identity:write'], dataScopes: [], actorId: hr })
  await assert.rejects(administration.updateRole({ roleId: shared, name: '共享', status: 'active', permissions: ['workbench:use'], dataScopes: [], actorId: hr }), /有你不能操作的持有人/)
  await assert.rejects(administration.updateRole({ roleId: shared, name: '共享', status: 'active', permissions: ['workbench:use', 'admin:identity:read'], dataScopes: [], actorId: hr }), /有你不能操作的持有人/)
  await assert.rejects(administration.updateRole({ roleId: shared, name: '共享', status: 'disabled', permissions: ['workbench:use', 'admin:identity:write'], dataScopes: [], actorId: hr }), /有你不能操作的持有人/)
  await database`delete from user_roles where tenant_id = ${tenantId} and role_id = ${shared} and user_id = ${ids.platformAdmin}`
  await assert.rejects(administration.updateRole({ roleId: shared, name: '共享', status: 'disabled', permissions: ['workbench:use', 'admin:identity:write'], dataScopes: [], actorId: hr }), /有你不能操作的持有人/)
  await database`delete from user_roles where tenant_id = ${tenantId} and role_id = ${shared} and user_id = ${strong}`
  await administration.updateRole({ roleId: shared, name: '共享', status: 'disabled', permissions: ['workbench:use'], dataScopes: [], actorId: hr })
  assert.ok(sharedHolder)
  // 平台管理员不受此限。
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${strong}, ${shared}, 'local')`
  await administration.updateRole({ roleId: shared, name: '共享', status: 'disabled', permissions: [], dataScopes: [], actorId: ids.platformAdmin })

  // 分配角色与数据范围。
  await administration.grantRole({ userId: plain, roleId: roles.basic, actorId: hr })
  await assert.rejects(administration.grantRole({ userId: plain, roleId: roles.sales, actorId: hr }), /要分配的角色超出了你自己的授权/)
  await assert.rejects(administration.replaceUserScopes({ userId: plain, dataScopes: ['region:east'], actorId: hr }), /员工的数据范围超出了你自己的授权/)

  // 不能操作自己、平台管理员或权限比自己高的账号。
  await assert.rejects(administration.grantRole({ userId: hr, roleId: roles.basic, actorId: hr }), /不能操作自己的账号/)
  await assert.rejects(administration.revokeSessions({ userId: ids.platformAdmin, actorId: hr }), /不能操作平台管理员的账号/)
  await assert.rejects(administration.revokeRole({ userId: strong, roleId: roles.sales, actorId: hr }), /对方的权限比你高/)
  // 停用的平台管理员仍按其持有的授权判断，不能被“重新启用后接管”。
  const dormant = await createUser('停用的平台管理员', ['role-platform-admin'])
  await database`update users set status = 'disabled' where tenant_id = ${tenantId} and id = ${dormant}`
  await assert.rejects(administration.revokeSessions({ userId: dormant, actorId: hr }), /不能操作平台管理员的账号/)

  // 跨模块选择器只按姓名搜索（评审 #127）：不能按账号标识反查员工。
  const marker = `marker-${randomUUID().slice(0, 8)}`
  await database`update users set external_user_id = ${marker} where tenant_id = ${tenantId} and id = ${plain}`
  assert.ok((await administration.listUsers({ query: marker })).items.some(item => item.id === plain))
  assert.equal((await administration.listUsers({ query: marker, nameOnly: true })).items.length, 0)
  assert.ok((await administration.listUsers({ query: '普通员工二', nameOnly: true })).items.some(item => item.id === plain))

  // 没有员工与权限修改权限的模块管理员被拒绝。
  await assert.rejects(administration.createRole({ name: '知识库越权', permissions: [], actorId: ids.knowledgeAdmin }), /没有员工与权限的修改权限/)
})
