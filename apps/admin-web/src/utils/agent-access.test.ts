import { expect, it } from 'vitest'

import { planCapabilityGrants } from './agent-access'

const roleOptions = [
  { id: 'role-employee', name: '普通员工', status: 'active' as const },
  { id: 'role-admin', name: '平台管理员', status: 'active' as const },
  { id: 'role-legacy', name: '旧角色', status: 'disabled' as const },
]

function capability(name: string, requiredRoleIds: string[], requiredScopes: string[] = []) {
  return { reference: `${name}@1`, name, source: 'default' as const, requiredRoleIds, requiredScopes, missingRole: false, missingScopes: [] }
}

it('一个角色可满足多项能力时只授予一次，并补齐缺少的数据范围', () => {
  const plan = planCapabilityGrants({ roleOptions, capabilities: [
    capability('查找文件', ['role-employee', 'role-admin'], ['workspace:authorized']),
    capability('搜索文件内容', ['role-employee', 'role-admin'], ['workspace:authorized']),
  ] }, { roleIds: [], dataScopes: [] })
  expect(plan).toMatchObject({
    roleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
    addedRoleIds: ['role-employee'], addedScopes: ['workspace:authorized'],
  })
})

it('已满足时不新增；所需角色都已停用时不补齐，且只增不减', () => {
  const plan = planCapabilityGrants({ roleOptions, capabilities: [
    capability('查找文件', ['role-employee']),
    capability('旧系统查询', ['role-legacy']),
  ] }, { roleIds: ['role-employee', 'role-other'], dataScopes: ['region:east'] })
  expect(plan.addedRoleIds).toEqual([])
  expect(plan.addedScopes).toEqual([])
  expect(plan.roleIds).toEqual(['role-employee', 'role-other'])
  expect(plan.dataScopes).toEqual(['region:east'])
  expect(plan.roleIds).not.toContain('role-legacy')
})
