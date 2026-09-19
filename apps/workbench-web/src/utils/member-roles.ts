import type { TeamMemberRole, WorkspaceMember } from '@/types/domain'

export interface MemberRoleCapabilitiesInput {
  actorRole: TeamMemberRole | null
  member: WorkspaceMember
  ownerCount: number
}

export interface MemberRoleCapabilities {
  /** 当前操作人可以为该成员设置的角色；空数组表示完全不可编辑。 */
  editableRoles: TeamMemberRole[]
  lastOwner: boolean
  removable: boolean
}

const roleValues: TeamMemberRole[] = ['owner', 'admin', 'member', 'viewer']

/**
 * plan 第 5 节权限矩阵在员工成员行上的落地：负责人可改全员；管理员只能改
 * 「成员／只读成员」，且不能改负责人、其他管理员与自己；最后负责人锁定。
 * 「自己」在无法从服务端契约判定身份时按不可管理处理（绝不误改操作人）。
 */
export function memberRoleCapabilities(input: MemberRoleCapabilitiesInput): MemberRoleCapabilities {
  const lastOwner = input.member.role === 'owner' && input.ownerCount <= 1
  if (lastOwner) return { editableRoles: [], lastOwner, removable: false }
  if (input.actorRole === 'owner') {
    return { editableRoles: [...roleValues], lastOwner, removable: true }
  }
  if (input.actorRole === 'admin' && ['member', 'viewer'].includes(input.member.role)) {
    return { editableRoles: ['member', 'viewer'], lastOwner, removable: true }
  }
  return { editableRoles: [], lastOwner, removable: false }
}
