/** Admin API DTOs. They are intentionally owned by the management application. */
export type AdminRole = 'business_admin' | 'platform_admin' | 'auditor'

export interface PersistentApproval {
  id: string
  runId: string
  taskId: string
  sourceAttemptId: string
  checkpointId: string
  checkpointDigest: string
  actionName: string
  parameterDigest: string
  resourceRef: string
  executionIdentity: string
  executorPrincipalId?: string | null
  resolverPrincipalId?: string | null
  dataVersion: string
  riskLevel: 'medium' | 'high'
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  expiresAt: string
  requestedAt: string
  resolvedBy: string | null
  resolvedAt: string | null
  resumedAttemptId: string | null
  actionConsumedAt: string | null
}

export interface ControlledMemoryCandidate {
  id: string
  consentId: string
  memoryKey: string
  kind: 'preference' | 'experience'
  title: string
  content: string
  contentDigest: string
  visibility: 'private' | 'workspace' | 'organization'
  scopeRef: string
  retentionUntil: string
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'
  submittedBy: string
  reviewedBy: string | null
  reviewedAt: string | null
  reviewComment: string | null
  approvedEntryId: string | null
  approvedVersionId: string | null
  createdAt: string
}

export interface AdminUserProfile {
  id: string
  name: string
  title: string
  department: string
  avatarText: string
  role: AdminRole
  dataScopes: string[]
}

export interface AdminSession {
  user: AdminUserProfile
  identityProvider: 'prototype-sso' | 'ai-hub-oidc'
  apiAudience: 'admin'
  permissions: string[]
}

export interface IdentityRoleSummary {
  id: string
  code: string
  name: string
  description: string
  status: 'active' | 'disabled'
  permissions: string[]
  dataScopes: string[]
  userCount: number
  system: boolean
  updatedAt: string
}

export interface AgentPrincipalRoleOption {
  id: string
  name: string
  status: 'active' | 'disabled'
}

export interface IdentityUserSummary {
  id: string
  externalUserId: string | null
  name: string
  email: string | null
  department: string
  status: 'active' | 'disabled'
  identityProvider: 'local' | 'ai-hub'
  directorySyncedAt: string | null
  authorizationVersion: number
  roles: Array<Pick<IdentityRoleSummary, 'id' | 'code' | 'name' | 'status'>>
  dataScopes: string[]
  activeSessionCount: number
  lastSeenAt: string | null
}

export interface IdentityUserPage {
  items: IdentityUserSummary[]
  total: number
  page: number
  pageSize: number
  summary: {
    synchronized: number
    active: number
    authorized: number
  }
}

export interface LocalPermissionDefinition {
  code: string
  name: string
  category: string
  description: string
}

export interface DirectorySyncState {
  applicationId: string
  environment: string
  cursor: string | null
  status: 'idle' | 'running' | 'failed'
  lastStartedAt: string | null
  lastSucceededAt: string | null
  lastError: string | null
  synchronizedUsers: number
  updatedAt: string
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface AdminTaskSummary {
  id: string
  status: RunStatus
}

export interface RuntimeDefinition {
  id: string
  name: string
  environment: string
  mode: 'prototype' | 'dsh-worker'
  status: 'healthy' | 'degraded' | 'offline'
  schedulingStatus: 'accepting' | 'draining' | 'disabled'
  version: string
  endpoint: string
  maxConcurrentWorkers: number
  activeWorkers: number
  queuedRuns: number
  attemptTimeoutMinutes: number
  lastHeartbeat: string
  checkedAt: string
  healthMessage: string
  capabilities: string[]
}

export interface DshRuntimeToolConnectorStatus {
  runtimeId: string | null
  connectorId: string
  name: string
  status: 'healthy' | 'degraded' | 'offline' | 'disabled'
  endpoint: string
  toolCount: number
  activeBindingCount: number
  latestBindingRevision: number | null
  catalogDigest: string
  lastCheckedAt: string
  lastHealthMessage: string
}

export interface UpdateRuntimeConfigurationInput {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
}

export interface SessionDefinition {
  id: string
  title: string
  user: string
  workspaceId: string
  workspaceName: string
  agentId: string
  agentName: string
  agentVersion: string
  runId: string
  status: RunStatus
  runCount: number
  messageCount: number
  tokenUsage: number
  createdAt: string
  updatedAt: string
  traceId: string
}

export interface ManagedWorkspaceDefinition {
  id: string
  name: string
  description: string
  type: 'team'
  creator: string
  memberCount: number
  sessionCount: number
  artifactCount: number
  fileCount: number
  createdAt: string
  updatedAt: string
}

export type PublishStatus = 'draft' | 'published' | 'disabled'

export interface AgentDelegationPolicy {
  allowedAgentVersionIds: string[]
  maxDepth: number
  maxParallel: number
  timeoutSeconds: number
}

export interface AgentDefinition {
  id: string
  name: string
  description: string
  owner: string
  department: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  allowWorkspaceJoin: boolean
  status: PublishStatus
  version: string
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  delegationPolicy?: AgentDelegationPolicy
  updatedAt: string
}

export interface AgentJoinedWorkspaceRecord {
  workspaceId: string
  workspaceName: string
  workspaceType: 'personal' | 'team'
  workspaceStatus: string
  memberStatus: 'available' | 'disabled'
  version: string
  addedBy: string
  createdAt: string
}

export interface AgentPrincipalGovernance {
  principalId: string
  agentId: string
  status: 'active' | 'disabled'
  authorizationVersion: number
  roleIds: string[]
  dataScopes: string[]
}

export interface GrantSourceReconciliationItem {
  sourceId: string
  workspaceId: string
  workspaceName: string
  capabilityType: 'agent' | 'skill' | 'tool'
  capabilityVersionId: string
  capabilityLabel: string
  createdBy: string
  createdAt: string
  possibleAgents: Array<{
    agentId: string
    agentName: string
    versionId: string
    version: string
    agentStatus: string
  }>
  inferenceNote: string
}

export interface GrantSourceReconciliationView {
  items: GrantSourceReconciliationItem[]
  workspaceSummary: Array<{ workspaceId: string, workspaceName: string, unresolvedCount: number }>
}

export interface AgentDraftConfiguration {
  id: string
  name: string
  description: string
  owner: string
  department: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  delegationPolicy: AgentDelegationPolicy
  changeSummary: string
}

export interface CreateAgentDraftInput extends AgentDraftConfiguration {
  executionRoleIds?: string[]
  executionDataScopes?: string[]
}

export interface UpdateAgentDraftInput extends Omit<AgentDraftConfiguration, 'id'> {
  agentId: string
}

/** B-03/I-04：发布时固定的平台工具绑定修订引用。 */
export interface AgentBindingRef {
  tool: string
  binding_id: string
  revision: number
  digest: string
}

/** /tools/bindings 返回的绑定修订（不含密钥值）。 */
export interface ToolBindingRecord {
  tool: string
  bindingId: string
  revision: number
  digest: string
  connectorId: string
  executor: string
  endpoint: string
  credentialRef: string | null
  identityPolicy: string
  environment: string
  approvalPolicy: string
  status: 'active' | 'superseded' | 'revoked'
  sealedAt: string
}

export interface AgentVersionRecord {
  id: string
  agentId: string
  version: string
  status: PublishStatus
  bindingRefs?: AgentBindingRef[]
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
  sourceVersion?: string
  summary: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  delegationPolicy?: AgentDelegationPolicy
}

export interface AgentReleaseRecord {
  id: string
  agentId: string
  version: string
  action: 'published' | 'enabled' | 'disabled' | 'rollback'
  actor: string
  time: string
  note: string
}

export interface SkillDefinition {
  packageSha256?: string
  installationRole?: 'standalone' | 'root' | 'dependency'
  dependencies?: SkillDependencySummary[]
  id: string
  name: string
  version: string
  activeVersion?: string
  category: string
  owner: string
  status: PublishStatus
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  updatedAt: string
}

export interface SkillDependencySummary {
  id: string
  name: string
  version: string
  status: PublishStatus
  depth: number
}

export interface SkillVersionRecord {
  id: string
  skillId: string
  version: string
  name: string
  category: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  status: PublishStatus
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
  sourceVersion?: string
  summary: string
}

export interface SkillReleaseRecord {
  id: string
  skillId: string
  version: string
  action: 'published' | 'enabled' | 'disabled' | 'rollback'
  actor: string
  time: string
  note: string
}

export interface SkillTestRunProgress {
  runId: string
  skillId: string
  version: string
  status: 'queued' | 'running' | 'waiting' | 'cancel_requested' | 'passed' | 'failed' | 'cancelled'
  resultSummary?: string
  testedAt?: string
  steps: Array<{
    id: string
    title: string
    description: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    occurredAt?: string
  }>
}

export interface SkillConfiguration {
  id: string
  name: string
  category: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
}

export type CreateSkillInput = Omit<SkillConfiguration, 'id'>

export interface UpdateSkillInput extends Omit<SkillConfiguration, 'id'> {
  skillId: string
}

export interface ToolDefinition {
  id: string
  version?: string
  name: string
  system: string
  description: string
  connectorId: string
  risk: 'low' | 'medium' | 'high'
  mode: 'read' | 'write'
  status: 'available' | 'degraded' | 'disabled'
  inputSchema: string
  outputSchema: string
  outputValidation: 'runtime' | 'platform' | 'unavailable'
  retryPolicy: 'safe' | 'never' | 'verify-first'
  concurrencyPolicy: 'concurrent' | 'serialized'
  completionSemantics: 'completed' | 'accepted'
  timeoutSeconds: number
  allowedRoles: string[]
  dataScopes: string[]
  approvalPolicy: 'none' | 'sensitive' | 'always'
  lastCheckedAt: string
}

export interface ToolCatalogCandidate {
  id: string
  version: string
  name: string
  system: string
  description: string
  connectorId: string
  risk: ToolDefinition['risk']
  mode: ToolDefinition['mode']
  timeoutSeconds: number
  defaultAllowedRoles: string[]
  defaultDataScopes: string[]
  defaultApprovalPolicy: ToolDefinition['approvalPolicy']
  requirements: string[]
  outputValidation: ToolDefinition['outputValidation']
  retryPolicy: ToolDefinition['retryPolicy']
  concurrencyPolicy: ToolDefinition['concurrencyPolicy']
  completionSemantics: ToolDefinition['completionSemantics']
  status: 'ready' | 'installed' | 'unavailable'
  availabilityMessage: string
}

export interface ConnectorDefinition {
  id: string
  name: string
  system: string
  status: 'healthy' | 'degraded' | 'offline' | 'disabled'
  toolCount: number
  protocol: 'runtime' | 'rest' | 'openapi' | 'mcp' | 'database'
  endpoint: string
  authType: string
  credentialRef: string
  scopeDescription: string
  latency: string
  lastCheckedAt: string
  lastHealthMessage?: string
  createdAt?: string
  createdBy?: string
  updatedAt?: string
  mcp?: {
    serverName: string
    transport: 'streamable-http'
    approvalStatus: 'draft' | 'pending_review' | 'approved' | 'changes_pending'
    capabilityDigest: string | null
    approvedDigest: string | null
    capabilityCount: number
    capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    discoveredAt: string | null
    reviewedAt: string | null
    reviewedBy: string | null
  }
}

export interface McpConnectionTestResult {
  status: 'reachable'
  endpoint: string
  latencyMs: number
  capabilityCount: number
  capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

export interface McpConnectorDeletionResult {
  connectorId: string
  credentialDestroyed: boolean
}

export interface McpInvocationAudit {
  id: string
  runId: string
  attemptId: string
  connectorId: string
  actorUserId: string
  executorPrincipalId?: string | null
  capabilityName: string
  parameterDigest: string
  result: 'success' | 'failed' | 'unknown'
  occurredAt: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  department: string
  category: 'management' | 'security' | 'run' | 'model' | 'tool' | 'artifact'
  action: string
  objectType: string
  objectId: string
  object: string
  status: 'success' | 'failed' | 'blocked'
  traceId: string
  runId: string | null
  attemptId: string | null
  detail: string
}

export interface OperationsSummary {
  runs24h: number
  successfulRuns24h: number
  failedRuns24h: number
  modelTokens24h: number
  toolCalls24h: number
  artifacts24h: number
  attentionEvents24h: number
}

export interface HealthComponent {
  id: string
  name: string
  category: 'application' | 'runtime' | 'dependency'
  status: 'healthy' | 'warning' | 'offline'
  detail: string
  message: string
  checkedAt: string
}

export interface UsagePoint {
  day: string
  runs: number
  tokens: number
}

export interface ModelUsageRecord {
  id: string
  time: string
  runId: string
  agentId: string
  employeeId: string
  employeeName: string
  department: string
  provider: string
  model: string
  modelRoute: string
  status: 'success' | 'failed' | 'blocked'
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  traceId: string
}

export interface ListPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface SessionListPage extends ListPage<SessionDefinition> {
  summary: {
    total: number
    active: number
    awaitingApproval: number
    failed: number
  }
  facets: {
    workspaces: { id: string; name: string }[]
  }
}

export interface ModelUsagePage extends ListPage<ModelUsageRecord> {
  summary: {
    callCount: number
    employeeCount: number
    totalTokens: number
    averageLatencyMs: number
  }
  facets: {
    providers: string[]
    employees: { employeeId: string; employeeName: string; department: string }[]
  }
}

export interface EmployeeModelUsageSummary {
  employeeId: string
  employeeName: string
  department: string
  callCount: number
  successCount: number
  failedCount: number
  blockedCount: number
  successRate: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  averageLatencyMs: number
  lastUsedAt: string
}

export type ProviderStatus = 'active' | 'disabled'
export type CredentialBackend = 'dsh-managed' | 'keychain' | 'secret-manager'
export type CredentialStatus = 'configured' | 'missing' | 'revoked'
export type ModelRoutePurpose = 'default' | 'chat' | 'analysis' | 'fallback'

export interface CredentialReference {
  id: string
  backend: CredentialBackend
  externalRef: string
  status: CredentialStatus
  lastVerifiedAt: string | null
  updatedAt: string
}

export interface ProviderModel {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  status: 'active' | 'disabled'
}

export interface ModelProvider {
  id: string
  key: string
  name: string
  providerType: string
  baseUrl: string
  status: ProviderStatus
  credential: CredentialReference | null
  models: ProviderModel[]
  updatedAt: string
}

export interface ModelRoute {
  id: string
  key: string
  name: string
  purpose: ModelRoutePurpose
  providerModelId: string
  providerId: string
  providerName: string
  modelKey: string
  modelName: string
  priority: number
  enabled: boolean
  updatedAt: string
}

export interface PlatformStatus {
  architecture: 'node-modular-monolith'
  persistence: 'prototype-memory' | 'postgres-foundation' | 'postgres'
  sso: 'mock' | 'ai-hub-oidc'
  dshRuntime: 'not-connected' | 'poc-validated' | 'connected'
  database: 'not-configured' | 'configured' | Record<string, unknown>
  artifactStorage: 'not-configured' | 'local-mvp'
}

/* ---------- Agent 发布治理（与 server agent-release 契约对齐） ---------- */

export type AgentSubmissionStatus = 'draft' | 'submitted' | 'changes_requested' | 'published' | 'withdrawn'

export interface AgentEvalCase {
  id: string
  evaluationApiVersion: 'dsh-work.ai/evaluation/v1'
  name: string
  kind: 'success' | 'invalid_input' | 'permission_denied' | 'prompt_injection' | 'capability_failure'
  input: string
  automatedAssertions: Array<'run_attempt_recorded' | 'execution_succeeded' | 'output_non_empty'>
  manualReview: { required: true; rubric: string }
  /** 平台按定义自动生成的默认案例来源标记；包内 evals 或管理员登记的案例无此字段 */
  origin?: 'generated'
}

export interface AgentCapabilityRef { id: string; version: string; path?: string }

export type AgentCheckStatus = 'passed' | 'failed' | 'pending'
export interface AgentCheckItem { id: string; label: string; status: AgentCheckStatus; detail: string }

export interface AgentPlanItem {
  kind: 'agent' | 'skill' | 'tool' | 'binding'
  name: string
  action: 'create' | 'reuse' | 'upgrade' | 'blocked'
  version: string
  detail: string
}

export type AgentTrialStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

/** 单个评估案例的真实执行证据与审核人逐项确认结论。 */
export interface AgentTrialCaseRun {
  caseId: string
  name: string
  kind: AgentEvalCase['kind']
  /** JSONB 中可能仍有升级前试运行；缺少 v1 字段时管理端必须降级展示并阻止发布。 */
  evaluationApiVersion?: AgentEvalCase['evaluationApiVersion']
  automatedAssertions?: Array<{
    assertion: AgentEvalCase['automatedAssertions'][number]
    passed: boolean
    detail: string
  }>
  manualReview?: AgentEvalCase['manualReview']
  expect?: string
  runId?: string | null
  attemptId?: string | null
  status: string
  outputExcerpt: string
  error?: string
  verdict?: 'passed' | 'failed'
  verdictNote?: string
}

export interface AgentTrialStep { id: string; label: string; status: AgentTrialStepStatus; detail?: string; caseRuns?: AgentTrialCaseRun[] }

export interface AgentTrialRun {
  id: string
  submissionRevision: number
  status: 'checking' | 'queued' | 'executing' | 'asserting' | 'passed' | 'failed' | 'cancelled'
  steps: AgentTrialStep[]
  startedAt: string
  finishedAt?: string
  failureStage?: string
}

export interface AgentReleaseCandidate {
  id: string
  agentId: string
  agentVersionId: string
  version: string
  revision: number
  status: AgentSubmissionStatus
  source: 'config' | 'zip'
  sealedRevision?: number
  sealedAt?: string
  /** B-03/I-04：封存时固定的平台绑定依据。 */
  bindingRefs: AgentBindingRef[]
  cases: AgentEvalCase[]
  packageRefs: { skills: AgentCapabilityRef[]; tools: AgentCapabilityRef[] }
  missingDeps: { skills: string[]; tools: string[] }
  checks: AgentCheckItem[]
  plan: AgentPlanItem[]
  reviewNote?: string
}

export interface AgentVersionEvidence {
  kind: 'configuration_checked' | 'runtime_verified' | 'business_accepted'
  summary: string
  runId?: string
  at: string
  by: string
  scope: string
}

export interface AgentReleaseState {
  candidate?: AgentReleaseCandidate
  trialRuns: AgentTrialRun[]
  /** key = 版本号字符串 */
  evidence: Record<string, AgentVersionEvidence[]>
  packageWarnings: string[]
  /** 只读标记：草稿相对候选已变更/尚未同步（由 POST candidate 端点负责落库） */
  definitionChanged?: boolean
}

export interface AgentSubmissionSummary {
  agentId: string
  revision: number
  status: AgentSubmissionStatus
  source: 'config' | 'zip'
}

export interface AgentVersionEvidenceEntry {
  agentId: string
  version: string
  evidence: AgentVersionEvidence[]
}

export interface AgentPackageInspection {
  fileName: string
  manifest: { id: string; name: string; version: string; description: string }
  files: string[]
  systemPrompt: string
  resolved: { skills: string[]; tools: string[] }
  missing: { skills: string[]; tools: string[] }
  packageRefs: { skills: AgentCapabilityRef[]; tools: AgentCapabilityRef[] }
  cases: Array<Omit<AgentEvalCase, 'id'>>
  warnings: string[]
}
