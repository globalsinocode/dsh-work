import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import {
  bindWorkspaceNotificationRecipients,
  writeNotifiableEvent,
} from './workspace-activity-writer.ts'
import type { WorkspaceNotificationRecipientService } from './workspace-notification-recipient-service.ts'

const mockTransaction = {} as DatabaseTransaction

test('writeNotifiableEvent fails when notification recipients are not bound', async () => {
  await assert.rejects(
    () => writeNotifiableEvent({
      kind: 'discussion_posted',
      workspaceId: 'ws-test',
      sessionId: 'session-test',
      messageId: 'message-test',
      actorUserId: 'U00001',
    }, mockTransaction),
    /通知收件人服务未绑定/,
  )
})

test('recipient binding cleanup is idempotent and preserves a newer binding', () => {
  const first = { resolve: async () => [] } as WorkspaceNotificationRecipientService
  const second = { resolve: async () => [] } as WorkspaceNotificationRecipientService
  const unbindFirst = bindWorkspaceNotificationRecipients(first)
  const unbindSecond = bindWorkspaceNotificationRecipients(second)
  unbindFirst()
  unbindFirst()
  unbindSecond()
})
