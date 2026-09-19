import { describe, expect, it } from 'vitest'

import { memberRoleCapabilities } from './member-roles'
import type { WorkspaceMember } from '@/types/domain'

const members: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '' },
  { userId: 'u-admin', displayName: '周航', role: 'admin', joinedAt: '' },
  { userId: 'u-member', displayName: '陈默', role: 'member', joinedAt: '' },
]

describe('memberRoleCapabilities', () => {
  it('keeps an owner row locked when it is the only owner', () => {
    const capabilities = memberRoleCapabilities({
      actorRole: 'owner',
      member: members[0]!,
      ownerCount: 1,
    })

    expect(capabilities.editableRoles).toEqual([])
    expect(capabilities.lastOwner).toBe(true)
    expect(capabilities.removable).toBe(false)
  })

  it('lets the owner manage everyone when another owner exists', () => {
    const capabilities = memberRoleCapabilities({
      actorRole: 'owner',
      member: members[0]!,
      ownerCount: 2,
    })

    expect(capabilities.editableRoles).toEqual(['owner', 'admin', 'member', 'viewer'])
    expect(capabilities.lastOwner).toBe(false)
    expect(capabilities.removable).toBe(true)
  })

  it('restricts an admin to member/viewer rows and removes nobody else', () => {
    expect(memberRoleCapabilities({ actorRole: 'admin', member: members[0]!, ownerCount: 2 }))
      .toMatchObject({ editableRoles: [], removable: false })
    expect(memberRoleCapabilities({ actorRole: 'admin', member: members[1]!, ownerCount: 2 }))
      .toMatchObject({ editableRoles: [], removable: false })
    expect(memberRoleCapabilities({ actorRole: 'admin', member: members[2]!, ownerCount: 2 }))
      .toMatchObject({ editableRoles: ['member', 'viewer'], removable: true })
  })

  it('gives members and unknown actors no write capability', () => {
    expect(memberRoleCapabilities({ actorRole: 'member', member: members[2]!, ownerCount: 2 }))
      .toMatchObject({ editableRoles: [], removable: false })
    expect(memberRoleCapabilities({ actorRole: null, member: members[2]!, ownerCount: 1 }))
      .toMatchObject({ editableRoles: [], removable: false })
  })
})
