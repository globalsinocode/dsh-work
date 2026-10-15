/**
 * 1B-T5 可见统计性能基线工具。
 *
 * 测量团队空间「可见统计」相关读取路径的查询次数、延迟分位、数据量与并发表现，
 * 输出可复核的 Markdown 报告。使用一次性库（`createThrowawayDatabase()`），
 * 不接触任何共享库。
 *
 * 用法：
 *   DSH_WORK_TEST_DATABASE_URL='postgres://…/postgres' \
 *     node --experimental-strip-types --env-file-if-exists=.env \
 *     scripts/bench/team-workspace-statistics.ts [--out docs/baselines/…md]
 *
 * 参数（也可用环境变量）：
 *   --members  团队成员数（默认 40）
 *   --sessions 团队会话数（默认 200）
 *   --files    团队共享文件数（默认 200）
 *   --runs     单个「热点」会话的 Run 数（默认 60）
 *   --spaces   调用者可见的团队空间数（默认 5）
 *   --actor    测量视角的成员数（默认 1，即只测一个成员的可见范围）
 *   --concurrency 并发调用数（默认 10）
 *
 * 设计取舍：业务语义（成员角色、空间类型、个人空间触发器）用真实表与约束表达；
 * 纯体量数据（会话/Run/文件行）直接插入，避免为了造量而跑完整执行链路。
 */

import { randomUUID } from 'node:crypto'

import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { canReadWorkspaceObject } from '../../server/src/domain/authorization-errors.ts'
import { createDatabase, type DatabaseClient } from '../../server/src/infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresContentService } from '../../server/src/modules/workbench/application/postgres-content-service.ts'

const tenantId = 'tenant-dsh-work'
const agentVersionId = 'agent-version-dsh-work-assistant-1'

interface Options {
  members: number
  sessions: number
  files: number
  runs: number
  spaces: number
  actors: number
  concurrency: number
  out: string | null
}

function parseOptions(argv: string[]): Options {
  const numbers: Record<string, number> = {}
  let out: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--out') {
      out = argv[index + 1] ?? null
      index += 1
      continue
    }
    const match = /^--([a-z]+)(?:=(\d+))?$/.exec(arg)
    if (match) {
      const key = match[1]!
      const value = match[2] ?? argv[index + 1]
      if (value && /^\d+$/.test(value)) {
        numbers[key] = Number(value)
        if (match[2] === undefined) index += 1
      }
    }
  }
  const env = (name: string, fallback: number) => {
    const raw = process.env[name]
    return raw && /^\d+$/.test(raw) ? Number(raw) : fallback
  }
  return {
    members: numbers['members'] ?? env('BENCH_MEMBERS', 40),
    sessions: numbers['sessions'] ?? env('BENCH_SESSIONS', 200),
    files: numbers['files'] ?? env('BENCH_FILES', 200),
    runs: numbers['runs'] ?? env('BENCH_RUNS', 60),
    spaces: numbers['spaces'] ?? env('BENCH_SPACES', 5),
    actors: numbers['actors'] ?? env('BENCH_ACTORS', 1),
    concurrency: numbers['concurrency'] ?? env('BENCH_CONCURRENCY', 10),
    out,
  }
}

interface Sample {
  label: string
  group: string
  queries: number
  ms: number
}

class Recorder {
  readonly samples: Sample[] = []
  counting = false
  queries = 0
  /** 连接池类型探测语句数，不计入被测调用。 */
  bootstrap = 0

  /** 统计一次调用的 SQL 语句数与墙钟耗时。 */
  async measure<T>(group: string, label: string, call: () => Promise<T>): Promise<T> {
    this.queries = 0
    this.bootstrap = 0
    this.counting = true
    const started = performance.now()
    try {
      return await call()
    } finally {
      const ms = performance.now() - started
      this.counting = false
      this.samples.push({ group, label, queries: this.queries, ms })
    }
  }
}

/**
 * 计数用连接。
 *
 * 计数单位是 **SQL 语句数**，不是网络往返数：postgres.js 的 `debug` 钩子每个语句触发
 * 一次，而 `prepare: false` 下带参数的语句会先发 `Parse/Describe` 再发 `Bind/Execute`
 * （两次请求/响应）。本工具用语句数是因为它稳定、与实现代码一一对应；要换算成线级
 * 往返，带参语句大致 ×2。
 *
 * 连接池首次建立连接时会执行 `pg_catalog.pg_type` 类型探测；它属于池启动开销，不是被测
 * 调用产生的成本，因此这里显式排除（否则「冷启动」与「并发」两栏会被池预热污染）。
 */
const BOOTSTRAP_PATTERN = /pg_catalog\.pg_type/
function createCountingClient(url: string, maxConnections: number, recorder: Recorder) {
  return createDatabase({
    url,
    maxConnections,
    debug: (_connection, query) => {
      if (!recorder.counting) return
      if (BOOTSTRAP_PATTERN.test(query)) {
        recorder.bootstrap += 1
        return
      }
      recorder.queries += 1
    },
  })
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  return sorted[Math.max(0, index)]!
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits))
}

function formatTable(samples: Sample[], key: (sample: Sample) => string): string[] {
  const groups = new Map<string, Sample[]>()
  for (const sample of samples) {
    const group = key(sample)
    groups.set(group, [...(groups.get(group) ?? []), sample])
  }
  const lines = ['| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |', '| --- | --- | --- | --- | --- | --- |']
  for (const [group, entries] of groups) {
    const times = entries.map(entry => entry.ms)
    const queries = [...new Set(entries.map(entry => entry.queries))].sort((left, right) => left - right)
    lines.push(
      `| ${group} | ${queries.join(' / ')} | ${round(percentile(times, 0.5))} | ${round(percentile(times, 0.95))} | ${round(Math.max(...times))} | ${entries.length} |`,
    )
  }
  return lines
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const throwaway: ThrowawayDatabase = await createThrowawayDatabase({
    namePrefix: 'dsh_work_t5_stats_bench',
    maxConnections: Math.max(12, options.concurrency + 4),
  })
  const recorder = new Recorder()
  const database = createCountingClient(throwaway.url, Math.max(12, options.concurrency + 4), recorder)

  try {
    const authorization = new PostgresAuthorizationService(database)
    const conversations = new PostgresConversationRepository(database)
    const content = new PostgresContentService(database, '/tmp/dsh-work-t5-bench-storage', authorization)

    const seeded = await seed(throwaway.client, options)
    const volumes = await measureVolumes(throwaway.client)

    const memberIds = seeded.actorIds
    const actor = memberIds[0]!

    // 冷启动：每个目标先各测一次（授权缓存为空）。
    const cold: Sample[] = []
    const record = async (group: string, label: string, call: () => Promise<unknown>) => {
      const snapshot = recorder.samples.length
      await recorder.measure(group, label, call)
      cold.push(recorder.samples[snapshot]!)
    }

    await record('冷启动', 'listWorkspaces（可见空间统计）', () => content.listWorkspaces(memberIds[0]!))
    await record('冷启动', 'listWorkspaces（另一成员）', () => content.listWorkspaces(memberIds[1]!))
    await record('冷启动', 'listWorkspaceSessions 首页', () => conversations.listWorkspaceSessions({
      workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20,
    }))
    await record('冷启动', 'listWorkspaceFiles 首页', () => content.listWorkspaceFiles({
      workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20,
    }))
    await record('冷启动', 'listArtifacts（无成果）', () => content.listArtifacts(actor))

    // 热路径：同一调用重复测，取分位数。
    const rounds = 20
    for (let round = 0; round < rounds; round += 1) {
      await recorder.measure('热路径', 'listWorkspaces（可见空间统计）', () => content.listWorkspaces(actor))
      await recorder.measure('热路径', 'listWorkspaceSessions 首页', () => conversations.listWorkspaceSessions({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20,
      }))
      await recorder.measure('热路径', 'listWorkspaceSessions 深翻页', () => conversations.listWorkspaceSessions({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20, cursor: seeded.deepCursor,
      }))
      await recorder.measure('热路径', 'listWorkspaceSessions 标题搜索', () => conversations.listWorkspaceSessions({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20, query: '热点',
      }))
      await recorder.measure('热路径', 'listWorkspaceFiles 首页', () => content.listWorkspaceFiles({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20,
      }))
      await recorder.measure('热路径', 'listWorkspaceFiles 深翻页', () => content.listWorkspaceFiles({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20, cursor: seeded.fileCursor,
      }))
      await recorder.measure('热路径', 'listWorkspaceFiles 名称搜索', () => content.listWorkspaceFiles({
        workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20, query: '报表',
      }))
      await recorder.measure('热路径', 'listArtifacts（无成果）', () => content.listArtifacts(actor))
    }

    // 并发：同一成员的混合读取，观察 p95 是否随并发劣化。
    const concurrent: Sample[] = []
    await recorder.measure('并发', `并发 ${options.concurrency} 路混合读取`, async () => {
      await Promise.all(Array.from({ length: options.concurrency }, async (_value, index) => {
        switch (index % 4) {
          case 0: return content.listWorkspaces(actor)
          case 1: return conversations.listWorkspaceSessions({ workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20 })
          case 2: return content.listWorkspaceFiles({ workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20 })
          default: return conversations.listWorkspaceSessions({ workspaceId: seeded.workspaceId, actorUserId: actor, limit: 20, query: '热点' })
        }
      }))
    })
    concurrent.push(recorder.samples[recorder.samples.length - 1]!)

    // listArtifacts 的 N+1 复核：给一个成员造 N 条成果，测查询次数随行数的变化。
    // 成果列表：同一批数据上对比「当前实现（按空间去重复核）」与「逐行门禁候选实现」。
    // 两者都用可提交的代码表达，因此该对比可由任何人复跑，不依赖评审口述的历史实现。
    const artifactRows = await seedArtifacts(throwaway.client, seeded, options.sessions)
    const artifactSamples: Sample[] = []
    await recorder.measure('成果列表', `当前实现：按空间去重复核（${artifactRows} 条，冷）`, () => content.listArtifacts(actor))
    artifactSamples.push(recorder.samples[recorder.samples.length - 1]!)
    await recorder.measure('成果列表', `当前实现：按空间去重复核（${artifactRows} 条，热）`, () => content.listArtifacts(actor))
    artifactSamples.push(recorder.samples[recorder.samples.length - 1]!)
    await recorder.measure('成果列表', `候选实现：逐行门禁（${artifactRows} 条，冷）`, () => listArtifactsWithPerRowGate(database, actor))
    artifactSamples.push(recorder.samples[recorder.samples.length - 1]!)
    await recorder.measure('成果列表', `候选实现：逐行门禁（${artifactRows} 条，热）`, () => listArtifactsWithPerRowGate(database, actor))
    artifactSamples.push(recorder.samples[recorder.samples.length - 1]!)

    // 个人空间：确认可见范围过滤对个人成果不产生额外语句。
    const personalActor = seeded.personalActorId
    const personalArtifactRows = await seedPersonalArtifacts(throwaway.client, personalActor, 10)
    const personalSamples: Sample[] = []
    await recorder.measure('成果列表', `个人空间成果（${personalArtifactRows} 条）`, () => content.listArtifacts(personalActor))
    personalSamples.push(recorder.samples[recorder.samples.length - 1]!)

    // 计划在成果数据就位后采集：成果列表的计划必须在有行时取，否则规划器会选嵌套循环、
    // 无法反映真实行数下的形态。
    const plans = await explainPlans(throwaway.client, seeded)

    const report = renderReport({
      options, volumes, plans, cold, hot: recorder.samples, concurrent,
      artifactSamples, personalSamples, artifactRows, visibleWorkspaces: seeded.visibleWorkspaces,
    })
    if (options.out) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(options.out, report, 'utf8')
      console.log(`报告已写入 ${options.out}`)
    } else {
      console.log(report)
    }
    await database.end()
  } finally {
    await throwaway.dispose()
  }
}

interface Seeded {
  workspaceId: string
  workspaceIds: string[]
  actorIds: string[]
  deepCursor: string | undefined
  fileCursor: string | undefined
  hotSessionId: string
  visibleWorkspaces: number
  personalActorId: string
}

async function seed(database: DatabaseClient, options: Options) {
  const suffix = randomUUID().slice(0, 8)
  const ownerId = `bench-owner-${suffix}`
  const actorIds = Array.from({ length: Math.max(2, options.actors) }, (_value, index) => `bench-actor-${index}-${suffix}`)
  const memberIds = Array.from({ length: options.members }, (_value, index) => `bench-member-${index}-${suffix}`)

  const users = [ownerId, ...actorIds, ...memberIds]
  for (const [index, userId] of users.entries()) {
    await database`
      insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
      values (${userId}, ${tenantId}, ${`directory:${userId}`}, ${`基线成员 ${index}`}, 'active', 'ai-hub', true)
      on conflict do nothing
    `
    await database`
      insert into user_roles (tenant_id, user_id, role_id, source_key)
      values (${tenantId}, ${userId}, 'role-employee', 'local') on conflict do nothing
    `
  }

  // 主团队空间：1 负责人 + 40 成员 + 200 会话 + 200 共享文件 + 一个 60 Run 的热点会话。
  const workspaceId = `ws-bench-main-${suffix}`
  const workspaceIds = [workspaceId]
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '基线团队空间', '性能基线', 'team', ${ownerId}, 'active')
  `
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, ${ownerId}, 'owner', ${ownerId})
  `
  for (const userId of [...actorIds, ...memberIds]) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${userId}, 'member', ${ownerId}) on conflict do nothing
    `
  }

  // 若干额外团队空间，压 listWorkspaces 的按空间子查询（成员名册 + 文件）。
  for (let index = 1; index < options.spaces; index += 1) {
    const extraId = `ws-bench-extra-${index}-${suffix}`
    workspaceIds.push(extraId)
    await database`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${extraId}, ${tenantId}, ${`基线空间 ${index}`}, '', 'team', ${ownerId}, 'active')
    `
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${extraId}, ${ownerId}, 'owner', ${ownerId})
    `
    for (const userId of actorIds) {
      await database`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${extraId}, ${userId}, 'member', ${ownerId}) on conflict do nothing
      `
    }
    for (let file = 0; file < Math.ceil(options.files / options.spaces); file += 1) {
      await database`
        insert into file_objects (
          id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
          size_bytes, sha256, scan_status, uploaded_by, created_at
        ) values (
          ${`file-extra-${index}-${file}-${suffix}`}, ${tenantId}, ${extraId}, null,
          ${`storage/extra-${index}-${file}`}, ${`空间${index}文件${file}.txt`}, 'text/plain',
          1024, ${'a'.repeat(64)}, 'clean', ${ownerId}, ${new Date(Date.now() - file * 1000).toISOString()}
        )
      `
    }
  }

  // 会话：大部分属于各成员，另有「热点」会话承载 >50 Run。
  const createdAtBase = Date.now() - options.sessions * 60_000
  for (let index = 0; index < options.sessions; index += 1) {
    const owner = index % 7 === 0 ? actorIds[0]! : memberIds[index % memberIds.length]!
    const title = index % 11 === 0 ? `热点巡检 ${index}` : `基线会话 ${index}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at)
      values (
        ${`session-bench-${index}-${suffix}`}, ${tenantId}, ${workspaceId}, ${owner}, ${agentVersionId},
        ${title}, 'active', ${new Date(createdAtBase + index * 60_000).toISOString()}
      )
    `
  }

  const hotSessionId = `session-bench-hot-${suffix}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at)
    values (${hotSessionId}, ${tenantId}, ${workspaceId}, ${actorIds[0]!}, ${agentVersionId}, '热点长会话', 'active', now())
  `
  for (let index = 0; index < options.runs; index += 1) {
    const runId = `run-bench-hot-${index}-${suffix}`
    const attemptId = `${runId}-attempt`
    await database.begin(async transaction => {
      await transaction`
        insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id, created_at)
        values (${runId}, ${tenantId}, ${hotSessionId}, ${actorIds[0]!}, ${`idem-${runId}`}, 'succeeded', ${attemptId},
                ${new Date(createdAtBase + index * 1000).toISOString()})
      `
      await transaction`
        insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
        values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${transaction.json({})}, 'x', ${transaction.json({})}, 'succeeded')
      `
    })
  }

  // 共享文件（session_id 为空），时间递增以便游标翻页。
  for (let index = 0; index < options.files; index += 1) {
    const name = index % 9 === 0 ? `月度报表 ${index}.xlsx` : `基线文件 ${index}.txt`
    await database`
      insert into file_objects (
        id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status, uploaded_by, created_at
      ) values (
        ${`file-bench-${index}-${suffix}`}, ${tenantId}, ${workspaceId}, null,
        ${`storage/bench-${index}`}, ${name}, 'application/octet-stream',
        2048, ${'a'.repeat(64)}, 'clean', ${memberIds[index % memberIds.length]!},
        ${new Date(createdAtBase + index * 60_000).toISOString()}
      )
    `
  }

  // 游标固定在中间位置，用于「深翻页」测量。
  const [sessionCursorRow] = await database<{ id: string; lastActiveAt: Date }[]>`
    select id, last_active_at as "lastActiveAt" from sessions
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by last_active_at desc, id desc offset ${Math.floor(options.sessions / 2)} limit 1
  `
  const [fileCursorRow] = await database<{ id: string; createdAt: Date }[]>`
    select id, created_at as "createdAt" from file_objects
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and session_id is null
     order by created_at desc, id desc offset ${Math.floor(options.files / 2)} limit 1
  `

  return {
    workspaceId,
    workspaceIds,
    actorIds,
    hotSessionId,
    // 可见空间数 = 若干团队空间 + 调用者自动获得的个人空间（0013 触发器建立）。
    visibleWorkspaces: workspaceIds.length + 1,
    personalActorId: actorIds[0]!,
    deepCursor: sessionCursorRow ? encodeCursor('at', sessionCursorRow.lastActiveAt, sessionCursorRow.id) : undefined,
    fileCursor: fileCursorRow ? encodeCursor('at', fileCursorRow.createdAt, fileCursorRow.id) : undefined,
  } satisfies Seeded
}

/** 与实现一致的 keyset 游标编码（复用产品实现的口径，避免手写格式漂移）。 */
function encodeCursor(key: string, at: Date, id: string) {
  return Buffer.from(JSON.stringify({ [key]: at.toISOString(), id })).toString('base64url')
}

/** 游标解码（与 encodeCursor 对称），供计划测量复用同一游标。 */
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return { at: new Date(0), id: '' }
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at: string; id: string }
  return { at: new Date(parsed.at), id: parsed.id }
}

/**
 * 候选实现：对每个成果行单独做一次可见范围门禁（T4 修复前的形态）。
 * 仅用于测量对照；它不复用 `PostgresContentService`，因为它要刻意表达「不做去重」
 * 的那一版实现，从而让「按空间去重复核」的收益可被任何人复跑验证。
 */
async function listArtifactsWithPerRowGate(database: DatabaseClient, actorUserId: string) {
  const authorization = new PostgresAuthorizationService(database)
  const rows = await database<{ id: string; workspaceId: string }[]>`
    select a.id, a.workspace_id as "workspaceId"
      from artifacts a
      join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
      join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
     where a.tenant_id = ${tenantId} and s.created_by = ${actorUserId}
     order by av.created_at desc
  `
  const visible: typeof rows = []
  for (const row of rows) {
    if (await canReadWorkspaceObject(authorization, row.workspaceId, actorUserId)) visible.push(row)
  }
  return visible
}

/** 在成员的个人空间里造 N 条成果，确认可见范围过滤对个人成果不产生额外语句。 */
async function seedPersonalArtifacts(database: DatabaseClient, actorUserId: string, count: number) {
  const [workspace] = await database<{ id: string }[]>`
    select id from workspaces
     where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${actorUserId}
     limit 1
  `
  if (!workspace) throw new Error(`个人空间未建立：${actorUserId}`)
  for (let index = 0; index < count; index += 1) {
    const sessionId = `session-personal-${index}`
    const runId = `run-personal-${index}`
    const attemptId = `${runId}-attempt`
    const fileId = `file-personal-${index}`
    const artifactId = `artifact-personal-${index}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at)
      values (${sessionId}, ${tenantId}, ${workspace.id}, ${actorUserId}, ${agentVersionId}, ${`个人成果会话 ${index}`}, 'active', now())
    `
    await database.begin(async transaction => {
      await transaction`
        insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
        values (${runId}, ${tenantId}, ${sessionId}, ${actorUserId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
      `
      await transaction`
        insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
        values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${transaction.json({})}, 'x', ${transaction.json({})}, 'succeeded')
      `
    })
    await database`
      insert into file_objects (
        id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status, uploaded_by
      ) values (
        ${fileId}, ${tenantId}, ${workspace.id}, ${sessionId}, ${`storage/${fileId}`}, ${`个人成果 ${index}.txt`},
        'text/plain', 1024, ${'a'.repeat(64)}, 'clean', ${actorUserId}
      )
    `
    await database`
      insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
      values (${artifactId}, ${tenantId}, ${workspace.id}, ${sessionId}, ${`个人成果 ${index}`}, 'text', ${actorUserId})
    `
    await database`
      insert into artifact_versions (id, tenant_id, artifact_id, version_no, file_object_id, source_run_id, created_at)
      values (${`${artifactId}-v1`}, ${tenantId}, ${artifactId}, 1, ${fileId}, ${runId}, now())
    `
  }
  return count
}

/** 给测量视角成员补 N 条成果，用于复核 listArtifacts 的查询次数。 */
async function seedArtifacts(database: DatabaseClient, seeded: Seeded, count: number) {
  const actor = seeded.actorIds[0]!
  const createdAtBase = Date.now() - count * 60_000
  for (let index = 0; index < count; index += 1) {
    const sessionId = `session-artifact-${index}`
    const runId = `run-artifact-${index}`
    const attemptId = `${runId}-attempt`
    const fileId = `file-artifact-${index}`
    const artifactId = `artifact-bench-${index}`
    await database`
      insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status, last_active_at)
      values (${sessionId}, ${tenantId}, ${seeded.workspaceId}, ${actor}, ${agentVersionId}, ${`成果会话 ${index}`}, 'active', now())
    `
    await database.begin(async transaction => {
      await transaction`
        insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
        values (${runId}, ${tenantId}, ${sessionId}, ${actor}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
      `
      await transaction`
        insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
        values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${transaction.json({})}, 'x', ${transaction.json({})}, 'succeeded')
      `
    })
    await database`
      insert into file_objects (
        id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status, uploaded_by, created_at
      ) values (
        ${fileId}, ${tenantId}, ${seeded.workspaceId}, ${sessionId}, ${`storage/${fileId}`}, ${`成果 ${index}.txt`},
        'text/plain', 1024, ${'a'.repeat(64)}, 'clean', ${actor}, ${new Date(createdAtBase + index * 60_000).toISOString()}
      )
    `
    await database`
      insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
      values (${artifactId}, ${tenantId}, ${seeded.workspaceId}, ${sessionId}, ${`成果 ${index}`}, 'text', ${actor})
    `
    await database`
      insert into artifact_versions (id, tenant_id, artifact_id, version_no, file_object_id, source_run_id, created_at)
      values (${`${artifactId}-v1`}, ${tenantId}, ${artifactId}, 1, ${fileId}, ${runId}, ${new Date(createdAtBase + index * 60_000).toISOString()})
    `
  }
  return count
}

async function measureVolumes(database: DatabaseClient) {
  const [row] = await database<{
    workspaces: number
    members: number
    sessions: number
    runs: number
    files: number
    artifacts: number
    sessionBytes: string
    fileBytes: string
  }[]>`
    select
      (select count(*)::integer from workspaces where tenant_id = ${tenantId}) as workspaces,
      (select count(*)::integer from workspace_members where tenant_id = ${tenantId}) as members,
      (select count(*)::integer from sessions where tenant_id = ${tenantId}) as sessions,
      (select count(*)::integer from runs where tenant_id = ${tenantId}) as runs,
      (select count(*)::integer from file_objects where tenant_id = ${tenantId}) as files,
      (select count(*)::integer from artifacts where tenant_id = ${tenantId}) as artifacts,
      (select pg_size_pretty(pg_total_relation_size('sessions'))) as "sessionBytes",
      (select pg_size_pretty(pg_total_relation_size('file_objects'))) as "fileBytes"
  `
  return row!
}

/**
 * 关键查询的计划。直接执行与实现等价的 SQL（含参数），避免为测量去改产品代码；
 * 计划文本用于确认是否命中索引、是否出现顺序扫描或嵌套循环放大。
 */
async function explainPlans(database: DatabaseClient, seeded: Seeded) {
  const actor = seeded.actorIds[0]!
  const plans: Array<{ label: string; plan: string }> = []

  const capture = async (label: string, query: ReturnType<DatabaseClient>) => {
    const rows = await database<{ 'QUERY PLAN': string }[]>`explain (analyze, buffers) ${query}`
    plans.push({ label, plan: rows.map(row => row['QUERY PLAN']).join('\n') })
  }

  await capture(
    'listWorkspaces 主查询（可见空间 + 成员/会话/成果计数 + updatedAt 排序）',
    database`
      select w.id, count(distinct wm.user_id)::integer as "memberCount",
             count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount",
             greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w
        join users creator on creator.tenant_id = w.tenant_id and creator.id = w.created_by
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
       where w.tenant_id = ${tenantId} and w.status = 'active'
         and (
           (w.workspace_type = 'personal' and w.created_by = ${actor})
           or (w.workspace_type = 'team' and exists (
             select 1 from workspace_members access
              where access.tenant_id = w.tenant_id and access.workspace_id = w.id and access.user_id = ${actor}
           ))
         )
       group by w.id, creator.display_name
       order by "updatedAt" desc
    `,
  )

  await capture(
    'listWorkspaceSessions 首页（与实现同形：本人范围 + 状态过滤 + 最新 Run 侧连接 + Run 计数）',
    database`
      select s.id as "sessionId", s.title,
             s.created_by as "creatorId", u.display_name as "creatorName",
             s.last_active_at as "lastActiveAt",
             (select count(*)::integer from runs r
               where r.tenant_id = s.tenant_id and r.session_id = s.id) as "runCount",
             latest.id as "latestRunId", latest.status as "latestRunStatus"
        from sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
        left join lateral (
          select r.id, r.status from runs r
           where r.tenant_id = s.tenant_id and r.session_id = s.id
           order by r.created_at desc, r.id desc limit 1
        ) latest on true
       where s.tenant_id = ${tenantId} and s.workspace_id = ${seeded.workspaceId}
         and s.status = 'active' and s.created_by = ${actor}
       order by s.last_active_at desc, s.id desc
       limit 21
    `,
  )

  await capture(
    `listWorkspaceSessions 深翻页（数据量中点处的 keyset 游标）`,
    database`
      select s.id, s.title, s.last_active_at as "lastActiveAt"
        from sessions s
       where s.tenant_id = ${tenantId} and s.workspace_id = ${seeded.workspaceId}
         and s.created_by = ${actor}
         and (s.last_active_at, s.id) < (${decodeCursor(seeded.deepCursor).at}::timestamptz, ${decodeCursor(seeded.deepCursor).id})
       order by s.last_active_at desc, s.id desc
       limit 21
    `,
  )

  await capture(
    'listWorkspaceFiles 首页（共享文件 + 游标）',
    database`
      select f.id, f.original_name as "originalName", f.created_at as "createdAt"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where f.tenant_id = ${tenantId} and f.workspace_id = ${seeded.workspaceId}
         and f.session_id is null and f.removed_at is null and f.scan_status <> 'blocked'
       order by f.created_at desc, f.id desc
       limit 21
    `,
  )

  await capture(
    'listArtifacts（按作者 + 空间类型，用于可见范围过滤）',
    database`
      select a.id, a.workspace_id as "workspaceId", av.version_no as version,
             w.workspace_type as "workspaceType"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
        left join workspaces w on w.tenant_id = a.tenant_id and w.id = a.workspace_id
       where a.tenant_id = ${tenantId} and s.created_by = ${actor}
       order by av.created_at desc
    `,
  )

  return plans
}

function renderReport(input: {
  options: Options
  volumes: Record<string, string | number>
  plans: Array<{ label: string; plan: string }>
  cold: Sample[]
  hot: Sample[]
  concurrent: Sample[]
  artifactSamples: Sample[]
  personalSamples: Sample[]
  artifactRows: number
  visibleWorkspaces: number
}) {
  const { options, volumes, plans, cold, hot, concurrent, artifactSamples, personalSamples, artifactRows, visibleWorkspaces } = input
  const lines: string[] = []
  lines.push('# 1B-T5 团队可见统计性能基线')
  lines.push('')
  lines.push(`**生成时间：** ${new Date().toISOString()}`)
  lines.push(`**数据规模参数：** 成员 ${options.members} · 会话 ${options.sessions} · 共享文件 ${options.files} · 热点会话 Run ${options.runs} · 团队空间 ${options.spaces}（**含个人空间共 ${visibleWorkspaces} 个可见空间**）· 测量视角成员 ${options.actors} · 并发 ${options.concurrency}`)
  lines.push('')
  lines.push('> 本文件由 `scripts/bench/team-workspace-statistics.ts` 在一次性库上生成；')
  lines.push('> 复跑：`DSH_WORK_TEST_DATABASE_URL=… pnpm bench:team-workspace-statistics --members=40 --sessions=200 --files=200 --spaces=5 --runs=60 --concurrency=10 --out docs/baselines/team-workspace-1b-statistics.md`。')
  lines.push('> 绝对延迟随机器变化，应关注**往返次数**、**相对量级**与**随数据量的增长趋势**。')
  lines.push('')
  lines.push('## 1. 实际数据量')
  lines.push('')
  lines.push('| 对象 | 行数 |')
  lines.push('| --- | --- |')
  for (const [key, value] of Object.entries(volumes)) {
    lines.push(`| ${key} | ${value} |`)
  }
  lines.push('')
  lines.push('## 2. 冷启动（授权缓存为空，各 1 次）')
  lines.push('')
  lines.push(...formatTable(cold, sample => sample.label))
  lines.push('')
  lines.push('## 3. 热路径（20 轮）')
  lines.push('')
  lines.push(...formatTable(hot.filter(sample => sample.group === '热路径'), sample => sample.label))
  lines.push('')
  lines.push('## 4. 并发')
  lines.push('')
  lines.push(...formatTable(concurrent, sample => sample.label))
  lines.push('')
  lines.push('## 5. listArtifacts 可见范围过滤（N+1 复核，同一批数据上的 A/B）')
  lines.push('')
  lines.push(`在测量视角成员名下造 ${artifactRows} 条团队成果后，对比两种实现形态：`)
  lines.push('')
  lines.push(...formatTable(artifactSamples, sample => sample.label))
  lines.push('')
  lines.push(`个人空间成果（同一成员的个人空间，10 条）：`)
  lines.push('')
  lines.push(...formatTable(personalSamples, sample => sample.label))
  lines.push('')
  lines.push('## 6. 关键查询计划')
  lines.push('')
  for (const { label, plan } of plans) {
    lines.push(`### ${label}`)
    lines.push('')
    lines.push('```')
    lines.push(plan)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

await main()
