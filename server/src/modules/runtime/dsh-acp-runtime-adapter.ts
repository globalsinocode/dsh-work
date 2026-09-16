import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  AcpJsonRpcClient,
  AcpProtocolError,
  type AcpPermissionRequest,
  type AcpProcessConfiguration,
  type AcpSessionUpdate,
} from './acp-json-rpc-client.ts'
import { createPlatformToolBridge } from './platform-tool-bridge.ts'
import { compileRuntimeManifest } from './manifest-compiler.ts'
import { redactSensitiveText, sanitizeSafeMetadata } from '../../security/safe-observability.ts'
import type {
  AgentRuntimePort,
  RuntimeCancelCause,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeHealth,
  RuntimeManifest,
  RuntimeRunStatus,
  RuntimeToolDescriptor,
} from './runtime-types.ts'

const DEFAULT_SETUP_TIMEOUT_MS = 120_000

interface ExecutionRecord {
  manifest: RuntimeManifest
  snapshot: RuntimeExecutionSnapshot
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
  client?: AcpJsonRpcClient
  acpSessionId?: string
  timeout?: NodeJS.Timeout
  timeoutPhase?: 'setup' | 'execution'
  cancelCause?: RuntimeCancelCause | 'timeout' | 'shutdown'
  assistantText: string
  terminal: boolean
  acceptedMono: number
  promptStartMono?: number
  firstOutputMs?: number
  activatedSkills: Set<string>
  materializedSkills: Map<string, { instructions: string; files: Array<{ path: string; content: string; sha256: string; size: number }> }>
  bridge?: Awaited<ReturnType<typeof createPlatformToolBridge>>
}

export interface DshAcpRuntimeAdapterConfiguration {
  runtimeId: string
  runtimeRoot: string
  dshRepository: string
  toolCatalogPath?: string
  runtimeVersion?: string
  runtimeCommit?: string
  protocolVersion?: number
  launchMode?: 'source-checkout' | 'managed-distribution'
  process: Omit<AcpProcessConfiguration, 'env'> & { env?: Record<string, string> }
  acceptingRuns?: boolean
  shutdownGraceMs?: number
  /**
   * Bound for Worker spawn + ACP initialize + session/new, kept separate from
   * the manifest execution budget so Worker startup cannot consume the Agent
   * Loop deadline (and a hung spawn still fails fast).
   */
  setupTimeoutMs?: number
  permissionDecision?: (
    request: AcpPermissionRequest,
    manifest: RuntimeManifest,
  ) => Promise<'allow_once' | 'reject_once'>
  prepareSkillInstallation?: (manifest: RuntimeManifest, signal: AbortSignal) => Promise<unknown>
  inspectAdminState?: (input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) => Promise<unknown>
  proposeAdminTask?: (input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) => Promise<unknown>
  prepareAdminAction?: (input: Record<string, unknown>, manifest: RuntimeManifest, signal: AbortSignal) => Promise<unknown>
  loadSkillArtifact?: (
    skill: RuntimeManifest['agent_configuration']['skill_instructions'][number],
  ) => Promise<{ instructions: string; files: Array<{ path: string; content: string; sha256: string; size: number }> }>
  recordSkillActivation?: (manifest: RuntimeManifest, skill: RuntimeManifest['agent_configuration']['skill_instructions'][number], contentSha256: string) => Promise<void>
  executePython?: (input: Record<string, unknown>, manifest: RuntimeManifest, workspaceDirectory: string, signal: AbortSignal) => Promise<unknown>
  recordPythonExecution?: (manifest: RuntimeManifest, skillId: string, entry: string, succeeded: boolean) => Promise<void>
  collectArtifacts?: (
    manifest: RuntimeManifest,
    workspaceDirectory: string,
  ) => Promise<Array<{ name: string; size: number }>>
  now?: () => Date
}

export class DshAcpRuntimeAdapter implements AgentRuntimePort {
  private readonly configuration: DshAcpRuntimeAdapterConfiguration
  private readonly executions = new Map<string, ExecutionRecord>()
  private acceptingRuns: boolean
  private closed = false

  constructor(configuration: DshAcpRuntimeAdapterConfiguration) {
    this.configuration = configuration
    this.acceptingRuns = configuration.acceptingRuns ?? true
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    if (this.closed) throw new Error('Runtime Adapter is closed')
    const acceptedMono = performance.now()
    // The Postgres scheduler is the admission gate. A manifest reaching this
    // port has already been claimed and must remain executable if an operator
    // switches the Runtime to draining before dispatch reaches this process.
    const previous = this.executions.get(manifest.run_id)
    if (previous !== undefined && !previous.terminal) throw new Error(`Run already exists: ${manifest.run_id}`)
    if (previous?.terminal) this.executions.delete(manifest.run_id)

    const compiled = compileRuntimeManifest(manifest)
    const attemptDirectory = resolve(
      this.configuration.runtimeRoot,
      safeSegment(manifest.user_context.tenant_id),
      safeSegment(manifest.run_id),
      safeSegment(manifest.attempt_id),
    )
    const workspaceDirectory = join(attemptDirectory, 'workspace')
    const outputDirectory = join(workspaceDirectory, 'output')
    await mkdir(workspaceDirectory, { recursive: true })
    await mkdir(outputDirectory, { recursive: true })
    for (const mount of compiled.manifest.input.file_mounts) {
      const relativePath = mount.mount_path.slice('/workspace/'.length)
      const target = resolve(workspaceDirectory, relativePath)
      if (!target.startsWith(`${workspaceDirectory}/`)) throw new Error(`Unsafe file mount path: ${mount.mount_path}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, mount.content, { flag: 'wx', mode: 0o400 })
      await chmod(target, 0o400)
    }
    const materializedSkills = new Map<string, { instructions: string; files: Array<{ path: string; content: string; sha256: string; size: number }> }>()
    for (const skill of compiled.manifest.agent_configuration.skill_instructions) {
      const materialized = skill.artifact_ref
        ? await this.configuration.loadSkillArtifact?.(skill)
        : {
            instructions: skill.instructions ?? '',
            files: (skill.files ?? []).filter((file): file is { path: string; content: string; sha256: string; size: number } => file.content !== undefined),
          }
      if (!materialized || materialized.instructions.length < 20) throw new Error(`Skill 文件夹不可用：${skill.id}@${skill.version}`)
      if (skill.instructions_sha256 && createHash('sha256').update(materialized.instructions).digest('hex') !== skill.instructions_sha256) throw new Error(`Skill 执行说明摘要不匹配：${skill.id}`)
      const indexed = new Map((skill.files ?? []).map(file => [file.path, file]))
      for (const file of materialized.files) {
        const expected = indexed.get(file.path)
        if (skill.artifact_ref && (!expected || expected.sha256 !== file.sha256 || expected.size !== file.size)) throw new Error(`Skill 文件索引不匹配：${file.path}`)
        const root = join(workspaceDirectory, 'skills', safeSegment(skill.id))
        const target = resolve(root, file.path)
        if (!target.startsWith(`${root}/`)) throw new Error('Unsafe Skill resource path')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content, { flag: 'wx', mode: 0o400 })
      }
      materializedSkills.set(skill.id, materialized)
    }
    await writeFile(join(attemptDirectory, 'manifest.json'), `${compiled.canonicalJson}\n`, { flag: 'wx' })

    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const acceptedAt = this.now()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt,
      startedAt: null,
      endedAt: null,
      manifestSha256: compiled.sha256,
      attemptDirectory,
      errorCode: null,
      errorMessage: null,
    }
    const record: ExecutionRecord = {
      manifest: compiled.manifest,
      snapshot,
      events: [],
      listeners: new Set(),
      done,
      resolveDone,
      assistantText: '',
      terminal: false,
      acceptedMono,
      activatedSkills: new Set(),
      materializedSkills,
    }
    this.executions.set(manifest.run_id, record)
    this.emit(record, 'run.queued', '任务已进入 Runtime 队列', { manifest_sha256: compiled.sha256 })
    void this.run(record, workspaceDirectory)

    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener): () => void {
    const record = this.executions.get(runId)
    if (record === undefined) throw new Error(`Run not found: ${runId}`)
    for (const event of record.events) listener(structuredClone(event))
    record.listeners.add(listener)
    return () => { record.listeners.delete(listener) }
  }

  async cancel(
    runId: string,
    requestedBy: string,
    cancelCause: RuntimeCancelCause = 'user',
  ): Promise<{ accepted: boolean }> {
    const record = this.executions.get(runId)
    if (record === undefined || record.terminal) return { accepted: false }
    if (record.cancelCause !== undefined) return { accepted: true }

    // 1A-T5: the workbench cancel route keeps the default ('user'); the
    // revocation sweep passes 'system_revoke'. The ACP cancel request itself
    // is unchanged — only the recorded cause flows differently.
    record.bridge?.abort()
    record.cancelCause = cancelCause
    this.setStatus(record, 'cancel_requested')
    this.emit(record, 'run.cancel_requested', '正在取消任务', { requested_by: requestedBy, cause: cancelCause })
    if (record.client !== undefined && record.acpSessionId !== undefined) {
      await record.client.cancel(record.acpSessionId)
      this.scheduleForcedClose(record)
    } else if (record.client !== undefined) {
      this.scheduleForcedClose(record)
    }
    return { accepted: true }
  }

  status(runId: string): RuntimeExecutionSnapshot | undefined {
    const snapshot = this.executions.get(runId)?.snapshot
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await access(this.configuration.dshRepository)
      return {
        status: this.closed ? 'offline' : 'healthy',
        runtimeId: this.configuration.runtimeId,
        activeExecutions: [...this.executions.values()].filter(record => !record.terminal).length,
        acceptingRuns: this.acceptingRuns && !this.closed,
        dshRepository: this.configuration.dshRepository,
        runtimeVersion: this.configuration.runtimeVersion,
        runtimeCommit: this.configuration.runtimeCommit,
        protocolVersion: this.configuration.protocolVersion,
        launchMode: this.configuration.launchMode,
        transport: 'acp-stdio',
        message: this.closed
          ? 'Runtime Adapter 已关闭'
          : this.acceptingRuns
            ? 'DSH Runtime 已通过安装校验，ACP Adapter 可用并接收任务'
            : 'DSH Runtime 已通过安装校验，ACP Adapter 当前不接收新任务',
      }
    } catch {
      return {
        status: 'offline',
        runtimeId: this.configuration.runtimeId,
        activeExecutions: 0,
        acceptingRuns: false,
        dshRepository: this.configuration.dshRepository,
        runtimeVersion: this.configuration.runtimeVersion,
        runtimeCommit: this.configuration.runtimeCommit,
        protocolVersion: this.configuration.protocolVersion,
        launchMode: this.configuration.launchMode,
        transport: 'acp-stdio',
        message: 'DSH Runtime 安装目录不可访问',
      }
    }
  }

  async listTools(): Promise<RuntimeToolDescriptor[]> {
    const path = this.configuration.toolCatalogPath
    if (!path) throw new Error('DSH Runtime 未配置工具目录输出')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed['formatVersion'] !== 1 || !Array.isArray(parsed['tools'])) {
      throw new Error('DSH Runtime 工具目录格式无效')
    }
    return parsed['tools'].map((value) => {
      if (!isRecord(value)
        || typeof value['name'] !== 'string'
        || typeof value['description'] !== 'string'
        || !isRecord(value['parameters'])) {
        throw new Error('DSH Runtime 工具目录包含无效条目')
      }
      return {
        id: value['name'],
        description: value['description'],
        inputSchema: value['parameters'],
      }
    })
  }

  async configureScheduling(status: 'accepting' | 'draining' | 'disabled'): Promise<void> {
    if (this.closed && status === 'accepting') throw new Error('已关闭的 Runtime Adapter 不能重新接收任务')
    this.acceptingRuns = status === 'accepting' && !this.closed
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.acceptingRuns = false
    const active = [...this.executions.values()].filter(record => !record.terminal)
    for (const record of active) {
      record.bridge?.abort()
      record.cancelCause = 'shutdown'
      this.setStatus(record, 'cancel_requested')
      this.emit(record, 'run.cancel_requested', 'Runtime 正在关闭任务', { requested_by: 'runtime-shutdown' })
      if (record.client !== undefined && record.acpSessionId !== undefined) {
        await record.client.cancel(record.acpSessionId).catch(() => undefined)
        this.scheduleForcedClose(record)
      }
    }
    await Promise.all(active.map(record => record.done))
  }

  private async run(record: ExecutionRecord, workspaceDirectory: string): Promise<void> {
    const runStartMono = performance.now()
    try {
      this.setStatus(record, 'starting')
      this.armDeadline(record, 'setup', this.configuration.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS)
      const platformTools: Record<string, import('./platform-tool-bridge.ts').PlatformToolHandler> = {}
      if (record.manifest.purpose === 'admin-skill-install') {
        const prepare = this.configuration.prepareSkillInstallation
        if (!prepare) throw new Error('安装助手不可用：未配置平台安装工具')
        platformTools['prepare_skill_installation'] = (_input, signal) => prepare(record.manifest, signal)
      }
      if (record.manifest.tools.some(tool => tool.id === 'inspect_admin_state')) {
        const inspect = this.configuration.inspectAdminState
        if (!inspect) throw new Error('管理助手不可用：未配置平台查询工具')
        platformTools['inspect_admin_state'] = (input, signal) => inspect(input, record.manifest, signal)
      }
      if (record.manifest.tools.some(tool => tool.id === 'propose_admin_task')) {
        const propose = this.configuration.proposeAdminTask
        if (!propose) throw new Error('管理助手不可用：未配置任务提案工具')
        platformTools['propose_admin_task'] = (input, signal) => propose(input, record.manifest, signal)
      }
      if (record.manifest.tools.some(tool => tool.id === 'prepare_admin_action')) {
        const prepare = this.configuration.prepareAdminAction
        if (!prepare) throw new Error('管理助手不可用：未配置操作计划工具')
        platformTools['prepare_admin_action'] = (input, signal) => prepare(input, record.manifest, signal)
      }
      if (record.manifest.tools.some(tool => tool.id === 'activate_skill')) {
        platformTools['activate_skill'] = async (input) => {
          const requested = typeof input['name'] === 'string' ? input['name'].trim() : ''
          const matches = record.manifest.agent_configuration.skill_instructions.filter(skill => (skill.name ?? skill.id) === requested || skill.id === requested)
          if (!requested || matches.length !== 1) throw new Error(`当前 Run 中没有唯一匹配的 Skill：${requested || '未提供名称'}`)
          const skill = matches[0]!
          const exactName = skill.name ?? skill.id
          if (skill.disable_model_invocation && !record.manifest.input.message.includes(exactName)) throw new Error(`Skill ${exactName} 只允许用户显式激活`)
          const materialized = record.materializedSkills.get(skill.id)
          if (!materialized) throw new Error(`Skill 文件夹未装载：${exactName}`)
          const contentSha256 = createHash('sha256').update(JSON.stringify({ instructions: materialized.instructions, files: skill.files ?? [] })).digest('hex')
          await this.configuration.recordSkillActivation?.(record.manifest, skill, contentSha256)
          record.activatedSkills.add(skill.id)
          return {
            id: skill.id,
            name: skill.name ?? skill.id,
            version: skill.version,
            instructions: materialized.instructions,
            resourceDirectory: skill.files?.length ? `skills/${safeSegment(skill.id)}/` : null,
            dependencies: skill.dependencies ?? [],
            pythonEntries: materialized.files.filter(file => file.path.endsWith('.py')).map(file => file.path),
            contentSha256,
          }
        }
      }
      if (record.manifest.tools.some(tool => tool.id === 'python_execute')) {
        const executePython = this.configuration.executePython
        if (!executePython) throw new Error('Python Skill 不可用：未配置平台脚本沙箱')
        platformTools['python_execute'] = async (input, signal) => {
          const requested = typeof input['skill'] === 'string' ? input['skill'].trim() : ''
          const skill = record.manifest.agent_configuration.skill_instructions.find(item => item.id === requested || (item.name ?? item.id) === requested)
          if (!skill || !record.activatedSkills.has(skill.id)) throw new Error('执行 Python 前必须先激活对应 Skill')
          const result = await executePython(input, record.manifest, workspaceDirectory, signal)
          const succeeded = typeof result === 'object' && result !== null && 'exitCode' in result && (result as { exitCode: unknown }).exitCode === 0
          await this.configuration.recordPythonExecution?.(record.manifest, skill.id, String(input['entry'] ?? ''), succeeded)
          return result
        }
      }
      if (Object.keys(platformTools).length) record.bridge = await createPlatformToolBridge(platformTools, record.manifest.limits.max_tool_calls)
      if (record.cancelCause !== undefined) {
        this.finishFromCancellationCause(record)
        return
      }
      const client = AcpJsonRpcClient.launch(
        {
          ...this.configuration.process,
          shutdownGraceMs: this.configuration.shutdownGraceMs ?? this.configuration.process.shutdownGraceMs,
          env: {
            ...this.configuration.process.env,
            ...(record.bridge ? { DSH_PLATFORM_TOOL_SOCKET: record.bridge.socket } : {}),
            DSH_PERMISSION_MODE: 'workspace-write',
            DSH_SNAPSHOT: 'record',
            DSH_SNAPSHOT_SESSIONS_ROOT: join(record.snapshot.attemptDirectory, 'sessions'),
            DSH_AGENT_SYSTEM_PROMPT: renderSystemPrompt(record.manifest),
            DSH_ALLOWED_TOOLS_JSON: JSON.stringify(record.manifest.tools.map(tool => tool.id)),
            DSH_MAX_TOOL_CALLS: String(record.manifest.limits.max_tool_calls),
            DSH_WORKSPACE_ROOT: workspaceDirectory,
            DSH_TOOL_APPROVAL_MODE: record.manifest.permission_policy.approval_mode,
            DSH_TOOL_APPROVAL_LOG: join(record.snapshot.attemptDirectory, 'tool-approval-requests.jsonl'),
          },
        },
        {
          onSessionUpdate: update => { this.onSessionUpdate(record, update) },
          onPermissionRequest: request => this.onPermissionRequest(record, request),
          onDiagnostic: message => {
            this.emitDiagnostic(record, message)
          },
        },
      )
      record.client = client
      const spawnMono = performance.now()
      await client.initialize()
      const initializedMono = performance.now()
      record.acpSessionId = await client.newSession(workspaceDirectory)
      const sessionReadyMono = performance.now()
      if (record.cancelCause !== undefined) {
        this.finishFromCancellationCause(record)
        return
      }
      this.armDeadline(record, 'execution', record.manifest.limits.timeout_seconds * 1000)
      this.setStatus(record, 'running')
      record.snapshot.startedAt = this.now()
      this.emit(record, 'run.started', 'DSH Worker 已启动', {
        transport: 'acp-stdio',
        acp_session_id: record.acpSessionId,
        prepare_ms: Math.round(runStartMono - record.acceptedMono),
        worker_spawn_ms: Math.round(spawnMono - runStartMono),
        worker_init_ms: Math.round(initializedMono - spawnMono),
        session_ready_ms: Math.round(sessionReadyMono - initializedMono),
      })

      record.promptStartMono = performance.now()
      const response = await client.prompt(record.acpSessionId, renderUserPrompt(record.manifest))
      const promptDoneMono = performance.now()
      const stopReason = response['stopReason']
      if (record.cancelCause !== undefined) {
        this.finishFromCancellationCause(record)
        return
      }
      if (stopReason === 'cancelled') {
        this.finishFailed(
          record,
          'RUNTIME_CANCELLED_UNEXPECTEDLY',
          'DSH Runtime ended the Attempt without an explicit cancellation request',
        )
        return
      }

      let artifacts: Array<{ name: string; size: number }> = []
      if (record.manifest.purpose === undefined && record.manifest.tools.some(tool => tool.id === 'write')) {
        if (!this.configuration.collectArtifacts) throw new Error('成果收集服务不可用')
        artifacts = await this.configuration.collectArtifacts(record.manifest, workspaceDirectory)
      }
      if (record.assistantText.length > 0) {
        this.emit(record, 'assistant.completed', record.assistantText, { committed: true })
      }
      this.setStatus(record, 'completed')
      const evidence = await waitForSessionEvidence(join(record.snapshot.attemptDirectory, 'sessions'))
      this.emit(record, 'run.completed', '任务执行完成', {
        stop_reason: stopReason ?? 'unknown',
        elapsed_ms: Math.round(performance.now() - record.acceptedMono),
        execution_ms: Math.round(promptDoneMono - (record.promptStartMono ?? promptDoneMono)),
        first_output_ms: record.firstOutputMs === undefined ? null : Math.round(record.firstOutputMs),
        input_tokens: evidence?.inputTokens ?? null,
        output_tokens: evidence?.outputTokens ?? null,
        tool_call_count: evidence?.toolCallCount ?? 0,
        tool_result_count: evidence?.toolResultCount ?? 0,
        artifact_count: artifacts.length,
        usage_source: evidence ? 'dsh-session-log' : 'unavailable',
      })
      this.finish(record)
    } catch (error) {
      if (record.cancelCause !== undefined) this.finishFromCancellationCause(record)
      else {
        const failure = classifyRuntimeFailure(error)
        this.finishFailed(record, failure.code, failure.message)
      }
    } finally {
      if (record.timeout !== undefined) clearTimeout(record.timeout)
      await record.client?.close().catch(() => undefined)
      await record.bridge?.close()
    }
  }

  private onSessionUpdate(record: ExecutionRecord, notification: AcpSessionUpdate): void {
    if (record.terminal || notification.sessionId !== record.acpSessionId) return
    const updateType = notification.update['sessionUpdate']
    const content = notification.update['content']
    if (updateType !== 'agent_message_chunk' || !isRecord(content) || content['type'] !== 'text') return
    const text = content['text']
    if (typeof text !== 'string' || text.length === 0) return
    if (record.firstOutputMs === undefined && record.promptStartMono !== undefined) {
      record.firstOutputMs = performance.now() - record.promptStartMono
    }

    const remaining = record.manifest.limits.max_output_bytes - Buffer.byteLength(record.assistantText)
    if (remaining <= 0) return
    const bounded = truncateUtf8(text, remaining)
    record.assistantText += bounded
    this.emit(record, 'assistant.delta', bounded, { committed_block: true })
  }

  private async onPermissionRequest(
    record: ExecutionRecord,
    request: AcpPermissionRequest,
  ): Promise<{ outcome: Record<string, unknown> }> {
    const toolCallId = typeof request.toolCall?.['toolCallId'] === 'string'
      ? request.toolCall['toolCallId']
      : null
    const toolName = await resolvePermissionToolName(record, request, toolCallId)
    this.emit(record, 'approval.required', 'DSH 请求一次性工具权限', {
      option_kinds: request.options?.map(option => option.kind).filter(Boolean) ?? [],
      tool_name: toolName,
      tool_call_id: toolCallId,
    })
    const decision = record.manifest.permission_policy.approval_mode === 'never'
      ? 'allow_once'
      : await this.configuration.permissionDecision?.(request, record.manifest) ?? 'reject_once'
    const desiredKind = decision
    const option = request.options?.find(candidate => candidate.kind === desiredKind)
    if (option?.optionId === undefined) {
      this.emit(record, 'approval.resolved', '权限请求已安全拒绝', {
        decision: 'cancelled', tool_name: toolName, tool_call_id: toolCallId,
      })
      return { outcome: { outcome: 'cancelled' } }
    }
    this.emit(record, 'approval.resolved', decision === 'allow_once' ? '已允许本次操作' : '已拒绝本次操作', {
      decision,
      tool_name: toolName,
      tool_call_id: toolCallId,
    })
    return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }

  private armDeadline(record: ExecutionRecord, phase: 'setup' | 'execution', timeoutMs: number): void {
    if (record.timeout !== undefined) clearTimeout(record.timeout)
    record.timeoutPhase = phase
    record.timeout = setTimeout(() => {
      void this.timeout(record)
    }, timeoutMs)
  }

  private async timeout(record: ExecutionRecord): Promise<void> {
    if (record.terminal || record.cancelCause !== undefined) return
    record.bridge?.abort()
    record.cancelCause = 'timeout'
    this.setStatus(record, 'cancel_requested')
    this.emit(
      record,
      'run.cancel_requested',
      record.timeoutPhase === 'setup' ? 'Worker 启动超时，正在终止' : '任务执行超时，正在终止',
      { reason: 'timeout', timeout_phase: record.timeoutPhase ?? 'execution' },
    )
    if (record.client !== undefined && record.acpSessionId !== undefined) {
      await record.client.cancel(record.acpSessionId).catch(() => undefined)
      this.scheduleForcedClose(record)
    } else if (record.client !== undefined) {
      this.scheduleForcedClose(record)
    }
  }

  private scheduleForcedClose(record: ExecutionRecord): void {
    const timer = setTimeout(() => {
      if (!record.terminal) void record.client?.close().catch(() => undefined)
    }, this.configuration.shutdownGraceMs ?? 3000)
    timer.unref()
  }

  private finishCancelled(record: ExecutionRecord): void {
    if (record.terminal) return
    this.setStatus(record, 'cancelled')
    this.emit(record, 'run.cancelled', '任务已取消', { cause: record.cancelCause ?? 'user' })
    this.finish(record)
  }

  private finishFromCancellationCause(record: ExecutionRecord): void {
    if (record.cancelCause === 'timeout') {
      this.commitInterruptedOutput(record, 'timeout')
      this.finishFailed(record, 'RUN_TIMEOUT', 'Runtime execution timed out')
    } else if (record.cancelCause === 'shutdown') {
      this.commitInterruptedOutput(record, 'shutdown')
      this.finishFailed(record, 'SERVICE_SHUTDOWN', 'Runtime stopped while the Attempt was active')
    } else {
      this.finishCancelled(record)
    }
  }

  /**
   * Persists whatever the Worker already produced before an interruption, so a
   * timed-out Attempt keeps its partial answer instead of reporting only a
   * bare failure. The stored message carries an explicit interruption marker;
   * a later retry receives it as ordinary conversation history (context
   * continuation — this is not a checkpoint resume of the old Attempt).
   */
  private commitInterruptedOutput(record: ExecutionRecord, cause: 'timeout' | 'shutdown'): void {
    const text = record.assistantText.trimEnd()
    if (text.length === 0) return
    const note = cause === 'timeout' ? '本轮回答因执行超时中断，以上为已生成内容。' : '本轮回答因服务中断终止，以上为已生成内容。'
    this.emit(record, 'assistant.completed', `${text}\n\n---\n*${note}*`, { committed: true, interrupted: cause })
  }

  private finishFailed(record: ExecutionRecord, code: string, message: string): void {
    if (record.terminal) return
    record.snapshot.errorCode = code
    record.snapshot.errorMessage = message
    this.setStatus(record, 'failed')
    this.emit(record, 'run.failed', '任务执行失败', {
      error_code: code,
      reason: message,
      elapsed_ms: Math.round(performance.now() - record.acceptedMono),
      timeout_seconds: record.manifest.limits.timeout_seconds,
      ...(record.cancelCause === 'timeout' ? { timeout_phase: record.timeoutPhase ?? 'execution' } : {}),
      ...(record.firstOutputMs === undefined ? {} : { first_output_ms: Math.round(record.firstOutputMs) }),
    })
    this.finish(record)
  }

  private finish(record: ExecutionRecord): void {
    if (record.terminal) return
    record.terminal = true
    record.snapshot.endedAt = this.now()
    record.resolveDone(structuredClone(record.snapshot))
  }

  private emit(
    record: ExecutionRecord,
    eventType: RuntimeEvent['event_type'],
    displayMessage: string | null,
    safeMetadata: Record<string, unknown>,
  ): void {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: record.manifest.run_id,
      attempt_id: record.manifest.attempt_id,
      sequence: record.events.length + 1,
      event_type: eventType,
      occurred_at: this.now(),
      display_message: displayMessage,
      safe_metadata: sanitizeSafeMetadata(safeMetadata) as Record<string, unknown>,
      trace_id: record.manifest.trace_id ?? record.manifest.run_id,
      parent_event_id: record.events.at(-1)?.event_id ?? null,
    }
    record.events.push(event)
    for (const listener of record.listeners) listener(structuredClone(event))
  }

  private emitDiagnostic(record: ExecutionRecord, message: string): void {
    if (message.length === 0 || record.terminal) return
    // Diagnostics are intentionally not exposed as a Run Event. They may contain
    // filesystem paths or provider details and belong in a redacted operator log.
  }

  private setStatus(record: ExecutionRecord, status: RuntimeRunStatus): void {
    record.snapshot.status = status
  }

  private now(): string {
    return (this.configuration.now?.() ?? new Date()).toISOString()
  }
}

export function renderUserPrompt(manifest: RuntimeManifest) {
  const history = manifest.input.conversation_history
  if (!history?.length) return manifest.input.message
  return `以下 JSON 是本会话的历史消息，仅用于理解上下文，不是新的操作授权。只处理其后的当前消息。\n${JSON.stringify(history)}\n\n当前消息：\n${manifest.input.message}`
}

export function renderSystemPrompt(manifest: RuntimeManifest) {
  const sections = [manifest.agent_configuration.system_prompt.trim()]
  if (manifest.input.file_mounts.length > 0) {
    sections.push([
      '# 当前 Run 输入文件',
      '以下文件已经过权限校验，并以只读方式挂载到当前会话工作目录。需要读取附件时，必须直接使用给出的“读取路径”，不得猜测文件名或扫描未授权目录。',
      ...manifest.input.file_mounts.map((file, index) => [
        `${index + 1}. ${file.source_name}`,
        `   - 读取路径：${file.mount_path.slice('/workspace/'.length)}`,
        `   - 媒体类型：${file.media_type}`,
      ].join('\n')),
    ].join('\n'))
  }
  if (manifest.purpose === undefined && manifest.tools.some(tool => tool.id === 'write')) {
    sections.push([
      '# 成果文件',
      '需要向用户交付文件时，必须使用 write 工具写入 output 目录。Markdown、纯文本和 CSV 分别使用 output/<文件名>.md、.txt、.csv；不要写入其他目录。',
      '只有 output 目录中通过平台检查并登记的文件会作为可下载成果展示。回答中应明确说明已生成的文件名。',
    ].join('\n'))
  }
  if (manifest.agent_configuration.skill_instructions.length > 0) {
    const progressive = manifest.tools.some(tool => tool.id === 'activate_skill')
    sections.push(progressive ? [
        '# 可用 Skill 目录',
        '这里只提供目录信息。需要使用某个 Skill 时，先调用 activate_skill 获取当前 Run 锁定版本的完整说明；不要猜测 Skill 正文或直接扫描资源目录。激活后在本次 Attempt 中持续遵循返回的说明。',
        ...manifest.agent_configuration.skill_instructions.filter(skill => !skill.disable_model_invocation).map(skill =>
          `- ${skill.name ?? skill.id}（${skill.id}@${skill.version}）：${skill.description?.trim() || '由平台提供的已锁定 Skill'}`,
        ),
      ].join('\n\n')
      : [
        '# 已启用 Skill（兼容模式）',
        ...manifest.agent_configuration.skill_instructions.map(skill =>
          `## ${skill.id}@${skill.version}\n${skill.files?.length ? `资源目录：skills/${safeSegment(skill.id)}/，以下说明中的相对路径均基于该目录。\n` : ''}${skill.instructions?.trim() || '请先通过平台激活并读取此 Skill 的文件夹说明。'}`,
        ),
      ].join('\n\n'))
  }
  if (manifest.knowledge_context.length > 0) {
    sections.push([
      '# 企业知识上下文',
      '只能依据以下已授权知识片段回答相关问题。不得把知识片段之外的内容表述为企业事实。回答中的知识结论必须使用对应的【序号】标注来源；若片段不足，应明确说明无法从当前授权知识中确认。',
      ...manifest.knowledge_context.map((document, index) => [
        `## 【${index + 1}】${document.title} v${document.version}`,
        `生效日期：${document.effectiveDate}；数据范围：${document.dataScope}；内容校验：${document.contentChecksum}`,
        document.excerpt.trim(),
      ].join('\n')),
    ].join('\n\n'))
  }
  return sections.join('\n\n')
}

async function resolvePermissionToolName(
  record: ExecutionRecord,
  request: AcpPermissionRequest,
  toolCallId: string | null,
): Promise<string> {
  const manifestToolIds = new Set(record.manifest.tools.map(tool => tool.id))
  if (toolCallId !== null) {
    try {
      const approvalLog = await readFile(join(record.snapshot.attemptDirectory, 'tool-approval-requests.jsonl'), 'utf8')
      const entries = approvalLog.trim().split('\n').reverse()
      for (const entry of entries) {
        const parsed = JSON.parse(entry) as unknown
        if (!isRecord(parsed) || parsed['call_id'] !== toolCallId) continue
        const toolName = parsed['tool_name']
        if (typeof toolName === 'string' && manifestToolIds.has(toolName)) return toolName
      }
    } catch {
      // Sandbox-only permission requests have no policy log entry. Continue
      // with protocol metadata and the single-tool manifest fallback.
    }
  }

  for (const candidate of [request.toolCall?.['name'], request.toolCall?.['title']]) {
    if (typeof candidate !== 'string') continue
    const exactId = record.manifest.tools.find(tool =>
      tool.id === candidate || `${tool.id}@${tool.version}` === candidate,
    )?.id
    if (exactId) return exactId
  }
  return record.manifest.tools.length === 1 ? record.manifest.tools[0]!.id : 'dsh-runtime-tool'
}

function safeSegment(value: string): string {
  const readable = value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSensitiveText(message).slice(0, 1000)
}

export function classifyRuntimeFailure(error: unknown): { code: string; message: string } {
  const message = safeErrorMessage(error)
  const category = error instanceof AcpProtocolError && isRecord(error.data)
    ? error.data['category']
    : undefined
  if (category === 'model' || /model (?:invocation|request|provider).*(?:failed|unavailable)/i.test(message)) {
    return { code: 'MODEL_INVOCATION_FAILED', message }
  }
  if (category === 'tool_timeout' || /tool .*(?:timed out|timeout)/i.test(message)) {
    return { code: 'TOOL_TIMEOUT', message }
  }
  if (category === 'network' || /network .*(?:unavailable|disconnected|failed)/i.test(message)) {
    return { code: 'NETWORK_UNAVAILABLE', message }
  }
  if (/ACP process exited unexpectedly/i.test(message)) {
    return { code: 'RUNTIME_WORKER_CRASH', message }
  }
  return { code: 'RUNTIME_EXECUTION_FAILED', message }
}

interface SessionEvidence {
  inputTokens: number
  outputTokens: number
  toolCallCount: number
  toolResultCount: number
}

async function waitForSessionEvidence(root: string): Promise<SessionEvidence | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const evidence = await readSessionEvidence(root)
    if (evidence) return evidence
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

async function readSessionEvidence(root: string): Promise<SessionEvidence | undefined> {
  const paths = await findSessionLogs(root)
  let inputTokens = 0
  let outputTokens = 0
  let usageFound = false
  let toolCallCount = 0
  let toolResultCount = 0
  for (const path of paths) {
    const content = await readFile(path, 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      const event = JSON.parse(line) as unknown
      if (!isRecord(event) || typeof event['type'] !== 'string') continue
      if (event['type'] === 'tool/call') toolCallCount += 1
      if (event['type'] === 'tool/result') toolResultCount += 1
      if (event['type'] !== 'assistant/message' || !isRecord(event['data'])) continue
      const usage = event['data']['usage']
      if (!isRecord(usage) || typeof usage['inputTokens'] !== 'number' || typeof usage['outputTokens'] !== 'number') continue
      usageFound = true
      inputTokens += usage['inputTokens']
      outputTokens += usage['outputTokens']
    }
  }
  return usageFound ? { inputTokens, outputTokens, toolCallCount, toolResultCount } : undefined
}

async function findSessionLogs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSessionLogs(path))
    else if (entry.isFile() && entry.name === 'session.jsonl') paths.push(path)
  }
  return paths
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
