import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'

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
