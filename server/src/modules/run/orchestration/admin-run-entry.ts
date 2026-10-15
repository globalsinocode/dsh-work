import { randomUUID } from 'node:crypto'

import { normalizeSkillTestScenario } from '../../../domain/skill-test-scenario.ts'
import type { RuntimeSkillConfiguration } from '../../skill/postgres-skill-service.ts'
import { isAdminRunPurpose } from '../../runtime/runtime-types.ts'
import type { AdminRunPurpose, RuntimeManifest } from '../../runtime/runtime-types.ts'
import { compileRuntimeManifest } from '../../runtime/manifest-compiler.ts'
import { normalizePersistedRuntimeManifest } from '../../runtime/runtime-manifest-compatibility.ts'
import { accessDenied, invalidRequest, stateConflict } from '../../../domain/request-errors.ts'
import type { AdminRunLauncher } from '../../skill/admin-run-launcher.ts'
import type { JsonObject, RunRecord } from '../run-types.ts'
import type { AttemptBudget } from './attempt-budget.ts'
import type { AttemptDispatcher } from './attempt-dispatcher.ts'
import type { AttemptScheduler } from './attempt-scheduler.ts'
import type { RunCancellation } from './run-cancellation.ts'
import { withContinuationOutputs } from './continuation.ts'
import { adminSystemPrompt, adminTools, assertPrompt, flattenSkillDependencies, toCapabilityReference, toRuntimeManifestSkill } from './manifest-helpers.ts'
import { tenantId, runtimeId, type OrchestrationDependencies } from './orchestration-dependencies.ts'

/** Entry point for admin assistant, Skill installation and Skill test Runs. */
export class AdminRunEntry implements AdminRunLauncher {
  private readonly deps: OrchestrationDependencies
  private readonly dispatcher: AttemptDispatcher
  private readonly scheduler: AttemptScheduler
  private readonly budget: AttemptBudget
  private readonly cancellation: RunCancellation

  constructor(deps: OrchestrationDependencies, dispatcher: AttemptDispatcher, scheduler: AttemptScheduler, budget: AttemptBudget, cancellation: RunCancellation) {
    this.deps = deps
    this.dispatcher = dispatcher
    this.scheduler = scheduler
    this.budget = budget
    this.cancellation = cancellation
  }

  async startAdminRun(input: { userId: string; sessionId: string; prompt: string; idempotencyKey: string; source: string; purpose?: AdminRunPurpose; testSkill?: RuntimeSkillConfiguration; history?: RuntimeManifest['input']['conversation_history'] }) {
    assertPrompt(input.prompt)
    const purpose = input.testSkill ? 'admin-skill-test' : input.purpose ?? 'admin-skill-install'
    if (purpose === 'admin-assistant') await this.deps.authorization?.requireAdminReader(input.userId)
    else await this.deps.authorization?.requirePlatformAdmin(input.userId)
    await this.deps.conversations.requireSession(input.sessionId, input.userId, 'admin')
    await this.deps.runtime.assertAvailable?.()
    const run = await this.deps.runs.createRun({ tenantId, sessionId: input.sessionId, requestedBy: input.userId, idempotencyKey: input.idempotencyKey })
    if (run.currentAttemptId || run.status !== 'queued') return run
    await this.deps.conversations.appendMessage({ sessionId: run.sessionId!, runId: run.id, role: 'user', content: input.prompt, messageId: `message-user-${run.id}` })
    await this.dispatcher.failUndispatchedRun(run, () => this.dispatchAdmin(run, input.prompt, input.source, purpose, input.testSkill, input.history))
    return (await this.deps.runs.getRun(tenantId, run.id))!
  }

  async cancelAdminRun(runId: string, userId: string) {
    const run = await this.requireAdminRun(runId, userId)
    if (run.status === 'waiting') {
      if (!this.deps.persistentWait) throw new Error('持久化等待服务未接线')
      await this.deps.persistentWait.cancelRun(run.id, userId)
      await this.deps.operations?.appendAudit(userId, 'run.wait.cancel', runId, 'success', `trace-${runId}`, '管理员取消等待中的审批')
      return this.deps.runs.getRun(tenantId, runId)
    }
    if (!['queued', 'running', 'cancel_requested'].includes(run.status)) return run
    const result = await this.deps.runtime.cancel(runId, userId)
    if (!result.accepted) return this.cancellation.convergeCancelledRun(runId, current => ({ attemptId: current.currentAttemptId!, displayMessage: '管理助手运行已取消', safeMetadata: { cause: 'user' } }))
    return this.deps.runs.getRun(tenantId, runId)
  }

  async retryAdminRun(runId: string, userId: string) {
    const run = await this.requireAdminRun(runId, userId)
    await this.deps.runtime.assertAvailable?.()
    if (!['failed', 'cancelled'].includes(run.status)) throw stateConflict('只有失败或已取消的运行可以重试')
    const attempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    if (!attempt) throw invalidRequest('管理助手运行缺少原始输入，请重新发送请求')
    const manifest = normalizePersistedRuntimeManifest(attempt.manifest as unknown as RuntimeManifest)
    // 试运行 Run 属于发布治理证据：失败应在工作台重新发起完整试运行（封存/案例/确认
    // 全链路），不能按管理助手语义单独重试——那会用 Skill 安装工具集重放治理输入。
    if (manifest.purpose === 'agent-release-trial') {
      throw invalidRequest('试运行不支持单独重试；请在发布工作台重新发起试运行')
    }
    if (manifest.purpose === 'admin-skill-test') {
      // Reuse the full immutable graph, tool allowlist and original input. The
      // root-only reconstruction dropped dependencies and mixed configurations.
      const retried: RuntimeManifest = { ...structuredClone(manifest),
        attempt_id: `attempt-${randomUUID()}`, created_at: new Date().toISOString() }
      await this.deps.runtime.assertAvailable?.(retried)
      const compiled = compileRuntimeManifest(retried)
      await this.deps.runs.createAttempt({ attemptId: retried.attempt_id, tenantId, runId: run.id, runtimeId,
        manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
        modelRouteSnapshot: attempt.modelRouteSnapshot })
      this.scheduler.enqueue(run, retried)
    } else {
      // 不从上一次 Attempt 的 manifest 续叠：其中的 message 已是续写指令、history 已并入
      // 部分输出，再次基于它构造会重复。始终回到稳定来源——Run 的原始用户问题与 Run 之前
      // 的会话历史，再由 withContinuationOutputs 统一追加全部已提交的部分输出。
      const continued = await withContinuationOutputs(
        this.deps.conversations,
        await this.deps.conversations.getConversationHistory(run.sessionId!, run.id),
        run.id,
        await this.deps.conversations.getRunPrompt(run.id),
      )
      const retryPurpose: AdminRunPurpose = manifest.purpose && isAdminRunPurpose(manifest.purpose) ? manifest.purpose : 'admin-skill-install'
      await this.dispatchAdmin(run, continued.message, manifest.installation_source ?? '', retryPurpose, undefined, continued.history)
    }
    return this.deps.runs.getRun(tenantId, runId)
  }

  private async requireAdminRun(runId: string, userId: string) {
    const run = await this.deps.runs.getRun(tenantId, runId)
    if (!run || run.requestedBy !== userId) throw accessDenied('管理助手运行不存在或不可访问')
    const attempt = run.currentAttemptId ? await this.deps.runs.getAttempt(tenantId, run.currentAttemptId) : null
    const purpose = (attempt?.manifest as RuntimeManifest | undefined)?.purpose
    if (purpose === 'admin-assistant') await this.deps.authorization?.requireAdminReader(userId)
    else await this.deps.authorization?.requirePlatformAdmin(userId)
    await this.deps.conversations.requireSession(run.sessionId!, userId, 'admin')
    return run
  }

  private async dispatchAdmin(run: RunRecord, prompt: string, source: string, purpose: AdminRunPurpose, testSkill?: RuntimeSkillConfiguration, history?: RuntimeManifest['input']['conversation_history']) {
    const route = await this.deps.models.resolveRoute('default')
    const runtimePolicy = await this.deps.operations?.getRuntimePolicy(runtimeId)
    const limits = { timeout_seconds: Math.min(180, runtimePolicy?.timeoutSeconds ?? 180), max_output_bytes: 65536, max_tool_calls: purpose === 'admin-assistant' ? 5 : 4 }
    const manifest: RuntimeManifest = {
      manifest_version: '1.0', purpose, installation_source: source,
      run_id: run.id, attempt_id: `attempt-${randomUUID()}`, task_id: run.taskId, session_id: run.sessionId,
      workspace_id: '', agent_version_id: null,
      agent_configuration: {
        system_prompt: adminSystemPrompt(purpose),
        skill_instructions: [],
      },
      user_context: { user_id: run.requestedBy, tenant_id: tenantId, role_ids: [] },
      principal_context: await this.dispatcher.principalContextForRun(run, `principal-system-${tenantId}`, 1),
      permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'deny' },
      skills: [], tools: adminTools(purpose), data_scopes: [], knowledge_context: [],
      model_route_id: route.routeId, input: { message: prompt, file_mounts: [], ...(history?.length ? { conversation_history: history } : {}) },
      budget: await this.budget.manifest(run, limits),
      limits,
      created_at: new Date().toISOString(), trace_id: `trace-${run.id}`,
    }
    if (testSkill) {
      const testCatalog = [testSkill, ...flattenSkillDependencies(testSkill)]
      manifest.agent_configuration = {
        system_prompt: `你是 dsh-work Skill 严格试运行助手。必须先调用 activate_skill 激活 ${testSkill.name ?? testSkill.id}，并按依赖关系逐一激活其他 Skill，再按返回的锁定说明处理测试输入。激活结果包含 Python 入口时，必须通过 python_execute 至少成功执行一个声明入口；不得直接运行宿主机命令。需要文件时必须实际调用已授权的只读工具读取准确路径，不猜测文件内容；缺少输入时明确说明。不要执行任何安装、发布或平台配置操作。`,
        skill_instructions: testCatalog.map(toRuntimeManifestSkill),
      }
      if (testSkill.testScenario) {
        manifest.test_scenario = normalizeSkillTestScenario(testSkill.testScenario, testCatalog)
        // Budget remains bounded but must admit every explicitly required activation
        // and Python call, plus a small allowance for reading fixture inputs.
        manifest.limits.max_tool_calls = Math.min(160, 8 + manifest.test_scenario.requiredSkills.length + manifest.test_scenario.requiredPythonEntries.length)
        manifest.agent_configuration.system_prompt = `你是 dsh-work 场景试运行助手。先激活根 Skill，再完成本场景要求的能力：${manifest.test_scenario.requiredSkills.join('、')}。本场景必须通过 python_execute 执行：${JSON.stringify(manifest.test_scenario.requiredPythonEntries)}。其他分支无需强行执行。按实际输入返回结果，不猜测文件；只使用已授权工具，不安装、发布或修改平台。`
      }
      manifest.skills = testCatalog.map(skill => ({ id: skill.id, version: skill.version }))
      manifest.tools = [...new Set(testCatalog.flatMap(skill => skill.tools))].map(toCapabilityReference).concat({ id: 'activate_skill', version: '1.0.0' })
    }
    manifest.budget = await this.budget.manifest(run, manifest.limits)
    await this.dispatcher.submit(run, manifest, route)
  }
}
