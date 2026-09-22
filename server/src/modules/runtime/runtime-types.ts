import type { SkillTestScenario } from '../../domain/skill-test-scenario.ts'
import type { ManifestToolBinding } from '../../domain/tool-binding.ts'

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

export interface RuntimeManifest {
  manifest_version: '1.0'
  /** Admin-authored, immutable expectations for one trial scenario. */
  test_scenario?: SkillTestScenario
  purpose?: AdminRunPurpose | 'automation'
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
  user_context: {
    user_id: string
    tenant_id: string
    role_ids: string[]
  }
  permission_policy: {
    approval_mode: 'always' | 'risk_based' | 'never'
    network_policy: 'deny' | 'allowlist'
    write_policy: 'deny' | 'workspace_only' | 'approved_targets'
  }
  skills: CapabilityReference[]
  tools: CapabilityReference[]
  /**
   * B-03/I-04：本 Attempt 固定的平台工具绑定修订（tool = id@version 平台引用）。
   * 执行边界复核据此验证绑定仍 active 且语义未漂移；无平台工具的清单省略该字段。
   */
  tool_bindings?: ManifestToolBinding[]
  /** PF-03 Attempt snapshot. Grants remain live and are rechecked before and during execution. */
  mcp_connections?: McpConnectionSnapshot[]
  data_scopes: string[]
  knowledge_context: RuntimeKnowledgeDocument[]
  /** PF-05 reviewed, ACL-filtered memory versions fixed for this Attempt. */
  memory_context?: RuntimeControlledMemory[]
  model_route_id?: string | null
  /** Agent 的声明随 Attempt 固定；省略仅表示没有额外能力要求。 */
  model_requirements?: Array<'long-context' | 'structured-output'>
  input: {
    message: string
    conversation_history?: Array<{ role: 'user' | 'assistant'; content: string }>
    file_mounts: FileMount[]
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
