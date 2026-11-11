import type { SkillTestScenario } from '../../domain/skill-test-scenario.ts'

export type RuntimeRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RuntimeEventType =
  | 'run.queued'
  | 'run.started'
  | 'assistant.delta'
  | 'assistant.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'approval.required'
  | 'approval.resolved'
  | 'run.waiting'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.completed'

/**
 * Admin-side manifest purposes. Admin runs have no workspace/agent binding and
 * skip employee artifact delivery; workbench-facing runs keep `purpose`
 * undefined or use 'automation'. AG-03: 'automation' marks a scheduled
 * background run — it is still an employee run (workspace-bound, artifact
 * delivery applies), so it must NOT be classified as admin-side.
 */
export type AdminRunPurpose =
  | 'admin-assistant'
  | 'admin-skill-install'
  | 'admin-skill-test'
  | 'admin-agent-manage'
  | 'admin-platform-operations'
  | 'agent-release-trial'

export function isAdminRunPurpose(purpose: RuntimeManifest['purpose']): purpose is AdminRunPurpose {
  return purpose !== undefined && (purpose.startsWith('admin-') || purpose === 'agent-release-trial')
}

/** 模型路由方案 4.2：Manifest 中的路由快照，按使用方区分字段；不含密钥值。 */
export interface RuntimeModelRoute {
  route_id: string
  route_key: string
  provider_key: string
  provider_type: 'openai-completions'
  model_key: string
  /** 厂商地址，只供网关转发；不写入 DSH patch。 */
  base_url: string
  /** 平台加密凭据引用，只供网关解析；不含密钥值。 */
  credential_ref_id: string
  trust_level: 'internal' | 'external'
}

export interface RuntimeManifest {
  manifest_version: '1.0'
  /** Admin-authored, immutable expectations for one trial scenario. */
  test_scenario?: SkillTestScenario
  purpose?: AdminRunPurpose | 'automation' | 'agent-routine' | 'session-summary' | 'project-archive'
  /** EX-02: the Session and last message a `session-summary` run summarizes. */
  summary_target?: { session_id: string; covered_through_message_id: string }
  /** 项目空间 S2：`project-archive` 运行所整理的项目空间与整理批次。 */
  archive_target?: { workspace_id: string; update_id: string }
  installation_source?: string
  run_id: string
  attempt_id: string
  task_id: string
  session_id: string | null
  workspace_id: string
  agent_version_id: string | null
  agent_configuration: {
    system_prompt: string
    skill_instructions: Array<{
      id: string
      name?: string
      description?: string
      version: string
      instructions?: string
      artifact_ref?: string
      instructions_sha256?: string
      dependencies?: string[]
      disable_model_invocation?: boolean
      files?: Array<{ path: string; content?: string; sha256: string; size: number }>
    }>
  }
  /** 平台内置 Skill 中本次未装配的：被本次 Skill 覆盖或被 Runtime 紧急停用（builtin-skills-plan 5.3）。 */
  builtin_skill_exclusions?: Array<{
    skill: string
    reason: 'covered' | 'disabled'
    covered_by?: string
  }>
  /** Agent 固定引用、但执行镜像缺少其 Python 依赖而本次未装配的 Skill；运行说明告知模型（2026-11-04 依赖登记）。 */
  unavailable_skills?: Array<{
    skill: string
    name: string
    reason: 'python_dependency_missing'
    missing: string[]
  }>
  /**
   * 平台工具本次未装配的原因（数据防护方案 D12 补充）：默认路由不是 DeepSeek 官方时联网搜索不可用。
   * 运行说明告知模型，避免假装已经搜索。
   */
  unavailable_tools?: Array<{
    tool: 'web_search'
    reason: 'model_route_unsupported'
  }>
  user_context: {
    user_id: string
    tenant_id: string
    role_ids: string[]
  }
  /** Distinct origin, executor and human disclosure subject, pinned per Attempt. */
  principal_context?: {
    initiated_by: string
    executed_as: string
    disclosure_user_id: string
    executor_authorization_version: number
  }
  permission_policy: {
    approval_mode: 'always' | 'risk_based' | 'never'
    network_policy: 'deny' | 'allowlist'
    write_policy: 'deny' | 'workspace_only' | 'approved_targets'
  }
  skills: CapabilityReference[]
  tools: CapabilityReference[]
  /** PF-03 Attempt snapshot. Grants remain live and are rechecked before and during execution. */
  mcp_connections?: McpConnectionSnapshot[]
  data_scopes: string[]
  knowledge_context: RuntimeKnowledgeDocument[]
  /**
   * 企业知识检索结果（weknora-knowledge-plan 4.5）。缺省即 not_applicable：本次执行不支持检索。
   */
  knowledge_status?: Exclude<RuntimeKnowledgeStatus, 'not_applicable'>
  /** 所选但已删除或对员工不可见、本次跳过的知识库名称；只用于回答页脚，不进入提示词。 */
  knowledge_skipped_bases?: string[]
  /**
   * 跳过原因（企业知识库优化方案 O2）：agent_not_permitted 表示会话添加了知识库，但当前 Agent 不具备查看级别；
   * 只用于回答页脚，不进入提示词。只与 knowledge_status = skipped 同时出现。
   */
  knowledge_skipped_reason?: 'agent_not_permitted'
  /** 所选但因更换连接地址标为“原连接已更换”而跳过的知识库名称（优化方案 O9）；只用于回答页脚，不进入提示词。 */
  knowledge_moved_bases?: string[]
  /** PF-05 reviewed, ACL-filtered memory versions fixed for this Attempt. */
  memory_context?: RuntimeControlledMemory[]
  /**
   * 项目空间 S1/S2：项目任务线程的执行固定当时的项目简报与项目档案版本，至少携带其一。参考资料，不是操作授权。
   */
  project_context?: {
    brief?: {
      version_id: string
      version_no: number
      content: string
      content_sha256: string
      due_date: string | null
    }
    /** 项目空间 S2：执行时的项目档案版本（条目列表）。参考资料，不是操作授权。 */
    archive?: {
      version_id: string
      version_no: number
      items: string[]
      items_sha256: string
    }
  }
  model_route_id?: string | null
  /**
   * 模型路由方案 4.2：本 Attempt 固定的模型路由快照（不含密钥）。Adapter 据此生成 pi-ai 路由，
   * 模型网关据此校验请求模型、解析平台加密凭据并转发。升级后新建的 Attempt 必须携带。
   */
  model_route?: RuntimeModelRoute
  /** Agent 的声明随 Attempt 固定；省略仅表示没有额外能力要求。 */
  model_requirements?: Array<'long-context' | 'structured-output'>
  input: {
    message: string
    conversation_history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** EX-02: DSH-generated summary of the conversation between the first message and the recent history. */
    conversation_summary?: { content: string; covered_message_count: number; sha256: string }
    file_mounts: FileMount[]
    /**
     * 执行隔离 2b-4：装配 bash 时，输入文件的原始字节另挂在 input/original/。Manifest 只带引用与摘要，
     * 字节由 Runtime Adapter 在 Attempt 开始时按 Run 绑定读取并校验；没有 bash 的 Manifest 不得带此项。
     */
    original_mounts?: OriginalFileMount[]
  }
  /** PF-04 immutable proof used to reconstruct work in a new Attempt. */
  resume?: {
    strategy: 'new-attempt-context-v1'
    checkpoint_id: string
    checkpoint_digest: string
    source_attempt_id: string
    approval_id: string
    action_name: string
    parameter_digest: string
    resource_ref: string
    data_version: string
    approved_by: string
    approved_at: string
    checkpoint_context_sha256: string
    checkpoint_context: RuntimeResumeCheckpointContext
  }
  /** PF-02 immutable cumulative budget scope and this Attempt's reservation. */
  budget: {
    scope_task_id: string
    cumulative_limits: {
      max_duration_ms: number | null
      max_tool_calls: number | null
      max_output_bytes: number | null
    }
    reservation: {
      duration_ms: number
      tool_calls: number
      output_bytes: number
    }
    enforcement: {
      duration: 'hard'
      tool_calls: 'hard'
      output_bytes: 'hard'
      tokens: 'unsupported'
      cost: 'unsupported'
    }
  }
  limits: {
    timeout_seconds: number
    max_output_bytes: number
    max_tool_calls: number
  }
  created_at: string
  /**
   * IANA timezone the run's "now" is expressed in (a routine's schedule zone, otherwise the
   * platform default). The adapter renders `created_at` in this zone for the model.
   */
  timezone?: string
  trace_id?: string
}

export interface RuntimeResumeCheckpointContext {
  pending_action: {
    arguments: Record<string, unknown>
  }
  completed_tool_results: Array<{
    call_id: string
    tool_name: string
    parameter_digest: string
    result: unknown
  }>
  workspace_files: Array<{
    path: string
    content: string
    sha256: string
  }>
  assistant_output: string
}

export interface RuntimeControlledMemory {
  memoryVersionId: string
  title: string
  version: number
  kind: 'preference' | 'experience'
  visibility: 'private' | 'workspace' | 'organization'
  contentDigest: string
  excerpt: string
}

export interface McpConnectionSnapshot {
  connector_id: string
  server_name: string
  transport: 'streamable-http'
  endpoint: string
  auth_type: 'none' | 'bearer'
  capability_digest: string
}

/** Runtime Manifest 与租户当前可用 MCP Connector 共用的硬上限。 */
export const MAX_MCP_CONNECTIONS_PER_ATTEMPT = 20

export interface McpRuntimeConnection {
  snapshot: McpConnectionSnapshot
  headers: Record<string, string>
  /** Current reviewed capability set. Absent only during management-plane discovery. */
  capabilities?: McpInspectionResult['capabilities']
}

export interface McpInspectionResult {
  latencyMs: number
  capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

export type RuntimeKnowledgeStatus = 'not_applicable' | 'not_selected' | 'skipped' | 'ok' | 'unavailable'

export interface RuntimeKnowledgeDocument {
  documentId: string
  title: string
  version: string
  effectiveDate: string
  dataScope: string
  contentChecksum: string
  excerpt: string
}

export interface CapabilityReference {
  id: string
  version: string
}

export interface FileMount {
  file_id: string
  mount_path: string
  access: 'read_only'
  source_name: string
  media_type: string
  content_sha256: string
  content: string
  /** EX-02: the mount is this artifact version; writing a file with the same name to output/ records its next version. */
  artifact_revision?: { artifact_id: string; version: number }
}

export interface OriginalFileMount {
  file_id: string
  mount_path: string
  access: 'read_only'
  source_name: string
  media_type: string
  sha256: string
  size_bytes: number
  /** The original is this artifact version; writing the full file to output/<source_name> records its next version. */
  artifact_revision?: { artifact_id: string; version: number }
}

export interface CompiledRuntimeManifest {
  manifest: RuntimeManifest
  canonicalJson: string
  sha256: string
}

export interface RuntimeEvent {
  event_id: string
  run_id: string
  attempt_id: string
  sequence: number
  event_type: RuntimeEventType
  occurred_at: string
  display_message: string | null
  safe_metadata: Record<string, unknown>
  trace_id: string
  parent_event_id: string | null
}

export interface RuntimeExecutionSnapshot {
  runId: string
  attemptId: string
  status: RuntimeRunStatus
  acceptedAt: string
  startedAt: string | null
  endedAt: string | null
  manifestSha256: string
  attemptDirectory: string
  errorCode: string | null
  errorMessage: string | null
}

export interface RuntimeExecutionHandle {
  runId: string
  attemptId: string
  acceptedAt: string
  done: Promise<RuntimeExecutionSnapshot>
}

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'offline'
  runtimeId: string
  activeExecutions: number
  acceptingRuns: boolean
  dshRepository: string
  runtimeVersion?: string
  runtimeCommit?: string
  protocolVersion?: number
  launchMode?: 'source-checkout' | 'managed-distribution'
  transport: 'acp-stdio'
  message: string
}

export interface RuntimeToolDescriptor {
  id: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  outputValidation: 'runtime' | 'platform' | 'unavailable'
  effect: 'read' | 'write'
  retryPolicy: 'safe' | 'never' | 'verify-first'
  concurrencyPolicy: 'concurrent' | 'serialized'
  completionSemantics: 'completed' | 'accepted'
  timeoutSeconds: number
  /** DSH's own scheduling for the tool when the catalog reports it (execution isolation 3.7). */
  dshScheduling?: 'parallel' | 'exclusive'
}

export type RuntimeEventListener = (event: RuntimeEvent) => void

export type RuntimeCancelCause = 'user' | 'system_revoke'

export interface AgentRuntimePort {
  /** Optional capability admission gate; negative ports must fail without accepting work. */
  assertAvailable?(manifest?: RuntimeManifest): Promise<void>
  /** Must verify the actual execution model/endpoint and requirements, not just catalog labels.
   * Absence means that no additional model capability can be guaranteed. */
  assertModelRequirements?(requirements: NonNullable<RuntimeManifest['model_requirements']>, target: {
    providerKey: string; modelKey: string; baseUrl: string
  }): Promise<void>
  /** Execute a manifest that the durable scheduler has already admitted. */
  execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle>
  subscribe(runId: string, listener: RuntimeEventListener): () => void
  /**
   * Cancels an accepted execution. `cancelCause` defaults to 'user' (the
   * employee-facing workbench cancel path); the revocation sweep passes
   * 'system_revoke' (1A-T5) so downstream events and audits can tell the
   * two apart. The value flows into the ACP cancel request exactly as
   * before — only the recorded cause changes.
   */
  cancel(runId: string, requestedBy: string, cancelCause?: RuntimeCancelCause): Promise<{ accepted: boolean }>
  status(runId: string): RuntimeExecutionSnapshot | undefined
  health(): Promise<RuntimeHealth>
  /** Return the model-facing tools registered by the active DSH deployment. */
  listTools?(): Promise<RuntimeToolDescriptor[]>
  /** Inspect one approved Streamable HTTP target through the locked DSH MCP client. */
  inspectMcpConnection?(connection: McpRuntimeConnection): Promise<McpInspectionResult>
  /** Mirror scheduler state for health reporting; admission remains database-owned. */
  configureScheduling?(status: 'accepting' | 'draining' | 'disabled'): Promise<void>
  close(): Promise<void>
}

/** Attempt 令牌绑定（与模型网关模块的 ModelGatewayBinding 结构一致；runtime 不依赖网关模块）。 */
export interface RuntimeModelGatewayBinding {
  tenantId: string
  runId: string
  attemptId: string
  route: {
    routeId: string
    providerKey: string
    modelKey: string
    baseUrl: string
    credentialRefId: string
    trustLevel: 'internal' | 'external'
  }
  expiresAt: number
}

/**
 * 平台模型网关端口（模型路由方案 4.4～4.7）：Adapter 为正式执行签发令牌、终态吊销，并在失败时按网关记录分类。
 */
export interface RuntimeModelGatewayPort {
  readonly baseUrl: string
  issueToken(binding: RuntimeModelGatewayBinding): string
  revokeToken(attemptId: string): void
  /** 按本 Attempt 的对话请求记录分类，一次查询同时给出对话请求数（不含联网搜索）。 */
  inspectAttemptFailure(tenantId: string, attemptId: string): Promise<{
    failure: { code: string; message: string } | undefined
    chatRequests: number
  }>
}
