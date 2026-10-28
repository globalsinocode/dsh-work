import { describe, expect, it } from 'vitest'

import { planCapabilityGrants } from '../../utils/agent-access'
import type { AgentAccess } from '../../types/domain'

function accessFixture(): Pick<AgentAccess, 'capabilities' | 'roleOptions'> {
  return {
    roleOptions: [
      { id: 'role-employee', name: '普通员工', status: 'active' },
      { id: 'role-finance', name: '财务部', status: 'active' },
    ],
    capabilities: [{
      reference: 'read@1.0.0',
      name: '读取文件',
      source: 'default',
      requiredRoleIds: ['role-employee'],
      requiredScopes: ['workspace:authorized'],
      missingRole: true,
      missingScopes: ['workspace:authorized'],
    }],
  }
}

describe('planCapabilityGrants', () => {
  it('adds the minimum role and scopes without duplicating shared roles', () => {
    const plan = planCapabilityGrants(accessFixture(), { roleIds: [], dataScopes: [] })
    expect(plan.addedRoleIds).toEqual(['role-employee'])
    expect(plan.addedScopes).toEqual(['workspace:authorized'])
    expect(plan.roleIds).toEqual(['role-employee'])
  })

  it('does not add a role when any required candidate is already granted', () => {
    const access = accessFixture()
    access.capabilities.push({
      reference: 'glob@1.0.0',
      name: 'glob',
      source: 'default',
      requiredRoleIds: ['role-finance', 'role-employee'],
      requiredScopes: [],
      missingRole: false,
      missingScopes: [],
    })
    const plan = planCapabilityGrants(access, { roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
    expect(plan.addedRoleIds).toEqual([])
    expect(plan.addedScopes).toEqual([])
  })
})
