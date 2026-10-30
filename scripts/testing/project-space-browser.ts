/**
 * P1 项目空间浏览器夹具（PS-E2E-03/04/06/07/08）。
 *
 * 专用可丢弃 PostgreSQL + 真实 HTTP API；Runtime 是确定性合成实现，
 * 不连接 OIDC、模型、MCP 或真实 DSH。档案整理运行返回固定的 JSON 整理结果，
 * 用于验证“任务完成 → 档案员整理 → 档案版本更新”的平台链路，不证明真实模型质量。
 */
import { randomUUID } from 'node:crypto'

import { envelope } from '../../server/src/http/router.ts'
import { PostgresAgentAccessService } from '../../server/src/modules/agent/agent-access-service.ts'
import { personalWorkbenchFixture, testTenant } from '../../server/src/infrastructure/postgres/personal-workbench-test-fixture.ts'
import { PersonalBrowserRuntime } from '../../server/src/infrastructure/postgres/personal-browser-runtime.ts'
import { publishDraftWithSealedTrial } from '../../server/src/infrastructure/postgres/test-release-fixture.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../server/src/modules/runtime/runtime-types.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4394)
// 档案条目按本次整理的任务标题生成：用例标题带随机后缀，重跑时条目不重复，
// 断言也不会被上一次运行留下的同名条目“提前满足”。
const archivedItemPrefix = 'P1 归档：'

/** 从档案员输入中取出本批任务标题（archivistRunPrompt 的“新完成的任务成果”JSON）。 */
function archivedItemsFor(manifest: RuntimeManifest): string[] {
  const message = manifest.input.message
  const marker = '新完成的任务成果（JSON，按完成顺序）：\n'
  const start = message.indexOf(marker)
  if (start < 0) return []
  try {
    const materials = JSON.parse(message.slice(start + marker.length)) as Array<{ task?: unknown }>
    return materials
      .map(material => typeof material.task === 'string' ? `${archivedItemPrefix}${material.task}已完成` : '')
      .filter(Boolean)
  } catch {
    return []
  }
}

interface ArchiveExecution {
  snapshot: RuntimeExecutionSnapshot
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
}

/** 普通运行交给合成 Runtime；档案整理运行返回可解析的整理结果。 */
class ProjectSpaceBrowserRuntime implements AgentRuntimePort {
  readonly base = new PersonalBrowserRuntime()
  private readonly archives = new Map<string, ArchiveExecution>()

  async execute(manifest: RuntimeManifest) {
    if (manifest.purpose !== 'project-archive') return this.base.execute(manifest)
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued',
      acceptedAt: new Date().toISOString(), startedAt: null, endedAt: null,
      manifestSha256: 'synthetic-p1-archive', attemptDirectory: '/test-only',
      errorCode: null, errorMessage: null,
    }
    const state: ArchiveExecution = { snapshot, events: [], listeners: new Set() }
    this.archives.set(manifest.run_id, state)
    const emit = (eventType: RuntimeEvent['event_type'], message: string, safeMetadata: Record<string, unknown> = {}) => {
      const event: RuntimeEvent = {
        event_id: randomUUID(), run_id: manifest.run_id, attempt_id: manifest.attempt_id,
        sequence: state.events.length + 1, event_type: eventType, display_message: message,
        safe_metadata: { synthetic: true, ...safeMetadata }, occurred_at: new Date().toISOString(),
        trace_id: `trace-${manifest.run_id}`, parent_event_id: null,
      }
      state.events.push(event)
      state.listeners.forEach(listener => listener(event))
    }
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => {
      setImmediate(() => {
        emit('run.started', 'P1 档案整理开始')
        emit('assistant.completed', `\`\`\`json\n${JSON.stringify({ add: archivedItemsFor(manifest) })}\n\`\`\``)
        snapshot.status = 'completed'
        snapshot.startedAt = new Date().toISOString()
        snapshot.endedAt = new Date().toISOString()
        emit('run.completed', 'P1 档案整理完成')
        resolve(structuredClone(snapshot))
      })
    })
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: snapshot.acceptedAt, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const archive = this.archives.get(runId)
    if (!archive) return this.base.subscribe(runId, listener)
    archive.events.forEach(listener)
    archive.listeners.add(listener)
    return () => archive.listeners.delete(listener)
  }

  status(runId: string) {
    return this.archives.get(runId)?.snapshot ?? this.base.status(runId)
  }

  async cancel(runId: string) {
    const archive = this.archives.get(runId)
    if (!archive) return this.base.cancel(runId)
    if (!['queued', 'running'].includes(archive.snapshot.status)) return { accepted: false }
    archive.snapshot.status = 'cancelled'
    archive.snapshot.endedAt = new Date().toISOString()
    return { accepted: true }
  }

  async health() {
    return this.base.health()
  }

  async close() {
    this.archives.clear()
    await this.base.close()
  }
}

const runtime = new ProjectSpaceBrowserRuntime()
const fixture = await personalWorkbenchFixture('dsh_ps_p1_browser', {
  port,
  runtime,
  browser: true,
  projectSpace: true,
})

// MODE-E2E-16：带 `P1-成果达成` 的执行登记一个文本成果（含 source_attempt_id），对应真实 Adapter
// 在 run.completed 前登记成果；成果名带 runId，重跑与多次执行时可区分。
runtime.base.hooks.registerArtifact = async manifest => {
  if (!manifest.session_id) throw new Error('P1 成果登记需要会话内的 Attempt')
  const name = `P1-任务成果-${manifest.run_id.slice(-6)}.txt`
  const file = await fixture.content.storeSessionFile(
    manifest.session_id, name, 'text/plain',
    Buffer.from(`P1 registered artifact, not a real DSH output: ${manifest.input.message}`), manifest.user_context.user_id,
  )
  const artifact = `artifact-${randomUUID()}`
  await fixture.db.client`insert into artifacts(id,tenant_id,workspace_id,session_id,name,artifact_type,created_by)
    values(${artifact},${testTenant},${manifest.workspace_id},${manifest.session_id},${name},'text',${manifest.user_context.user_id})`
  await fixture.db.client`insert into artifact_versions(id,tenant_id,artifact_id,version_no,file_object_id,source_run_id,source_attempt_id)
    values(${randomUUID()},${testTenant},${artifact},1,${file.id},${manifest.run_id},${manifest.attempt_id})`
}

const { db, content, agents } = fixture
const projects = fixture.projects!
const lifecycle = fixture.lifecycle!
const workspaceAgentMembers = fixture.workspaceAgentMembers!
const database = db.client
const tenantId = testTenant

// 三个测试身份：负责人、成员、只读成员。
for (const [id, name, subject] of [
  ['U00002', '周衡', 'bootstrap:p1-member'],
  ['U00003', '苏晚', 'bootstrap:p1-viewer'],
] as const) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, department_id, status)
    values (${id}, ${tenantId}, ${subject}, ${name}, 'supply-chain', 'active')
    on conflict (tenant_id, id) do nothing
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id)
    values (${tenantId}, ${id}, 'role-employee')
    on conflict do nothing
  `
}

const workspace = await content.createWorkspace({ name: 'P1 项目空间', description: 'P1 浏览器夹具' }, 'U00001')
if (!workspace) throw new Error('无法创建 P1 项目空间')
await database`
  insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
  values (${tenantId}, ${workspace.id}, 'U00002', 'member', 'U00001'),
         (${tenantId}, ${workspace.id}, 'U00003', 'viewer', 'U00001')
  on conflict do nothing
`
await projects.saveBrief(workspace.id, 'U00001', {
  content: 'P1 项目简报：关注供应商交付风险与安全库存。',
  dueDate: '2026-12-31',
})
await content.storeWorkspaceFile(
  workspace.id, 'P1-共享文件.txt', 'text/plain',
  Buffer.from('P1 synthetic shared file'), 'U00001',
)
// 活跃空间的一条员工任务：只读成员能看到列表，但没有任何写入口。
const ownerTask = await projects.createTask(workspace.id, 'U00001', {
  title: 'P1 活跃空间任务', description: '只读成员只读', assignee: { type: 'employee', id: 'U00001' },
  inputFileIds: [], dueDate: null,
})

const created = await agents.createAgent({  id: 'agent-ps-p1',
  name: '项目空间助手',
  description: 'P1 夹具 Agent',
  owner: '平台管理员',
  department: 'platform',
  welcomeMessage: '我可以整理任务进展。',
  examplePrompts: ['总结当前任务进展'],
  systemPrompt: '你是项目空间助手，只依据任务线程内容作答。',
  workInstructions: '',
  maxOutputBytes: 65536,
  maxToolCalls: 20,
  timeoutSeconds: 300,
  skills: [],
  mcpScope: { mode: 'none', connectorIds: [] },
  changeSummary: 'P1 项目空间夹具',
  actor: 'U00008',
  visibleRoleIds: ['role-employee'],
  executionRoleIds: [],
  executionDataScopes: [],
})
await publishDraftWithSealedTrial(database, agents, created.agent.id, 'U00008')
// 发布只改版本；「谁能用这个 Agent」由 Agent 级访问（agents.visible_role_ids）决定，
// 默认是空数组。加入空间前会按添加人角色复核可见性，因此夹具必须先授可见角色。
const agentAccess = new PostgresAgentAccessService(database)
const access = await agentAccess.getAccess(created.agent.id)
await agentAccess.updateAccess({
  agentId: created.agent.id,
  actor: 'U00008',
  expectedRevision: access.revision,
  visibleRoleIds: ['role-employee'],
  roleIds: access.roleIds,
  dataScopes: access.dataScopes,
})
const agentMember = await workspaceAgentMembers.addAgentMember(
  workspace.id, created.agent.id, 'U00001', ['role-employee'],
)

// 已归档空间：含一条员工任务，用于只读写入口验收。
const archived = await content.createWorkspace({ name: 'P1 已归档空间', description: 'P1 归档夹具' }, 'U00001')
if (!archived) throw new Error('无法创建 P1 归档空间')
await database`
  insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
  values (${tenantId}, ${archived.id}, 'U00003', 'viewer', 'U00001')
  on conflict do nothing
`
await projects.saveBrief(archived.id, 'U00001', { content: '归档前的简报。', dueDate: null })
const archivedTask = await projects.createTask(archived.id, 'U00001', {
  title: '归档前的任务', description: '只读保留', assignee: { type: 'employee', id: 'U00001' },
  inputFileIds: [], dueDate: null,
})
await lifecycle.archiveWorkspace(archived.id, 'U00001')

fixture.router.get('/api/workbench/v1/test/fixtures', () => envelope('workbench', {
  workspaceId: workspace.id,
  archivedWorkspaceId: archived.id,
  archivedTaskId: archivedTask.id,
  agentId: created.agent.id,
  agentMemberId: agentMember.id,
  ownerTaskId: ownerTask.id,
  archivedItemPrefix,
  synthetic: true,
}))

// S4（PS-E2E-08）：测试钩子，把任务的执行规则拨到“一分钟前”并立即跑一轮调度，模拟到点的定时执行。
// 仅本可丢弃夹具注册；生产没有此路由。
fixture.router.post('/api/workbench/v1/test/project-tasks/:taskId/fire-schedule', async (_request, context) => {
  const taskId = context.params['taskId'] ?? ''
  const slot = new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000)
  const [task] = await database<{ timezone: string }[]>`
    select schedule->>'timezone' as timezone from project_tasks where id = ${taskId} and schedule is not null
  `
  if (!task) return envelope('workbench', { fired: false })
  const timeOfDay = new Intl.DateTimeFormat('en-GB', {
    timeZone: task.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(slot)
  await database`
    update project_tasks
       set schedule = ${database.json({ kind: 'daily', timezone: task.timezone, timeOfDay })},
           schedule_state = 'active', schedule_reason = null, next_slot_utc = ${slot}
     where id = ${taskId}
  `
  await projects.processDueSchedules(new Date())
  return envelope('workbench', { fired: true })
})

console.log('P1 project space ready; throwaway PostgreSQL, synthetic Runtime, no OIDC/model.')
let closing = false
async function close() {
  if (closing) return
  closing = true
  await fixture.close()
  process.exit(0)
}
process.on('SIGINT', () => void close())
process.on('SIGTERM', () => void close())
