import { describe, expect, it } from 'vitest'

import { colleagueMentionOptions, mentionsUser, splitMentions } from './mentions'

describe('mentions (D38)', () => {
  it('builds colleague options without the current user and splits submitted mentions', () => {
    const options = colleagueMentionOptions([
      { userId: 'U1', displayName: '林岚' },
      { userId: 'U2', displayName: '周航' },
    ], 'U1')
    expect(options).toEqual([{ id: 'user:U2', name: '周航', kind: 'member' }])
    expect(splitMentions(['wam-2', 'user:U2', 'wam-1'])).toEqual({ agentMemberIds: ['wam-2', 'wam-1'], userIds: ['U2'] })
    expect(splitMentions(undefined)).toEqual({ agentMemberIds: [], userIds: [] })
  })

  it('detects a message that mentions the given user', () => {
    expect(mentionsUser({ mentionedUserIds: ['U1'] }, 'U1')).toBe(true)
    expect(mentionsUser({ mentionedUserIds: ['U2'] }, 'U1')).toBe(false)
    expect(mentionsUser({}, 'U1')).toBe(false)
  })
})
