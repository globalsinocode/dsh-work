import type { SkillTestScenario } from '../../domain/skill-test-scenario.ts'
import type { ManifestToolBinding } from '../../domain/tool-binding.ts'

export type RuntimeRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
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
  session_id: string
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
  data_scopes: string[]
  knowledge_context: RuntimeKnowledgeDocument[]
  model_route_id?: string | null
  /** Agent 的声明随 Attempt 固定；省略仅表示没有额外能力要求。 */
  model_requirements?: Array<'long-context' | 'structured-output'>
  input: {
    message: string
    conversation_history?: Array<{ role: 'user' | 'assistant'; content: string }>
    file_mounts: FileMount[]
  }
  limits: {
    timeout_seconds: number
    max_output_bytes: number
    max_tool_calls: number
  }
  created_at: string
  trace_id?: string
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
  /** Mirror scheduler state for health reporting; admission remains database-owned. */
  configureScheduling?(status: 'accepting' | 'draining' | 'disabled'): Promise<void>
  close(): Promise<void>
}
