import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { bumpTeamAuthRevision } from '../../authorization/postgres-workspace-grant-source-service.ts'
import { recordWorkspaceActivity } from './workspace-activity-writer.ts'

const tenantId = 'tenant-dsh-work'

/** 新建团队空间的两行：空间本身与创建人负责人身份。调用方负责事务与后续成员写入。 */
export async function insertTeamWorkspaceRows(
  transaction: DatabaseTransaction,
  workspaceId: string,
  input: { name: string; description: string },
  actorUserId: string,
) {
  await transaction`
    insert into workspaces (id, tenant_id, name, description, created_by, status)
    values (${workspaceId}, ${tenantId}, ${input.name.trim()}, ${input.description.trim()}, ${actorUserId}, 'active')
  `
  await transaction`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, ${actorUserId}, 'owner', ${actorUserId})
  `
}

/**
 * 新建空间时一并加入的同事（角色为成员），与创建在同一事务中。调用方已校验员工可加入；
 * 动态与单个添加成员同一口径（`member_added`），群聊据此显示加入记录。
 */
export async function insertNewSpaceEmployeeMembers(
  transaction: DatabaseTransaction,
  workspaceId: string,
  userIds: string[],
  actorUserId: string,
) {
  if (!userIds.length) return
  for (const userId of userIds) {
    const [inserted] = await transaction<{ joinedAt: string }[]>`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${userId}, 'member', ${actorUserId})
      returning joined_at::text as "joinedAt"
    `
    await recordWorkspaceActivity(transaction, {
      workspaceId,
      kind: 'member_added',
      actorUserId,
      objectType: 'member',
      objectId: userId,
      dedupeKey: `member_added:${userId}:${inserted!.joinedAt}`,
      metadata: { userId, role: 'member' },
    })
  }
  await bumpTeamAuthRevision(transaction, workspaceId)
}
