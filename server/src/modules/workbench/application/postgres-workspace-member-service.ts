import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { bumpTeamAuthRevision } from '../../authorization/postgres-workspace-grant-source-service.ts'
import { authorizationDenied, requestInvalid } from '../../authorization/authorization-errors.ts'
import { workspaceStateConflict } from './workspace-state-conflict-error.ts'
import {
  currentTeamAuthRevision,
  recordWorkspaceActivity,
} from './workspace-activity-writer.ts'

const tenantId = 'tenant-dsh-work'

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

export type RevocationEventKind = 'member_removed' | 'member_exit' | 'role_changed'

export interface MemberCandidate {
  id: string
  displayName: string
  department: string
}

export interface MemberCandidatePage {
  items: MemberCandidate[]
  nextCursor: string | null
}

export interface MemberRecord {
  userId: string
  displayName: string
  role: MemberRole
  joinedAt: string
}

/**
 * 名册条项在成员记录之上补充部门（5-T2）：与候选名册同一口径
 * `coalesce(u.department_id, '未分配部门')`，供员工端展示「姓名 · 部门」。
 * 添加/角色变更响应仍是 MemberRecord，不扩散该字段。
 */
export interface MemberDirectoryItem extends MemberRecord {
  department: string
}

/**
 * Team member roster plus the caller's own role. The caller's role is what lets
 * the workbench render allowed actions from the server rather than guessing
 * ownership from the workspace creator (which stays the creator after a
 * transfer).
 */
export interface MemberDirectory {
  items: MemberDirectoryItem[]
  currentUserRole: MemberRole | null
}

const memberRoles: MemberRole[] = ['owner', 'admin', 'member', 'viewer']

/**
 * Team-workspace employee member management (1A-T3). Personal workspace
 * behavior is untouched: every public method re-asserts the team-only
 * boundary, and routes additionally reject personal workspaces before any
 * role check so team semantics never leak into personal spaces.
 */
export class PostgresWorkspaceMemberService {
  private readonly database: DatabaseClient
  private readonly authorization: PostgresAuthorizationService

  constructor(database: DatabaseClient, authorization: PostgresAuthorizationService) {
    this.database = database
    this.authorization = authorization
  }

  /**
   * Directory candidates searchable by name, ordered by (display_name, id) to
   * match the users_business_directory partial index. Only active business
   * employees with current workbench access are selectable (TW-01); existing
   * members are excluded.
   */
  async listMemberCandidates(
    workspaceId: string,
    input: { query?: string; cursor?: string; limit?: number },
  ): Promise<MemberCandidatePage> {
    await this.assertTeamWorkspace(workspaceId)
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const cursor = input.cursor ? decodeCandidateCursor(input.cursor) : null
    const pattern = input.query?.trim()
      ? `%${input.query.trim().replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
      : null

    const rows = await this.database<{
      id: string
      displayName: string
      department: string
    }[]>`
      select u.id, u.display_name as "displayName",
             coalesce(u.department_id, '未分配部门') as department
        from users u
       where u.tenant_id = ${tenantId}
         and u.status = 'active'
         and u.identity_provider = 'ai-hub'
         and u.business_user = true
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
         and exists (${this.database.unsafe(workbenchAccessPredicate)})
         and not exists (
           select 1 from workspace_members wm
            where wm.tenant_id = u.tenant_id
              and wm.workspace_id = ${workspaceId}
              and wm.user_id = u.id
         )
         and ${pattern === null
           ? this.database`true`
           : this.database`u.display_name ilike ${pattern} escape '\\'`}
         and ${cursor === null
           ? this.database`true`
           : this.database`(u.display_name > ${cursor.name} or (u.display_name = ${cursor.name} and u.id > ${cursor.id}))`}
       order by u.display_name asc, u.id asc
       limit ${limit + 1}
    `

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(({ id, displayName, department }) => ({
      id,
      displayName,
      department,
    }))
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore && last ? encodeCandidateCursor(last.displayName, last.id) : null,
    }
  }

  /**
   * Team member roster readable by any current member (owner/admin/member/
   * viewer) — reading who is in the space is not a management action. Personal
   * workspaces are rejected so team semantics never leak into them, and a
   * non-member is denied rather than shown the roster.
   */
  async listMembers(workspaceId: string, actorUserId: string): Promise<MemberDirectory> {
    // 名册属读取轨（3-T1）：归档空间详情仍需展示成员身份（写操作各自保持执行轨）。
    await this.assertTeamWorkspace(workspaceId, { allowArchived: true })
    const currentUserRole = await this.memberRoleOf(workspaceId, actorUserId)
    if (!currentUserRole) throw authorizationDenied('当前用户不是该空间的成员')

    const rows = await this.database<{
      userId: string
      displayName: string
      role: MemberRole
      joinedAt: Date
      department: string
    }[]>`
      select wm.user_id as "userId", u.display_name as "displayName",
             wm.member_role as role, wm.joined_at as "joinedAt",
             coalesce(u.department_id, '未分配部门') as department
        from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
       where wm.tenant_id = ${tenantId} and wm.workspace_id = ${workspaceId}
       order by case wm.member_role
                  when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end,
                u.display_name asc, wm.user_id asc
    `
    return {
      currentUserRole,
      items: rows.map(row => ({
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        department: row.department,
      })),
    }
  }

  /**
   * Adds an employee to the team workspace. Idempotent for identical roles;
   * a different role for an existing member is rejected so role changes stay
   * on the dedicated PATCH endpoint. Re-asserts the actor holds owner/admin
   * at service level so a demotion racing the route guard cannot slip in.
   */
  async addMember(
    workspaceId: string,
    targetUserId: string,
    role: MemberRole,
    actorUserId: string,
  ): Promise<{ member: MemberRecord; created: boolean }> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    await this.assertAddableEmployee(targetUserId)
    if (role === 'owner') throw workspaceStateConflict('负责人不能直接设置，请通过负责人转交功能')
    if (actorRole === 'admin' && role === 'admin') throw authorizationDenied('管理员没有权限任命管理员')

    // Existing-membership check runs outside the transaction as a fast path;
    // the authoritative check is repeated inside the workspace lock below.
    const existing = await this.findMemberRecord(workspaceId, targetUserId)
    if (existing) {
      if (existing.role === role) return { member: existing, created: false }
      throw workspaceStateConflict('该员工已是空间成员，不能直接变更角色，请使用角色调整功能')
    }

    let created = false
    await this.database.begin(async (transaction) => {
      // 3-T2：所有成员关系变更都必须**先取空间行锁**再动 workspace_members。
      // 否则与 owner-transfer（先锁 spaces 再改成员）形成反向锁对，PostgreSQL 会报
      // 40P01 deadlock（评审实测 40 次里 39 次），并被 HTTP 分类成 500。
      // 并在锁内复核空间仍活跃：此前状态只在事务外检查，归档若在此期间提交，
      // 成员变更仍会成功（验证代理 D4 强制时序实测 8/8 复现）。
      await lockWorkspaceRow(transaction, workspaceId)
      // 锁内复核操作者角色：锁外快照在等锁期间可能已降级/移除，不能直接沿用。
      const lockedActorRole = await this.requireActorRole(
        workspaceId, actorUserId, ['owner', 'admin'], transaction)
      if (lockedActorRole === 'admin' && role === 'admin') {
        throw authorizationDenied('管理员没有权限任命管理员')
      }
      // 锁内复核目标成员关系：并发重复添加同角色按幂等处理，不同角色拒绝——
      // 不能让后到的请求误报 created 或借竞态覆盖角色。
      const [lockedExisting] = await transaction<{ existingRole: MemberRole }[]>`
        select member_role as "existingRole"
          from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
      `
      if (lockedExisting) {
        if (lockedExisting.existingRole === role) return
        throw workspaceStateConflict('该员工已是空间成员，不能直接变更角色，请使用角色调整功能')
      }
      // `returning` tells us whether this transaction actually created the
      // membership: a concurrent/duplicate add hits `on conflict do nothing` and
      // must not add a second `member_added` activity (AC-15). The membership
      // row's `joined_at` is the generation token, so add → remove → re-add
      // produces distinct keys while a duplicate insert keeps the same one.
      const [inserted] = await transaction<{ joinedAt: string }[]>`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${workspaceId}, ${targetUserId}, ${role}, ${actorUserId})
        on conflict (tenant_id, workspace_id, user_id) do nothing
        returning joined_at::text as "joinedAt"
      `
      if (!inserted) return
      await bumpTeamAuthRevision(transaction, workspaceId)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'member_added',
        actorUserId,
        objectType: 'member',
        objectId: targetUserId,
        dedupeKey: `member_added:${targetUserId}:${inserted.joinedAt}`,
        metadata: { userId: targetUserId, role },
      })
      created = true
    })
    const member = await this.findMemberRecord(workspaceId, targetUserId)
    if (!member) throw new Error('成员添加失败，请稍后重试')
    return { member, created }
  }

  /**
   * Changes an existing member's role. The owner role is never assignable
   * here — owner changes go through the owner transfer endpoint (AC-02).
   * Re-asserts the actor holds owner/admin at service level so a demotion
   * racing the route guard cannot slip in; a concurrent owner transfer is
   * translated into a friendly conflict error by runMembershipMutation.
   */
  async changeMemberRole(
    workspaceId: string,
    targetUserId: string,
    role: MemberRole,
    actorUserId: string,
  ): Promise<MemberRecord> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    const member = await this.findMemberRecord(workspaceId, targetUserId)
    if (!member) throw memberTargetNotFound('目标成员不存在于该空间')
    this.assertRoleChangeAllowed(actorRole, member.role, role)
    if (member.role === role) return member

    await this.runMembershipMutation(workspaceId, async (transaction) => {
      // 角色必须在**事务内、拿到空间行锁之后**重新读：`member.role` 是锁外快照，
      // 两个并发改角色时败者会把过期的 from 写进撤销事件与动态（质量评审 F2 / 规格
      // 评审 D5 实测：真实链路 member→admin→viewer，却记成两条 from=member）。
      // `for update` 同时把该成员的这次转换串行化。行锁顺序不变：workspaces → workspace_members。
      const [current] = await transaction<{ fromRole: MemberRole }[]>`
        select member_role as "fromRole"
          from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
         for update
      `
      if (!current) return
      const fromRole = current.fromRole
      // 锁内同样复核操作者角色：等锁期间操作者可能已被降级或移出，
      // 不能沿用锁外快照继续授权。
      const lockedActorRole = await this.requireActorRole(
        workspaceId, actorUserId, ['owner', 'admin'], transaction)
      // 用事务内读到的真实角色重跑授权判定：否则锁外快照为 member、实际已是 admin 时，
      // 管理员可以借竞态把另一个管理员降级（既可过期又可越权）。
      this.assertRoleChangeAllowed(lockedActorRole, fromRole, role)
      if (fromRole === role) return
      // `is distinct from` makes a racing duplicate change a no-op instead of a
      // second write, so only a real transition writes a revocation event and an
      // activity row (AC-15). The post-bump auth revision then separates an
      // A->B->A->B oscillation: the resulting role repeats but the revision does
      // not, so the second A->B keeps its own activity row.
      const [changed] = await transaction<{ joinedAt: string }[]>`
        update workspace_members
           set member_role = ${role}
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
           and member_role is distinct from ${role}
        returning joined_at::text as "joinedAt"
      `
      // 无实际变化不增加授权修订（评审 L1）：并发败者不应触发一次全局读缓存失效。
      if (!changed) return
      await bumpTeamAuthRevision(transaction, workspaceId)
      await this.writeRevocationEvent(transaction, workspaceId, targetUserId, 'role_changed', {
        from: fromRole,
        to: role,
        by: actorUserId,
      })
      const revision = await currentTeamAuthRevision(transaction, workspaceId)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'role_changed',
        actorUserId,
        objectType: 'member',
        objectId: targetUserId,
        dedupeKey: `role_changed:${targetUserId}:${changed.joinedAt}:${fromRole}->${role}:${revision}`,
        metadata: { userId: targetUserId, from: fromRole, to: role },
      })
    })
    const updated = await this.findMemberRecord(workspaceId, targetUserId)
    if (!updated) throw memberTargetNotFound('目标成员不存在于该空间')
    return updated
  }

  /**
   * Removes a member. Their shared contributions and authorship are kept —
   * only the membership row and the team authorization revision change.
   * Re-asserts the actor holds owner/admin at service level so a demotion
   * racing the route guard cannot slip in; a concurrent owner transfer is
   * translated into a friendly conflict error by runMembershipMutation.
   *
   * 3-T1 governance exception: access revocation must still work on an
   * archived workspace, so this path explicitly allows archival.
   */
  async removeMember(
    workspaceId: string,
    targetUserId: string,
    actorUserId: string,
  ): Promise<{ userId: string; removed: true }> {
    await this.assertTeamWorkspace(workspaceId, { allowArchived: true })
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    const targetRole = await this.memberRoleOf(workspaceId, targetUserId)
    if (!targetRole) throw memberTargetNotFound('目标成员不存在于该空间')
    if (targetRole === 'owner') {
      if (actorRole === 'admin') throw authorizationDenied('管理员没有权限移除管理员或负责人')
      // Pre-check replaces the deferred single-owner trigger failure with a
      // friendly message (the trigger would roll the delete back anyway).
      throw workspaceStateConflict('负责人不能直接移除，请先转交负责人')
    }
    if (actorRole === 'admin' && targetRole === 'admin') {
      throw authorizationDenied('管理员没有权限移除管理员或负责人')
    }

    await this.runMembershipMutation(workspaceId, async (transaction) => {
      // 治理例外：归档空间仍必须能紧急撤权。
      // 锁内复核操作者与目标角色：等锁期间操作者可能被降级/移出，目标也可能
      // 刚被提升为管理员或负责人——沿用锁外快照会误删或越权。
      const lockedActorRole = await this.requireActorRole(
        workspaceId, actorUserId, ['owner', 'admin'], transaction)
      const lockedTargetRole = await this.memberRoleOf(workspaceId, targetUserId, transaction)
      if (!lockedTargetRole) throw memberTargetNotFound('目标成员不存在于该空间')
      if (lockedTargetRole === 'owner') {
        if (lockedActorRole === 'admin') throw authorizationDenied('管理员没有权限移除管理员或负责人')
        throw workspaceStateConflict('负责人不能直接移除，请先转交负责人')
      }
      if (lockedActorRole === 'admin' && lockedTargetRole === 'admin') {
        throw authorizationDenied('管理员没有权限移除管理员或负责人')
      }
      // `returning` 区分「真的删掉了成员」与并发重复删除：只有前者才写撤权事件
      // 与动态；删除行的 joined_at 是成员代际，重加后再移除会得到不同去重键。
      const [deleted] = await transaction<{ joinedAt: string }[]>`
        delete from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
        returning joined_at::text as "joinedAt"
      `
      if (!deleted) return
      await bumpTeamAuthRevision(transaction, workspaceId)
      await this.writeRevocationEvent(transaction, workspaceId, targetUserId, 'member_removed', {
        by: actorUserId,
      })
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'member_removed',
        actorUserId,
        objectType: 'member',
        objectId: targetUserId,
        dedupeKey: `member_removed:${targetUserId}:${deleted.joinedAt}`,
        metadata: { userId: targetUserId },
      })
    }, { allowArchived: true })
    return { userId: targetUserId, removed: true }
  }

  /**
   * Self exit for any non-owner member. The owner must transfer first.
   * Re-asserts membership at service level; a concurrent owner transfer
   * (actor becomes owner mid-request) is translated into a friendly
   * conflict error by runMembershipMutation.
   */
  async exitWorkspace(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ workspaceId: string; exited: true }> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(
      workspaceId,
      actorUserId,
      ['owner', 'admin', 'member', 'viewer'],
    )
    if (actorRole === 'owner') throw workspaceStateConflict('负责人不能直接退出空间，请先转交负责人')

    await this.runMembershipMutation(workspaceId, async (transaction) => {
      // 锁内复核操作者角色：等锁期间可能刚被提升为负责人，
      // 此时退出会触发单负责人约束失败，应按业务规则拒绝。
      const lockedActorRole = await this.requireActorRole(
        workspaceId, actorUserId, ['owner', 'admin', 'member', 'viewer'], transaction)
      if (lockedActorRole === 'owner') {
        // 预检时操作者还是普通成员——此处命中说明等锁期间被并发转交提升为
        // 负责人，按竞态措辞拒绝（与 transferOwnership 的锁内复核一致）。
        throw workspaceStateConflict('负责人信息已变化，不能继续操作，请刷新后重试')
      }
      const [deleted] = await transaction<{ joinedAt: string }[]>`
        delete from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${actorUserId}
        returning joined_at::text as "joinedAt"
      `
      if (!deleted) return
      await bumpTeamAuthRevision(transaction, workspaceId)
      await this.writeRevocationEvent(transaction, workspaceId, actorUserId, 'member_exit', {
        by: actorUserId,
      })
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'member_exit',
        actorUserId,
        objectType: 'member',
        objectId: actorUserId,
        dedupeKey: `member_exit:${actorUserId}:${deleted.joinedAt}`,
        metadata: { userId: actorUserId },
      })
    })
    return { workspaceId, exited: true }
  }

  /**
   * Owner transfer: locks the workspace row so concurrent transfers serialize
   * (AC-02), swaps the two membership roles, bumps the revision and records
   * one role_changed event per affected user. Content creator fields are
   * never touched. The actor is fully re-verified against the current owner;
   * the deferred single-owner trigger validates the swap at commit and a
   * concurrent loser's trigger failure is translated to a friendly conflict
   * error by runMembershipMutation.
   *
   * 3-T1 governance exception: owner transfer must still work on an archived
   * workspace (a sole owner cannot be removed, so this is the only way to
   * change the responsible person after archiving). Explicitly allow archival.
   */
  async transferWorkspaceOwner(
    workspaceId: string,
    toUserId: string,
    actorUserId: string,
  ): Promise<{ workspaceId: string; previousOwnerId: string; newOwnerId: string }> {
    await this.assertTeamWorkspace(workspaceId, { allowArchived: true })
    const previousOwnerId = await this.authorization.resolveWorkspaceOwner(workspaceId)
    if (previousOwnerId !== actorUserId) throw authorizationDenied('没有权限转交负责人')
    if (toUserId === previousOwnerId) throw workspaceStateConflict('转交目标不能是当前负责人')
    const targetRole = await this.memberRoleOf(workspaceId, toUserId)
    if (!targetRole) throw requestInvalid('转交目标必须是该空间的现有成员')

    await this.runMembershipMutation(workspaceId, async (transaction) => {
      // 治理例外：归档空间仍必须能转交负责人。
      // Serialize owner transfers per workspace: a second concurrent
      // transfer blocks here until the first commits, then fails the
      // single-owner trigger at commit time.
      await transaction`
        select id from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
         for update
      `
      // 锁内复核：等锁期间并发转交可能已提交，操作者已不再是负责人；
      // 转交目标也可能已被移出空间。锁外快照不能直接沿用。
      const lockedActorRole = await this.memberRoleOf(workspaceId, actorUserId, transaction)
      if (lockedActorRole !== 'owner') throw authorizationDenied('没有权限转交负责人')
      const lockedTargetRole = await this.memberRoleOf(workspaceId, toUserId, transaction)
      if (!lockedTargetRole) throw requestInvalid('转交目标必须是该空间的现有成员')
      await transaction`
        update workspace_members
           set member_role = 'member'
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${previousOwnerId}
      `
      // `is distinct from` detects a real promotion: a racing duplicate transfer
      // finds the target already owner and must not add a second
      // owner_transferred activity. The post-bump revision separates an
      // A->B->A->B transfer oscillation.
      const [promoted] = await transaction<{ joinedAt: string }[]>`
        update workspace_members
           set member_role = 'owner'
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${toUserId}
           and member_role is distinct from 'owner'
        returning joined_at::text as "joinedAt"
      `
      await this.writeRevocationEvent(transaction, workspaceId, previousOwnerId, 'role_changed', {
        from: 'owner',
        to: 'member',
        by: actorUserId,
      })
      if (promoted) {
        await this.writeRevocationEvent(transaction, workspaceId, toUserId, 'role_changed', {
          from: lockedTargetRole,
          to: 'owner',
          by: actorUserId,
        })
      }
      await bumpTeamAuthRevision(transaction, workspaceId)
      if (!promoted) return
      const revision = await currentTeamAuthRevision(transaction, workspaceId)
      await recordWorkspaceActivity(transaction, {
        workspaceId,
        kind: 'owner_transferred',
        actorUserId,
        objectType: 'member',
        objectId: toUserId,
        dedupeKey: `owner_transferred:${previousOwnerId}->${toUserId}:${revision}`,
        metadata: { fromUserId: previousOwnerId, toUserId },
      })
    }, { allowArchived: true })
    return { workspaceId, previousOwnerId, newOwnerId: toUserId }
  }

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  /**
   * Team-only + status boundary for member operations.
   *
   * 3-T1: the default is the EXECUTION track (active-only), so archiving stops
   * adding members, changing roles and exiting. `allowArchived: true` is the
   * explicit governance exception required by batch 3 — emergency access
   * revocation (`removeMember`) and owner transfer must still work on an
   * archived workspace. It is passed per call site, never as a default.
   */
  private async assertTeamWorkspace(workspaceId: string, options: { allowArchived?: boolean } = {}) {
    const allowArchived = options.allowArchived === true
    const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
      select workspace_type as type from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
         and ${allowArchived
           ? this.database.unsafe(`status in ('active', 'archived')`)
           : this.database.unsafe(`status = 'active'`)}
    `
    // 用「不可访问」而非「不存在」：归档前该空间对调用者可能是可见的，若按「不存在」
    // 映射成 404，会让非成员用状态码区分「归档」与「不存在/无权」，形成存在性泄露。
    if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
    if (workspace.type !== 'team') throw requestInvalid('仅支持团队工作空间进行成员管理')
  }

  /**
   * Rejects employees outside the addable directory (TW-01): active business
   * employees with current workbench access, same criterion requireIdentity
   * applies for the workbench:use permission.
   */
  private async assertAddableEmployee(userId: string) {
    const [row] = await this.database<{ reason: string | null }[]>`
      select case
        when u.status <> 'active' then 'disabled'
        when u.identity_provider <> 'ai-hub' or not u.business_user then 'directory'
        when not exists (${this.database.unsafe(workbenchAccessPredicate)}) then 'no_access'
        else null
      end as reason
        from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId}
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
    `
    if (!row) throw memberTargetNotFound('目标员工不存在')
    if (row.reason === 'disabled') throw workspaceStateConflict('该员工已停用，不能添加为成员')
    if (row.reason === 'directory') throw workspaceStateConflict('该员工不属于业务员工目录，不能添加为成员')
    if (row.reason === 'no_access') throw workspaceStateConflict('该员工不具备员工工作台使用权限，不能添加为成员')
  }

  private async memberRoleOf(
    workspaceId: string,
    userId: string,
    executor: DatabaseClient | DatabaseTransaction = this.database,
  ): Promise<MemberRole | null> {
    const [member] = await executor<{ role: MemberRole }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId}
         and workspace_id = ${workspaceId}
         and user_id = ${userId}
    `
    return member?.role ?? null
  }

  /**
   * Service-level re-verification of the actor's current role. Route guards
   * run before this read, so a demotion racing in between (TOCTOU) must be
   * caught here: the actor must be a member and hold one of `allowedRoles`,
   * otherwise a permission denial is thrown. Membership mutations additionally
   * re-run this inside the workspace lock (executor = transaction), because a
   * pre-lock snapshot can go stale while waiting on the lock.
   */
  private async requireActorRole(
    workspaceId: string,
    actorUserId: string,
    allowedRoles: MemberRole[],
    executor: DatabaseClient | DatabaseTransaction = this.database,
  ): Promise<MemberRole> {
    const role = await this.memberRoleOf(workspaceId, actorUserId, executor)
    if (!role) throw authorizationDenied('当前用户不是该空间的成员')
    if (!allowedRoles.includes(role)) throw authorizationDenied('当前用户角色没有权限执行此操作')
    return role
  }

  private assertRoleChangeAllowed(actorRole: MemberRole, targetRole: MemberRole, newRole: MemberRole) {
    if (targetRole === 'owner') throw authorizationDenied('没有权限调整负责人的角色，请使用负责人转交功能')
    if (newRole === 'owner') throw workspaceStateConflict('负责人不能直接设置，请通过负责人转交功能')
    if (actorRole === 'admin') {
      if (targetRole === 'admin') throw authorizationDenied('管理员没有权限调整管理员的角色')
      if (newRole === 'admin') throw authorizationDenied('管理员没有权限任命管理员')
    }
  }

  private async findMemberRecord(workspaceId: string, userId: string): Promise<MemberRecord | null> {
    const [member] = await this.database<{
      userId: string
      displayName: string
      role: MemberRole
      joinedAt: Date
    }[]>`
      select wm.user_id as "userId", u.display_name as "displayName",
             wm.member_role as role, wm.joined_at as "joinedAt"
        from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
       where wm.tenant_id = ${tenantId}
         and wm.workspace_id = ${workspaceId}
         and wm.user_id = ${userId}
    `
    if (!member) return null
    return {
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    }
  }

  /**
   * Runs a membership mutation in a transaction and translates the deferred
   * single-owner trigger failure (team_workspace_single_owner, migration
   * 0022 — raise text "must have exactly one owner") into a friendly
   * conflict error. The trigger can only abort here when a concurrent owner
   * transfer committed between the role pre-checks (which run outside the
   * transaction) and the mutation, so the error instructs a refresh instead
   * of surfacing the raw trigger message as a 500.
   */
  private async runMembershipMutation(
    workspaceId: string,
    action: (transaction: DatabaseTransaction) => Promise<void>,
    options: { allowArchived?: boolean } = {},
  ): Promise<void> {
    try {
      await this.database.begin(async (transaction) => {
        // 统一锁序：workspaces → workspace_members → events。转交内部会再取同一行锁
        // （同事务重入，代价可忽略），四个成员变更入口因此锁序一致，不再与转交形成
        // 反向锁对（3-T2；此前并发转交 + 移除成员实测 40 次里 39 次 40P01 → HTTP 500）。
        // 治理例外（撤权、转交）必须能在归档空间执行，其余变更要求活跃空间。
        await lockWorkspaceRow(transaction, workspaceId, options.allowArchived === true)
        await action(transaction)
      })
    } catch (error) {
      if (isSingleOwnerViolation(error)) {
        throw workspaceStateConflict('负责人信息已变化，不能继续操作，请刷新后重试')
      }
      throw error
    }
  }

  private async writeRevocationEvent(
    transaction: DatabaseTransaction,
    workspaceId: string,
    userId: string,
    kind: RevocationEventKind,
    payload: Record<string, string>,
  ) {
    // payload_hash is md5(payload::text) computed by the database so replays
    // with logically identical payloads always produce the same hash and hit
    // the workspace_revocation_events_dedupe unique key.
    await transaction`
      insert into workspace_revocation_events (
        id, tenant_id, workspace_id, user_id, kind, payload, payload_hash
      ) values (
        ${`wrev-${randomUUID()}`}, ${tenantId}, ${workspaceId}, ${userId}, ${kind},
        ${transaction.json(payload)}, md5(${transaction.json(payload)}::text)
      )
      on conflict do nothing
    `
  }
}

const workbenchAccessPredicate = /* sql */ `
  select 1
    from user_roles ur
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
   where ur.tenant_id = u.tenant_id and ur.user_id = u.id
     and ur.source_key = 'local'
     and (ur.valid_until is null or ur.valid_until > now())
     and r.status = 'active'
     and r.permissions ? 'workbench:use'
`

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && memberRoles.includes(value as MemberRole)
}

function encodeCandidateCursor(displayName: string, id: string) {
  return Buffer.from(JSON.stringify({ n: displayName, i: id }), 'utf8').toString('base64url')
}

function decodeCandidateCursor(cursor: string): { name: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { n?: unknown; i?: unknown }
    if (typeof parsed.n !== 'string' || typeof parsed.i !== 'string') throw new Error('bad cursor')
    return { name: parsed.n, id: parsed.i }
  } catch {
    throw new Error('分页游标无效')
  }
}

/** 成员管理目标的类型化 404：与 automation-service 的 notFound 同一约定，不再依赖中文文案正则。 */
function memberTargetNotFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404, code: 'member_target_not_found' })
}

function isSingleOwnerViolation(error: unknown) {
  return error instanceof Error && /exactly one owner/.test(error.message)
}

/**
 * 3-T2：成员关系变更与 owner-transfer 统一「先取空间行锁」。
 * 与归档/开跑使用的是同一行锁（`workspaces`），不引入第二把锁；
 * 目的是消除与转交之间的反向锁对导致的 PostgreSQL 40P01 死锁。
 */
/**
 * 3-T2：取空间行锁（并在需要时于锁内复核空间活跃）。
 *
 * ① 统一「workspaces → workspace_members」锁序，消除与 owner-transfer 的反向锁对
 * （此前并发转交 + 移除成员实测 39/40 次 40P01 → HTTP 500）。
 * ② 除治理例外外，把「空间是否可写」的判断移进锁内：归档事务若先拿到锁并提交，
 * 这里会读到 archived 并拒绝，而不是让并发的成员变更穿过（验证代理 D4）。
 */
async function lockWorkspaceRow(
  transaction: DatabaseTransaction,
  workspaceId: string,
  allowArchived = false,
) {
  const [workspace] = await transaction<{ status: string }[]>`
    select status from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
     for update
  `
  if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
  if (!allowArchived && workspace.status !== 'active') {
    throw authorizationDenied('工作空间已归档，仅支持有权限的只读查看与下载')
  }
}

