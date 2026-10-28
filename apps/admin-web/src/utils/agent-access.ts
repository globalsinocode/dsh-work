import type { AgentAccess } from '@/types/domain'

export interface CapabilityGrantPlan {
  roleIds: string[]
  dataScopes: string[]
  addedRoleIds: string[]
  addedScopes: string[]
}

/** 补齐所需授权：只增不减，不自动保存。 */
export function planCapabilityGrants(
  access: Pick<AgentAccess, 'capabilities' | 'roleOptions'>,
  current: { roleIds: string[]; dataScopes: string[] },
): CapabilityGrantPlan {
  const roles = new Set(current.roleIds)
  const scopes = new Set(current.dataScopes)
  const addedRoleIds: string[] = []
  const addedScopes: string[] = []
  const active = (id: string) => access.roleOptions.some(role => role.id === id && role.status === 'active')

  for (const item of access.capabilities) {
    if (item.requiredRoleIds.length && !item.requiredRoleIds.some(role => roles.has(role))) {
      const candidate = item.requiredRoleIds.find(active)
      if (candidate) {
        roles.add(candidate)
        addedRoleIds.push(candidate)
      }
    }
    for (const scope of item.requiredScopes) {
      if (scopes.has(scope)) continue
      scopes.add(scope)
      addedScopes.push(scope)
    }
  }

  return { roleIds: [...roles].sort(), dataScopes: [...scopes].sort(), addedRoleIds, addedScopes }
}
