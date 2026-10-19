import type { AgentAccess } from '@/types/domain'

export interface CapabilityGrantPlan {
  roleIds: string[]
  dataScopes: string[]
  /** 本次为满足能力新增的岗位角色与数据范围；都为空表示无需授予。 */
  addedRoleIds: string[]
  addedScopes: string[]
}

/**
 * 「补齐所需授权」（详情页岗位权限中由管理员手动触发）：每项缺角色的能力补一个当前有效的所需角色
 * （已补的角色可同时满足后续能力），并补齐缺少的数据范围。只增不减，不改可见角色与执行身份。
 * 所需角色都已停用的能力无法补齐，页面继续显示其缺口。
 */
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
