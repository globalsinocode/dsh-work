/**
 * 真实 DSH 端到端验证（1B 退出条件核心场景）。
 *
 * 走平台全栈 + 真实 DSH Runtime：A 上传共享文件 → 建立团队 Agent 会话 →
 * B（另一名成员）引用该不可变文件发起真实运行 → 运行完成后继续对话，
 * 并打印平台侧记录的运行事件，用于判断真实 DSH 返回里可采集哪些来源信息。
 *
 * 与集成测试的区别：本脚本使用真实 `DshAcpRuntimeAdapter`（真实模型），
 * 在一次性数据库上运行，不修改任何既有数据。
 *
 * 用法：
 *   DSH_WORK_TEST_DATABASE_URL=postgres://... node --env-file-if-exists=.env \
 *     --experimental-strip-types scripts/runtime/team-workspace-e2e.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresContentService } from '../../server/src/modules/workbench/application/postgres-content-service.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import { PostgresOperationsService } from '../../server/src/modules/admin/application/postgres-operations-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../../server/src/modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceMemberService } from '../../server/src/modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceLifecycleService } from '../../server/src/modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { PostgresWorkspaceActivityService } from '../../server/src/modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceUsageService } from '../../server/src/modules/workbench/application/postgres-workspace-usage-service.ts'
import { PostgresWorkspaceService } from '../../server/src/modules/workbench/application/postgres-workspace-service.ts'
import { ModelGovernanceService } from '../../server/src/modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../server/src/modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../server/src/modules/run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../../server/src/modules/runtime/dsh-runtime-installation.ts'
import { createDatabase, type DatabaseClient } from '../../server/src/infrastructure/postgres/database.ts'
import { runMigrations } from '../../server/src/infrastructure/postgres/migration-runner.ts'

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'
const marker = `TEAM-1B-${randomUUID().slice(0, 8).toUpperCase()}`
const suffix = randomUUID().slice(0, 8)
const workspaceId = `ws-e2e-${suffix}`
const ownerId = `user-e2e-owner-${suffix}`
const memberId = `user-e2e-member-${suffix}`

const maintenanceUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!maintenanceUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const databaseName = `dsh_work_e2e_${randomUUID().replaceAll('-', '')}`
const adminUrl = new URL(maintenanceUrl)
// 这个脚本会 create/drop 数据库：只允许本地/回环维护库，避免误指生产（评审 P2）。
const allowedDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1'])
if (!allowedDatabaseHosts.has(adminUrl.hostname) && process.env['DSH_WORK_E2E_ALLOW_REMOTE_DATABASE'] !== '1') {
  throw new Error(
    `拒绝在非本地数据库上运行端到端脚本（host=${adminUrl.hostname}）；`
    + '如确需远程维护库，请显式设置 DSH_WORK_E2E_ALLOW_REMOTE_DATABASE=1。',
  )
}
adminUrl.pathname = '/postgres'
const admin = createDatabase({ url: adminUrl.toString(), maxConnections: 2 })

let database: DatabaseClient | undefined
let runtime: DshAcpRuntimeAdapter | undefined
let dataRoot: string | undefined
let cleanedUp = false

/**
 * 幂等清理：关闭 DSH 运行时（连带终止 ACP 子进程）、删除临时数据根、结束连接、
 * 删除一次性库。
 *
 * 正常路径与抛错路径由 `finally` 调用；**信号路径也必须调用**——Node 在 SIGINT/
 * SIGTERM 下不会执行 `finally`，实测会遗留 `dsh_work_e2e_*` 库、临时目录与孤儿
 * DSH 子进程（对抗性评审 P1）。因此这里额外注册信号处理器，等清理真正完成再退出。
 */
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  await runtime?.close().catch(() => undefined)
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
  await database?.end().catch(() => undefined)
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    console.error(`收到 ${signal}：正在清理一次性库、临时目录与 DSH 运行时…`)
    void cleanup().finally(() => process.exit(exitCode))
  })
}

await admin.unsafe(`create database "${databaseName}"`)

try {
  const testUrl = new URL(maintenanceUrl)
  testUrl.pathname = `/${databaseName}`
  database = createDatabase({ url: testUrl.toString(), maxConnections: 8 })
  await runMigrations(database)

  const projectRoot = resolve(import.meta.dirname, '../..')
  const installation = await resolveDshRuntimeInstallation({ projectRoot })
  await preflightDshRuntime(installation)
  dataRoot = await mkdtemp(join(tmpdir(), 'dsh-work-team-e2e-'))
  runtime = new DshAcpRuntimeAdapter({
    runtimeId,
    runtimeRoot: resolve(dataRoot, 'dsh-attempts'),
    dshRepository: installation.home,
    runtimeVersion: installation.version,
    runtimeCommit: installation.commit,
    protocolVersion: installation.protocolVersion,
    launchMode: installation.launchMode,
    process: installation.process,
    permissionDecision: async () => 'allow_once',
    collectArtifacts: async (manifest, workspaceDirectory) => content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
  })

  const conversations = new PostgresConversationRepository(database)
  const authorization = new PostgresAuthorizationService(database)
  const content = new PostgresContentService(database, resolve(dataRoot, 'storage'), authorization)
  const runs = new PostgresRunRepository(database)
  const agents = new PostgresAgentService(database)
  // operations 必须接线：否则 approval.resolved 触发的工具审计被静默跳过（?），
  // 而这个审计正是「工具返回数据来源」的可追溯落点（T2 关注点）。
  const operations = new PostgresOperationsService(database, runtime, authorization, 'mock')
  const orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    content,
    operations,
    agents,
    undefined,
    authorization,
  )
  // TW-07 / TW-08 / 空间用量（批次 3 与批次 4）需要的服务：全部走真实实现。
  const workspaceService = new PostgresWorkspaceService(database)
  const lifecycle = new PostgresWorkspaceLifecycleService(database)
  const members = new PostgresWorkspaceMemberService(database, authorization)
  const activity = new PostgresWorkspaceActivityService(database, workspaceService)
  const usage = new PostgresWorkspaceUsageService(database, workspaceService, authorization)

  // --- 合成账户与团队空间（对齐方案 §8：A=负责人、B=成员） ---
  await seedUser(ownerId, 'E2E 负责人')
  await seedUser(memberId, 'E2E 成员')
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'E2E 团队空间', '', 'team', ${ownerId}, 'active')
  `
  for (const [userId, role] of [[ownerId, 'owner'], [memberId, 'member']] as const) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${userId}, ${role}, ${ownerId})
    `
  }

  // --- A 上传共享文件（不可变对象 + 解析结果） ---
  const fileBytes = Buffer.from(`# 库存状态\n\n标记：${marker}\n\n华东仓可用 120，华北仓缺货。\n`, 'utf8')
  await content.storeWorkspaceFile(workspaceId, 'e2e-inventory.md', 'text/markdown', fileBytes, ownerId)
  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  const file = listed.items.find(item => item.name === 'e2e-inventory.md')
  if (!file) throw new Error('上传后未在共享文件列表中找到该文件')

  // --- 团队 Agent 成员关联：走真实服务（同时建立 Agent/Skill/Tool 授权来源） ---
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  await agentMembers.addAgentMember(workspaceId, 'agent-dsh-work-assistant', ownerId, ['role-employee'])
  // 迁移可能会将默认 Agent 的活动版本升级（例如增加受控成果写入工具）。
  // 会话必须使用成员关联时实际锁定的版本，而不能假定历史版本 ID。
  const [activeAgent] = await database<{ activeVersionId: string | null }[]>`
    select active_version_id as "activeVersionId"
      from agents
     where tenant_id = ${tenantId} and id = 'agent-dsh-work-assistant'
  `
  const agentVersionId = activeAgent?.activeVersionId
  if (!agentVersionId) throw new Error('默认 Agent 缺少活动版本')

  // --- B（成员）引用该文件发起真实运行 ---
  const session = await orchestration.createSession({
    userId: memberId,
    title: '1B e2e 文件引用分析',
    workspaceId,
    agentVersionId,
  })
  const started = await orchestration.startRun({
    userId: memberId,
    sessionId: session.id,
    prompt: `请读取我提供的共享文件，并且只回复文件中的完整标记（形如 ${marker.slice(0, 4)}... 的大写串）。不要猜测。`,
    idempotencyKey: `e2e-${suffix}-1`,
    fileIds: [file.id],
  })
  if (!started) throw new Error('Run 创建失败')
  const finished = await waitForRun(runs, started.id, 240_000)

  const events = await runs.readEvents('tenant-dsh-work', started.id)
  const assistant = await conversations.getTask(started.id, memberId)

  // --- 运行完成后继续对话（1B 退出条件要求「并能继续」） ---
  const second = await orchestration.startRun({
    userId: memberId,
    sessionId: session.id,
    prompt: '再回复一次同一个标记，确认会话可以继续。',
    idempotencyKey: `e2e-${suffix}-2`,
  })
  if (!second) throw new Error('第二个 Run 创建失败')
  const secondFinished = await waitForRun(runs, second.id, 240_000)

  const secondTask = await conversations.getTask(second.id, memberId)
  const secondText = (secondTask?.messages ?? []).filter(message => message.role === 'assistant').map(message => message.content).join('')

  // --- 来源信息可采集性观察（T2 设计依据） ---
  const toolEvents = events.filter(event => event.eventType.startsWith('tool'))
  const toolMetadataKeys = [...new Set(toolEvents.flatMap(event => Object.keys(event.safeMetadata ?? {})))]
  // 审批事件的元数据 + 工具审计：确认真实 DSH 运行里「谁读了什么」落在哪里。
  const approvalEvents = events.filter(event => event.eventType.startsWith('approval'))
  if (!database) throw new Error('database 未初始化')
  const toolAuditRows = await database<{ toolVersionId: string; parameterSummary: Record<string, unknown>; result: string }[]>`
    select tool_version_id as "toolVersionId", parameter_summary as "parameterSummary", result
      from tool_audit_logs where tenant_id = ${tenantId} and run_id = ${started.id}
  `

  // ==========================================================================
  // TW-07（3-T6 后端 + 3-T9 前端契约）：新版本、旧版可用、引用固定版本、失败版本
  // ==========================================================================
  const logicalFileId = file.logicalFileId
  if (!logicalFileId) throw new Error('共享文件缺少 logicalFileId（TW-07 未生效？）')
  const beforeV2 = await content.listWorkspaceFileVersions({ workspaceId, logicalFileId, actorUserId: ownerId })
  const v1 = beforeV2.items.find(item => item.versionNo === 1)
  if (!v1) throw new Error('版本列表中缺少 v1')
  const markerV2 = `${marker}V2`
  const uploadedV2 = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId,
    name: 'e2e-inventory.md',
    mimeType: 'text/markdown',
    bytes: Buffer.from(`# 库存状态\n\n标记：${markerV2}\n\n华东仓可用 90，华北仓补货中。\n`, 'utf8'),
    note: 'e2e 第二版：更新库存数字',
    actorUserId: ownerId,
  })
  const afterV2 = await content.listWorkspaceFileVersions({ workspaceId, logicalFileId, actorUserId: ownerId })
  const currentAfterV2 = afterV2.items.find(item => item.current)
  const fileListAfterV2 = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 10 })
  const displayedAfterV2 = fileListAfterV2.items.find(item => item.logicalFileId === logicalFileId)

  // 失败版本（坏 .docx）：必须被拒，且不得前移 current、不得破坏旧版（AC-13）。
  let failedVersionRejected = false
  let failedVersionReason = ''
  try {
    await content.uploadWorkspaceFileVersion({
      workspaceId,
      logicalFileId,
      name: 'e2e-broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from('this is not a zip container, so docx extraction must fail', 'utf8'),
      note: null,
      actorUserId: ownerId,
    })
  } catch (error) {
    failedVersionRejected = true
    failedVersionReason = error instanceof Error ? error.message : String(error)
  }
  const afterFailure = await content.listWorkspaceFileVersions({ workspaceId, logicalFileId, actorUserId: ownerId })
  const failedRow = afterFailure.items.find(item => item.parseStatus === 'failed')

  // 引用**固定到 v1 的不可变对象**发起真实运行：助手必须回显 v1 的标记（而不是 v2）。
  // 必须用一个**新会话**：`conversations.getTask` 返回整段会话的全部消息（没有按 Run
  // 过滤，见 postgres-conversation-repository 的 mapMessage），若复用第一个会话，历史里
  // 已有回显 marker 的助手消息，`includes(marker)` 就可能来自回忆而不是读取文件
  // （对抗性评审 P2 实测：把 fileIds 置空仍能回显）。新会话让该断言真正承重。
  const pinnedSession = await orchestration.createSession({
    userId: memberId,
    title: '4-T3 固定版本读取（独立会话）',
    workspaceId,
    agentVersionId,
  })
  const pinned = await orchestration.startRun({
    userId: memberId,
    sessionId: pinnedSession.id,
    prompt: '请读取我提供的共享文件，并且只回复文件中的完整标记。不要猜测，也不要读取其他版本。',
    idempotencyKey: `e2e-${suffix}-pinned-v1`,
    fileIds: [v1.fileId],
  })
  if (!pinned) throw new Error('引用 v1 的 Run 创建失败')
  const pinnedFinished = await waitForRun(runs, pinned.id, 240_000)
  const pinnedTask = await conversations.getTask(pinned.id, memberId)
  const pinnedText = (pinnedTask?.messages ?? []).filter(message => message.role === 'assistant').map(message => message.content).join('')
  // 可追溯：该 Run 的输入文件对象 → workspace_file_versions 必须指向 v1。
  const [trace] = await database<{ versionNo: number | null }[]>`
    select wfv.version_no as "versionNo"
      from run_input_files rif
      join workspace_file_versions wfv
        on wfv.tenant_id = rif.tenant_id and wfv.file_object_id = rif.file_id
     where rif.tenant_id = ${tenantId} and rif.run_id = ${pinned.id}
     limit 1
  `

  // ==========================================================================
  // TW-08（3-T7 + 3-T8）：动态投影、幂等、通知与收权
  // ==========================================================================
  const viewerId = `user-e2e-viewer-${suffix}`
  const adminId = `user-e2e-admin-${suffix}`
  await seedUser(viewerId, 'E2E 只读成员')
  await seedUser(adminId, 'E2E 管理员')
  await members.addMember(workspaceId, viewerId, 'member', ownerId)
  // 同一角色的重复变更必须幂等（只留一条 role_changed 动态）。
  await members.changeMemberRole(workspaceId, viewerId, 'viewer', ownerId)
  await members.changeMemberRole(workspaceId, viewerId, 'viewer', ownerId)
  await members.addMember(workspaceId, adminId, 'admin', ownerId)

  const feedForOwner = await activity.listActivity({ workspaceId, actorUserId: ownerId, limit: 50 })
  const kinds = feedForOwner.items.map(item => item.kind)
  const roleChangedForViewer = feedForOwner.items.filter(item => item.kind === 'role_changed' && item.objectId === viewerId)
  const activityRows = await database<{ kind: string; metadata: Record<string, unknown> }[]>`
    select kind, safe_metadata as metadata from workspace_activity_events
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  // 泄露红线：动态的 safe_metadata 不得出现文件正文/提示词/文件名/标记。
  const activityBlob = JSON.stringify([feedForOwner.items, activityRows])
  // 搜索词覆盖 3-T7 白名单禁止的全部内容类型：两版标记、文件名、正文片段，以及
  // **更新说明**与**失败版本文件名**——只泄露后两者的实现此前不会被这条检查抓住
  // （规格评审 F2）。
  const activityLeaks = [
    marker,
    markerV2,
    'e2e-inventory.md',
    'e2e-broken.docx',
    '库存状态',
    'e2e 第二版：更新库存数字',
  ].filter(needle => activityBlob.includes(needle))

  const unreadBefore = await activity.getNotifications({ workspaceId, actorUserId: memberId, limit: 50 })
  const mutedState = await activity.setNotificationsMuted({ workspaceId, actorUserId: memberId, muted: true })
  const mutedView = await activity.getNotifications({ workspaceId, actorUserId: memberId, limit: 50 })
  const readState = await activity.markNotificationsRead({ workspaceId, actorUserId: memberId })
  const unmuted = await activity.setNotificationsMuted({ workspaceId, actorUserId: memberId, muted: false })

  // 收权：被移除的成员不能再读动态或旧通知条目（接收与点击都重新校验）。
  const oldActivityId = feedForOwner.items[0]?.id ?? ''
  await members.removeMember(workspaceId, viewerId, ownerId)
  const revokedFeedDenied = await deniedWith403(() => activity.listActivity({ workspaceId, actorUserId: viewerId, limit: 5 }))
  const revokedItemDenied = await deniedWith403(() => activity.getActivityItem({ workspaceId, activityId: oldActivityId, actorUserId: viewerId }))
  const revokedNotificationsDenied = await deniedWith403(() => activity.getNotifications({ workspaceId, actorUserId: viewerId, limit: 5 }))
  // 移除动作发生之后再看一次动态：member_removed 必须已落库（上面的快照是移除前的）。
  const feedAfterRemoval = await activity.listActivity({ workspaceId, actorUserId: ownerId, limit: 50 })
  const kindsAfterRemoval = [...new Set(feedAfterRemoval.items.map(item => item.kind))]

  // ==========================================================================
  // 批次 4（TW-09）：空间用量（真实 DSH 运行留下的 model_usage_events）
  // ==========================================================================
  const usageForOwner = await usage.getWorkspaceUsage({ workspaceId, actorUserId: ownerId, range: '7d' })
  // 交叉核对刻意与服务**同谓词**（含状态与时间窗），这样去掉任一条件都会让两边不一致；
  // 其中「状态过滤」的判别力还需要一行第三状态的用量事件——CHECK 允许 blocked 但生产
  // 没有写入者，因此这里显式插一条模拟未来状态（对抗性评审 P2 实测：不加这条时删掉服务
  // 的状态过滤仍会 ok=true）。
  // 样本挂在一个**专门的合成 Run/Attempt** 上，而不是真实 DSH 已经写过用量行的 attempt：
  // 批次 5-T3 的 `model_usage_by_attempt (tenant_id, attempt_id)` 唯一索引会让「在同一
  // attempt 上再插一行」直接 23505（`on conflict (id)` 捕不到该索引的冲突）。合成 Run
  // 仍属本空间的会话，因此「服务必须排除 blocked、交叉核对同谓词排除」的判别力不变。
  const blockedSessionId = `session-e2e-blocked-${suffix}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${blockedSessionId}, ${tenantId}, ${workspaceId}, ${ownerId},
            ${agentVersionId}, 'E2E 第三状态样本会话', 'active')
  `
  const blockedRunId = `run-e2e-blocked-${suffix}`
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${blockedRunId}, ${tenantId}, ${blockedSessionId}, ${ownerId}, ${`idem-blocked-${suffix}`}, 'succeeded')
  `
  const blockedAttemptId = `attempt-e2e-blocked-${suffix}`
  await database`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status
    ) values (
      ${blockedAttemptId}, ${tenantId}, ${blockedRunId}, 1, ${database.json({})}, 'sha256-e2e-blocked',
      ${database.json({ providerKey: 'dsh-default', modelKey: 'dsh-default' })}, 'succeeded'
    )
  `
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-blocked-sample-${suffix}`}, ${tenantId}, ${blockedRunId}, ${blockedAttemptId},
      'dsh-default', 'dsh-default', 999999, 999999, 1, 0, 'CNY', 'blocked',
      ${`trace-blocked-${suffix}`}, true, now()
    ) on conflict (tenant_id, attempt_id) do nothing
  `
  const [blockedSamplePresent] = await database<{ count: number }[]>`
    select count(*)::integer as count from model_usage_events
     where tenant_id = ${tenantId} and attempt_id = ${blockedAttemptId} and status = 'blocked'
  `
  if (blockedSamplePresent?.count !== 1) throw new Error('第三状态样本未落库，用量判别力断言将失效')
  const [usageCrossCheck] = await database<{ count: number; tokens: number }[]>`
    select count(*)::integer as count,
           coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::bigint as tokens
      from model_usage_events mu
      join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
      join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
     where s.tenant_id = ${tenantId} and s.workspace_id = ${workspaceId}
       and mu.status in ('success', 'failed')
       and mu.occurred_at >= current_date - make_interval(days => 6)
       and mu.occurred_at < current_date + interval '1 day'
  `
  // 跨空间隔离：另一个空间（同一负责人）的用量事件不得混入本空间。
  const otherWorkspaceId = `ws-e2e-other-${suffix}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${otherWorkspaceId}, ${tenantId}, 'E2E 另一空间', '', 'team', ${ownerId}, 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${otherWorkspaceId}, ${ownerId}, 'owner', ${ownerId})
  `
  const otherSessionId = `session-e2e-other-${suffix}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${otherSessionId}, ${tenantId}, ${otherWorkspaceId}, ${ownerId},
            ${agentVersionId}, 'E2E 另一空间会话', 'active')
  `
  const otherRunId = `run-e2e-other-${suffix}`
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status)
    values (${otherRunId}, ${tenantId}, ${otherSessionId}, ${ownerId}, ${`idem-other-${suffix}`}, 'succeeded')
  `
  const otherAttemptId = `attempt-e2e-other-${suffix}`
  await database`
    insert into run_attempts (
      id, tenant_id, run_id, attempt_no, manifest, manifest_sha256, model_route_snapshot, status
    ) values (
      ${otherAttemptId}, ${tenantId}, ${otherRunId}, 1, ${database.json({})}, 'sha256-e2e-other',
      ${database.json({ providerKey: 'dsh-default', modelKey: 'dsh-default' })}, 'succeeded'
    )
  `
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-${otherAttemptId}`}, ${tenantId}, ${otherRunId}, ${otherAttemptId},
      'dsh-default', 'dsh-default', 5000000, 5000000, 1, 0, 'CNY', 'success',
      ${`trace-other-${suffix}`}, false, now()
    )
  `
  const usageAfterOtherWorkspace = await usage.getWorkspaceUsage({ workspaceId, actorUserId: ownerId, range: '7d' })
  const usage30d = await usage.getWorkspaceUsage({ workspaceId, actorUserId: ownerId, range: '30d' })
  const usageForAdmin = await usage.getWorkspaceUsage({ workspaceId, actorUserId: adminId, range: '7d' })
  const usageForMemberDenied = await usage.getWorkspaceUsage({ workspaceId, actorUserId: memberId, range: '7d' })
    .then(() => false, (error: unknown) => (error as { status?: number }).status === 403)
  const [personalWorkspace] = await database<{ id: string }[]>`
    select id from workspaces where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${ownerId}
  `
  const usageForPersonalRejected = personalWorkspace
    ? await usage.getWorkspaceUsage({ workspaceId: personalWorkspace.id, actorUserId: ownerId, range: '7d' })
      .then(() => false, (error: unknown) => (error as { status?: number }).status === 422)
    : false

  // --- 3-T4：归档后「历史可读、新运行被拒」（真实 DSH 侧的读/执行双轨） ---
  // 走真实归档服务（而不是直接改库），这样审计与 workspace_archived 动态一并产生。
  await lifecycle.archiveWorkspace(workspaceId, ownerId)
  const archivedFeed = await activity.listActivity({ workspaceId, actorUserId: ownerId, limit: 50 })
  const archivedUsage = await usage.getWorkspaceUsage({ workspaceId, actorUserId: ownerId, range: '7d' })
  const archivedRead = {
    // 读取轨：现任成员仍可读取历史运行详情与正文。
    runDetailReadable: Boolean(await conversations.getTask(started.id, memberId)),
    eventsReadable: (await runs.readEvents(tenantId, started.id)).length > 0,
    sessionsListable: (await conversations.listWorkspaceSessions({
      workspaceId,
      actorUserId: memberId,
      limit: 5,
    })).items.length > 0,
    filesListable: (await content.listWorkspaceFiles({
      workspaceId,
      actorUserId: memberId,
      limit: 5,
    })).items.length > 0,
  }
  // 执行轨：归档后新运行必须被拒绝（不落库）。
  let archivedExecuteDenied = false
  let archivedDenyReason = ''
  try {
    await orchestration.startRun({
      userId: memberId,
      sessionId: session.id,
      prompt: '归档后不应再执行。',
      idempotencyKey: `e2e-${suffix}-archived`,
    })
  } catch (error) {
    archivedExecuteDenied = true
    archivedDenyReason = error instanceof Error ? error.message : String(error)
  }
  const archivedRunsAfterDeny = (await runs.listActiveRunsForWorkspaceUser(tenantId, workspaceId, memberId)).length

  const tw07Ok = currentAfterV2?.versionNo === uploadedV2.versionNo
    && currentAfterV2?.note === 'e2e 第二版：更新库存数字'
    && currentAfterV2?.canDownload === true
    && displayedAfterV2?.versionNo === uploadedV2.versionNo
    && (displayedAfterV2?.versionCount ?? 0) >= 2
    && failedVersionRejected
    && failedRow?.versionNo === uploadedV2.versionNo + 1
    && afterFailure.items.some(item => item.current && item.versionNo === uploadedV2.versionNo)
    && pinnedFinished === 'succeeded'
    && pinnedText.includes(marker)
    && !pinnedText.includes(markerV2)
    && trace?.versionNo === 1

  const tw08Ok = kinds.includes('member_added')
    && kinds.includes('role_changed')
    && kindsAfterRemoval.includes('member_removed')
    && kinds.includes('file_uploaded')
    && kinds.includes('file_version_added')
    && roleChangedForViewer.length === 1
    && activityLeaks.length === 0
    && unreadBefore.unreadCount > 0
    && mutedState.muted === true
    && mutedView.unreadCount === 0
    && mutedView.items.length > 0
    && readState.lastReadAt !== null
    && unmuted.muted === false
    && revokedFeedDenied && revokedItemDenied && revokedNotificationsDenied

  const usageOk = usageForOwner.totals.callCount >= 3
    && usageForOwner.totals.totalTokens > 0
    && usageForOwner.totals.callCount === usageForOwner.totals.successCount + usageForOwner.totals.failedCount
    && usageForOwner.daily.length === 7
    && usageForOwner.daily[6]!.callCount >= 3
    // 同谓词交叉核对（含状态过滤与时间窗）：blocked 样本绝不能计入。
    && usageCrossCheck?.count === usageForOwner.totals.callCount
    && Number(usageCrossCheck?.tokens ?? -1) === usageForOwner.totals.totalTokens
    && usageForOwner.totals.estimatedCount === 0
    // 另一空间同一负责人的 500 万 token 事件不得混入，也不得改变 totals。
    && usageAfterOtherWorkspace.totals.callCount === usageForOwner.totals.callCount
    && usageAfterOtherWorkspace.totals.totalTokens === usageForOwner.totals.totalTokens
    // 30 天窗口：日序列长度与服务端 rangeDays 一致，计数不变（本环境所有事件都在今天）。
    && usage30d.rangeDays === 30
    && usage30d.daily.length === 30
    && usage30d.totals.callCount === usageForOwner.totals.callCount
    && usageForAdmin.totals.callCount === usageForOwner.totals.callCount
    && usageForMemberDenied
    && usageForPersonalRejected
    && archivedUsage.totals.callCount === usageForOwner.totals.callCount

  // 归档读取轨的每一项都必须进入总判定：此前只有运行详情/事件被 gate，导致
  // 「会话/文件/动态仍可读」「动态含 workspace_archived」只是打印而无人保证
  // （评审 P1：删掉 workspace_archived 的活动写入后 ok 仍为 true）。
  const archiveReadOk = archivedRead.runDetailReadable
    && archivedRead.eventsReadable
    && archivedRead.sessionsListable
    && archivedRead.filesListable
    && archivedFeed.items.length > 0
    && archivedFeed.items.some(item => item.kind === 'workspace_archived')

  console.log(JSON.stringify({
    ok: finished === 'succeeded' && secondFinished === 'succeeded'
      && archiveReadOk
      && archivedExecuteDenied && archivedRunsAfterDeny === 0
      && tw07Ok && tw08Ok && usageOk,
    dshVersion: installation.version,
    workspaceId,
    uploadedFileId: file.id,
    uploadedFileScanStatus: file.scanStatus,
    fileRemovable: file.removable,
    firstRun: {
      runId: started.id,
      status: finished,
      assistantTextIncludesMarker: (assistant?.messages ?? []).some(message => message.content.includes(marker)),
      eventTypes: [...new Set(events.map(event => event.eventType))],
      failures: events.filter(event => event.eventType === 'run.failed').map(event => event.safeMetadata),
    },
    secondRun: {
      runId: second.id,
      status: secondFinished,
      assistantTextIncludesMarker: secondText.includes(marker),
      failures: (await runs.readEvents('tenant-dsh-work', second.id))
        .filter(event => event.eventType === 'run.failed').map(event => event.safeMetadata),
    },
    archivedWorkspace: {
      ok: archiveReadOk,
      readTrack: archivedRead,
      executeTrack: { denied: archivedExecuteDenied, reason: archivedDenyReason },
      activeRunsAfterDeny: archivedRunsAfterDeny,
      activityReadable: archivedFeed.items.length > 0,
      activityIncludesArchived: archivedFeed.items.some(item => item.kind === 'workspace_archived'),
      usageReadableByOwner: archivedUsage.totals.callCount,
      note: '3-T4：归档=只读保留。读取轨（历史运行/事件/会话/文件/动态/用量）对现任成员保持可用；执行轨（新运行）必须被拒且不落库。归档现在走真实归档服务，因此同时产生审计与 workspace_archived 动态。',
    },
    tw07Versions: {
      ok: tw07Ok,
      v1FileId: v1.fileId,
      uploadedV2: { versionNo: uploadedV2.versionNo, note: currentAfterV2?.note ?? null },
      versions: afterFailure.items.map(item => ({
        versionNo: item.versionNo,
        parseStatus: item.parseStatus,
        current: item.current,
        canDownload: item.canDownload,
      })),
      displayedVersionNo: displayedAfterV2?.versionNo ?? null,
      displayedVersionCount: displayedAfterV2?.versionCount ?? null,
      failedVersion: { rejected: failedVersionRejected, reason: failedVersionReason, recordedAs: failedRow?.versionNo ?? null },
      pinnedRun: {
        runId: pinned.id,
        status: pinnedFinished,
        readV1Marker: pinnedText.includes(marker),
        leakedV2Marker: pinnedText.includes(markerV2),
        traceableVersionNo: trace?.versionNo ?? null,
        failures: (await runs.readEvents('tenant-dsh-work', pinned.id))
          .filter(event => event.eventType === 'run.failed').map(event => event.safeMetadata),
      },
      note: 'TW-07：新版本成为 current 且不覆盖旧对象；坏版本被拒但记录保留、current 不前移；引用 v1 的真实 DSH 运行只读到 v1 内容，且 run_input_files → workspace_file_versions 可追溯实际版本号。',
    },
    tw08Activity: {
      ok: tw08Ok,
      kinds,
      kindsAfterRemoval,
      roleChangedForViewer: roleChangedForViewer.length,
      leaks: activityLeaks,
      notifications: {
        unreadBefore: unreadBefore.unreadCount,
        mutedUnread: mutedView.unreadCount,
        mutedItemsVisible: mutedView.items.length,
        lastReadAt: readState.lastReadAt,
        unmuted: unmuted.muted,
      },
      revocation: { feedDenied: revokedFeedDenied, oldItemDenied: revokedItemDenied, notificationsDenied: revokedNotificationsDenied },
      note: 'TW-08：成员/文件/归档动态由真实业务动作产生且幂等（同一角色重复变更只留一条）；safe_metadata 不含文件名/正文/标记；静音不改列表、未读可清零；被移除成员读动态与旧条目均被拒。',
    },
    tw09Usage: {
      ok: usageOk,
      totals: usageForOwner.totals,
      dailyLast: usageForOwner.daily[6],
      dailyLength: usageForOwner.daily.length,
      crossCheckRows: usageCrossCheck?.count ?? null,
      crossCheckTokens: Number(usageCrossCheck?.tokens ?? -1),
      blockedSampleExcluded: usageForOwner.totals.callCount === usageCrossCheck?.count,
      otherWorkspaceIsolated: usageAfterOtherWorkspace.totals.totalTokens === usageForOwner.totals.totalTokens,
      range30d: { rangeDays: usage30d.rangeDays, dailyLength: usage30d.daily.length, callCount: usage30d.totals.callCount },
      adminReadable: usageForAdmin.totals.callCount,
      memberDeniedWith403: usageForMemberDenied,
      personalRejectedWith422: usageForPersonalRejected,
      note: '批次 4：用量来自真实 DSH 运行写入的 model_usage_events，聚合计数与逐行交叉核对一致；仅负责人/管理员可读，成员 403、个人空间 422，归档后仍可读。',
    },
    sourceInformationObserved: {
      toolEventCount: toolEvents.length,
      toolEventMetadataKeys: toolMetadataKeys,
      approvalEvents: approvalEvents.map(event => ({ type: event.eventType, metadata: event.safeMetadata })),
      toolAuditRows,
      note: '实测记录：真实 DSH 事件与工具审计里能取到哪些来源字段。原 T2「来源限制采集」已随 2A／2B 放弃，此处仅作事实留存。',
    },
  }, null, 2))
} finally {
  await cleanup()
}

async function seedUser(id: string, displayName: string) {
  if (!database) throw new Error('database 未初始化')
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

/**
 * 只有「类型化 403」才算收权生效：500、连接错误或其它异常都不能伪装成拒绝
 * （对抗性评审 P2：此前 `.then(() => false, () => true)` 会接受任何异常）。
 */
async function deniedWith403(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch (error) {
    return (error as { status?: number }).status === 403
  }
}

async function waitForRun(
  runs: PostgresRunRepository,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await runs.getRun(tenantId, runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run.status
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`等待运行结束超时：${runId}`)
}
