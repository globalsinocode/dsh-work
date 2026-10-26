import { randomUUID } from 'node:crypto'

import { archivistRunPrompt, parseArchivistOutput } from '../../../domain/project-archive.ts'
import { sha256 } from '../../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../../runtime/runtime-types.ts'
import type { ArchiveUpdate } from '../../workbench/application/postgres-project-archive-service.ts'
import type { RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import { runtimeId, tenantId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** 档案员运行：不带工具，输出一份 JSON 条目列表，时长受限。 */
const archivistLimits = { timeout_seconds: 120, max_output_bytes: 32_768, max_tool_calls: 0 }

/**
 * 项目空间 S2（docs/design/project-space-plan.md 第 7 节）：项目档案员。
 * 项目任务完成后由平台触发，每个空间同一时间只有一次整理；经 dispatcher → scheduler →
 * Runtime Adapter → DSH 执行一次 `project-archive` Run。与会话摘要一样不建 Session、
 * 不带工具与数据范围，输出不成为对话消息；成功时由平台校验后写入新档案版本。
 */
export class ProjectArchiveEntry {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher
  private readonly budget: AttemptBudget

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher, budget: AttemptBudget) {
    this.deps = deps
    this.dispatcher = dispatcher
    this.budget = budget
  }

  /** Agent 任务线程的一次执行成功后调用；不抛错。 */
  async afterTaskRun(run: RunRecord, output: string): Promise<void> {
    const archive = this.deps.projectArchive
    if (!archive || !run.sessionId) return
    try {
      const workspaceId = await archive.recordAgentTaskResult(run, output)
      if (workspaceId) await this.schedule(workspaceId, run.requestedBy)
    } catch (error) {
      console.warn('project archive input was not recorded', run.id, error instanceof Error ? error.message : error)
    }
  }

  /** 有待整理成果且空间空闲时发起一次整理；不抛错。 */
  async schedule(workspaceId: string, requestedBy: string): Promise<void> {
    const archive = this.deps.projectArchive
    if (!archive) return
    try {
      const update = await archive.beginArchiveUpdate(workspaceId)
      if (!update) return
      try {
        const run = await this.deps.runs.createRun({
          tenantId,
          sessionId: null,
          workspaceId,
          requestedBy,
          idempotencyKey: update.updateId,
          taskSourceType: 'system',
          taskSourceRef: `project-archive:${workspaceId}`,
          taskCorrelationKey: update.updateId,
          taskRequestDigest: sha256(JSON.stringify(['project-archive/v1', workspaceId, update.updateId, update.baseVersionNo])),
        })
        // 认领关联与派发同属“未派发 Run”的保护范围：任一失败都收敛该 Run，避免留下孤儿 queued Run。
        await this.dispatcher.failUndispatchedRun(run, async () => {
          await archive.attachArchiveUpdateRun(update.updateId, run.id)
          await this.dispatch(run, update)
        })
      } catch (error) {
        await archive.abandonArchiveUpdate(update.updateId)
        throw error
      }
    } catch (error) {
      console.warn('project archive update was not started', workspaceId, error instanceof Error ? error.message : error)
    }
  }

  /** 无 Session 的 Run 结束时调用；返回 false 表示不是档案整理运行。 */
  async onRunTerminal(run: RunRecord, status: 'succeeded' | 'failed' | 'cancelled', output: string): Promise<boolean> {
    const archive = this.deps.projectArchive
    if (!archive || run.sessionId) return false
    const parsed = status === 'succeeded' ? parseArchivistOutput(output) : { error: `archivist run ${status}` }
    const result = await archive.finishArchiveUpdate(run.id, 'error' in parsed ? { failure: parsed.error } : parsed)
    if (!result.handled) return false
    if (result.reschedule && result.workspaceId) void this.schedule(result.workspaceId, run.requestedBy)
    return true
  }

  private async dispatch(run: RunRecord, update: ArchiveUpdate) {
    const prompt = archivistRunPrompt({ brief: update.brief, items: update.items, materials: update.materials })
    const route = await this.deps.models.resolveRoute('default')
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const limits = {
      ...archivistLimits,
      timeout_seconds: Math.min(archivistLimits.timeout_seconds, runtimePolicy?.timeoutSeconds ?? archivistLimits.timeout_seconds),
    }
    const manifest: RuntimeManifest = {
      manifest_version: '1.0',
      purpose: 'project-archive',
      archive_target: { workspace_id: update.workspaceId, update_id: update.updateId },
      run_id: run.id,
      attempt_id: `attempt-${randomUUID()}`,
      task_id: run.taskId,
      session_id: null,
      workspace_id: '',
      agent_version_id: null,
      // feature-rules 第 12 条：系统运行同样按平台时区理解“今天/本周”。
      timezone: this.deps.timezone,
      agent_configuration: { system_prompt: prompt.systemPrompt, skill_instructions: [] },
      user_context: { user_id: run.requestedBy, tenant_id: tenantId, role_ids: [] },
      principal_context: await this.dispatcher.principalContextForRun(run, `principal-system-${tenantId}`, 1),
      permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'deny' },
      skills: [],
      tools: [],
      data_scopes: [],
      knowledge_context: [],
      model_route_id: route.routeId,
      input: { message: prompt.message, file_mounts: [] },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(),
      trace_id: `trace-${run.id}-archive`,
    }
    await this.dispatcher.submit(run, manifest, route)
  }
}
