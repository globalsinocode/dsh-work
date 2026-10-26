import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WorkspaceNotificationRecipientService,
  type WorkspaceNotificationMemberPort,
  type WorkspaceNotificationParticipantPort,
} from './workspace-notification-recipient-service.ts'

function createService(
  participants: WorkspaceNotificationParticipantPort,
  members: WorkspaceNotificationMemberPort,
) {
  return new WorkspaceNotificationRecipientService({} as never, participants, members)
}

test('discussion excludes actor and deduplicates participants', async () => {
  const participants = {
    listSessionParticipants: async () => ['user-a', 'user-b', 'user-b'],
  }
  const members = {
    isCurrentMember: async () => true,
    listAuthorizedMemberUserIds: async () => [],
  }
  const service = createService(participants, members)
  assert.deepEqual(
    await service.resolve({ kind: 'discussion_posted', actorUserId: 'user-a', sessionId: 's1' }),
    ['user-b'],
  )
})

test('mention targets only explicit current member', async () => {
  const participants = { listSessionParticipants: async () => [] }
  const members = {
    isCurrentMember: async () => true,
    listAuthorizedMemberUserIds: async () => [],
  }
  const service = createService(participants, members)
  assert.deepEqual(
    await service.resolve({
      kind: 'member_mentioned',
      actorUserId: 'user-a',
      mentionedUserId: 'user-c',
      workspaceId: 'ws-1',
    }),
    ['user-c'],
  )
})

test('terminal Run targets requester only', async () => {
  const participants = { listSessionParticipants: async () => [] }
  const members = {
    isCurrentMember: async () => false,
    listAuthorizedMemberUserIds: async () => [],
  }
  const service = createService(participants, members)
  assert.deepEqual(
    await service.resolve({ kind: 'run_failed', actorUserId: 'system', requestedBy: 'user-b' }),
    ['user-b'],
  )
})
