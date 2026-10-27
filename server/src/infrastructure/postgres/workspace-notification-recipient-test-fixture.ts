import type { DatabaseClient } from './database.ts'
import { bindWorkspaceNotificationRecipients } from '../../modules/workbench/application/workspace-activity-writer.ts'
import {
  createPostgresNotificationRecipientPorts,
  WorkspaceNotificationRecipientService,
} from '../../modules/workbench/application/workspace-notification-recipient-service.ts'

/** 为一个可丢弃数据库绑定同库通知收件人；调用方必须在 dispose 前解绑。 */
export function bindTestWorkspaceNotificationRecipients(database: DatabaseClient): () => void {
  const ports = createPostgresNotificationRecipientPorts(database)
  return bindWorkspaceNotificationRecipients(new WorkspaceNotificationRecipientService(
    database,
    ports.participants,
    ports.members,
  ))
}
