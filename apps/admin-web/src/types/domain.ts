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

export interface ExperienceIterationAgentSummary {
  agentId: string
  agentName: string
  agentVersion: string
  agentStatus: string
  totalApplications: number
  pendingApplications: number
  approvedApplications: number
  rejectedApplications: number
  latestApplicationAt: string | null
}

/** AE-04 已发布经验；当前版本为空表示已停用，不再被检索。 */
export interface AgentExperience {
  entryId: string
  agentId: string
  title: string
  currentVersionId: string | null
  versions: Array<{
    id: string
    version: number
    title: string
    content: string
    contentDigest: string
    publishedAt: string
    publishedBy: string
    usable: boolean
  }>
  updatedAt: string
}

export interface ExperienceIterationApplication {
  id: string
  agentId: string
  agentName: string
  sourceAgentVersionId: string
  sourceAgentVersion: string
  sourceRunId: string
  sourceAttemptId: string
  proposedBy: string
  title: string
  content: string
  contentDigest: string
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  reviewComment: string | null
  publishedVersionId: string | null
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
  identityProvider: 'prototype-sso' | 'ai-hub-oidc' | 'local-password'
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

export interface AgentAccessRoleOption {
  id: string
  name: string
  status: 'active' | 'disabled'
  /** 角色带有管理端或审计权限；授予 Agent 时提示风险。旧服务端未返回时视为 false。 */
  privileged?: boolean
}

export interface IdentityUserSummary {
  id: string
  externalUserId: string | null
  username?: string | null
  loginAccount: string | null
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
  /** 管理员紧急停用的 DSH 内置工具；新运行不再装配，在途运行下一次调用被拒绝。 */
  disabledTools: string[]
  /** 管理员紧急停用的平台内置 Skill；新运行不再装配，在途运行再激活时被拒绝。 */
  disabledBuiltinSkills: string[]
}

/** 内置工具注册表条目：随代码发布，只读展示。 */
export interface BuiltinTool {
  name: string
  label: string
  source: 'dsh' | 'platform'
  effect: 'read' | 'write'
  risk: 'low' | 'medium'
  assembly: 'always' | 'agent-opt-in' | 'runtime' | 'purpose' | 'workspace' | 'execution-container'
  constraints: string[]
}

export interface BuiltinToolStatus {
  tools: BuiltinTool[]
  disabledTools: string[]
  /** 服务启动时与 DSH 工具目录的比对结果；未比对时为 null。 */
  catalog: { checkedAt: string; missingTools: string[] } | { checkedAt: string; error: string } | null
  /** 本次启动的执行容器状态：不可用时所有 Agent 运行被拒绝（执行隔离方案 4.9）。 */
  executionContainer: {
    status: 'available' | 'unavailable'
    /** 数据卷剩余空间低于阈值，暂不运行命令（执行隔离 4.7）。 */
    diskLow?: boolean
  }
}

export interface UpdateRuntimeConfigurationInput {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
  /** 省略时保留当前停用清单。 */
  disabledTools?: string[]
  /** 省略时保留当前内置 Skill 停用清单。 */
  disabledBuiltinSkills?: string[]
}

export type BuiltinSkillScenario = 'file-analysis' | 'html-page' | 'office-document'

/** 平台内置 Skill：随代码发布，只读展示。 */
export interface BuiltinSkill {
  id: string
  name: string
  description: string
  version: string
  scenario: BuiltinSkillScenario
  instructions: string
  tools: string[]
  files: Array<{ path: string; size: number }>
}

export interface BuiltinSkillStatus {
  skills: BuiltinSkill[]
  scenarios: Array<{ id: BuiltinSkillScenario; label: string }>
  disabledBuiltinSkills: string[]
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

/** 验证时草稿冻结为 candidate（不可变），通过验证后发布为 published。 */
export type AgentVersionStatus = PublishStatus | 'candidate'

export type AgentMcpScope =
  | { mode: 'none'; connectorIds: [] }
  | { mode: 'selected'; connectorIds: string[] }

export interface AgentDefinition {
  id: string
  name: string
  description: string
  owner: string
  department: string
  /** 员工可见范围的摘要文字，由 roleIds 派生。 */
  visibility: string
  /** Agent 级可见角色：哪些角色可以向它请求工作；在岗位权限中修改，立即生效。 */
  roleIds: string[]
  allowWorkspaceJoin: boolean
  status: PublishStatus
  version: string
  /** 当前版本指针指向的已发布版本；从未发布时为 null。`version` 是工作版本（有草稿时为草稿）。 */
  activeVersion?: string | null
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  workInstructions?: string | null
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  /** 平台工具引用（id@version）；旧数据或未返回时视为空。 */
  tools?: string[]
  /** 是否允许联网搜索（web_search）；其他内置工具由平台统一装配。 */
  webSearchEnabled: boolean
  /** 是否允许项目任务管理（project_task_*）。 */
  projectTasksEnabled: boolean
  mcpScope?: AgentMcpScope
  updatedAt: string
  /** 草稿编辑的乐观并发修订，保存时回传为 expectedRevision；原型模式不提供。 */
  revision?: string
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

/** S2 岗位权限：谁可以向 Agent 请求工作、它持有哪些岗位角色、能接触哪些数据。属于 Agent，修改立即生效。 */
export interface AgentCapabilityRequirement {
  reference: string
  name: string
  source: 'declared' | 'default'
  requiredRoleIds: string[]
  requiredScopes: string[]
  missingRole: boolean
  missingScopes: string[]
}

export interface AgentAccess {
  agentId: string
  /** 乐观并发修订号，保存时回传为 expectedRevision。 */
  revision: number
  principalId: string
  principalStatus: 'active' | 'disabled'
  visibleRoleIds: string[]
  roleIds: string[]
  dataScopes: string[]
  roleOptions: AgentAccessRoleOption[]
  scopeOptions: string[]
  capabilities: AgentCapabilityRequirement[]
  routines: Array<{
    id: string; name: string; status: string; schedule: Partial<AgentRoutineSchedule>
    recipientUserId: string; recipientName: string
  }>
}

export interface UpdateAgentAccessInput {
  expectedRevision: number
  visibleRoleIds: string[]
  roleIds: string[]
  dataScopes: string[]
  principalStatus?: 'active' | 'disabled'
}

export type AgentRoutineSchedule =
  | { kind: 'manual'; timezone: string }
  | { kind: 'daily' | 'weekly'; timezone: string; timeOfDay: string; weekdays?: number[] }
  | { kind: 'event'; timezone: string; eventType: string }

export interface AgentRoutine {
  id: string
  agentId: string
  agentVersionId: string
  workspaceId: string
  recipientUserId: string
  name: string
  schedule: AgentRoutineSchedule
  scheduleRevision: number
  nextSlotUtc: string | null
  inputTemplate: { prompt: string; budget: { timeoutSeconds?: number; maxToolCalls?: number; maxOutputBytes?: number } }
  approvedRoleIds: string[]
  approvedDataScopes: string[]
  revision: number
  status: 'draft' | 'enabled' | 'paused' | 'disabled'
  lastAdmissionStatus?: 'accepted' | 'skipped' | 'interrupted' | null
  lastReasonCode?: string | null
  createdBy: string
  approvedBy: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentRoutineExecution {
  id: string
  routineId: string
  triggerId: string
  kind: 'scheduled' | 'manual' | 'event' | 'missed'
  plannedSlotUtc: string | null
  missedFromUtc: string | null
  missedToUtc: string | null
  taskId: string | null
  runId: string | null
  admissionStatus: 'accepted' | 'skipped' | 'interrupted'
  reasonCode: string | null
  runStatus?: string | null
  resultOutcome?: string | null
  createdAt: string
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
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  workInstructions?: string | null
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  /** 编辑时省略则保留当前设置，新建时默认关闭。 */
  webSearchEnabled?: boolean
  /** 编辑时省略则保留当前设置，新建时默认关闭。 */
  projectTasksEnabled?: boolean
  mcpScope?: AgentMcpScope
  changeSummary: string
}

export interface CreateAgentDraftInput extends AgentDraftConfiguration {
  executionRoleIds?: string[]
  executionDataScopes?: string[]
}

export interface UpdateAgentDraftInput extends Omit<AgentDraftConfiguration, 'id'> {
  agentId: string
  /** 打开编辑器时读取的修订；Agent 已被其他操作修改时服务端拒绝保存。 */
  expectedRevision?: string
}

export interface AgentVersionRecord {
  id: string
  agentId: string
  version: string
  status: AgentVersionStatus
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
  sourceVersion?: string
  summary: string
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  workInstructions?: string | null
  maxOutputBytes: number
  maxToolCalls: number
  timeoutSeconds: number
  skills: string[]
  tools?: string[]
  webSearchEnabled: boolean
  projectTasksEnabled: boolean
  mcpScope?: AgentMcpScope
}

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
  admissionStatus?: 'approved' | 'unavailable'
  admissionMessage?: string
  inputSchema: string
  outputSchema: string
  outputValidation: 'runtime' | 'platform' | 'unavailable'
  retryPolicy: 'safe' | 'never' | 'verify-first'
  concurrencyPolicy: 'concurrent' | 'serialized'
  completionSemantics: 'completed' | 'accepted'
  timeoutSeconds: number
  allowedRoleIds: string[]
  allowedRoles: string[]
  dataScopes: string[]
  agentRunLocalDefault?: boolean
  approvalPolicy: 'none' | 'sensitive' | 'always'
  lastCheckedAt: string
}

export interface ToolCatalogSyncResult {
  tools: ToolDefinition[]
  discoveredCount: number
  admittedCount: number
  unavailableCount: number
  synchronizedAt: string
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
  /** 管理员设置的“覆盖内置场景”：运行中有该 Skill 时去掉对应场景的平台内置 Skill。 */
  coveredBuiltinScenarios?: BuiltinSkillScenario[]
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
    /** 生效清单：Agent 运行时只能调用这些 Tool。 */
    capabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    /** 已发现但未生效的 Tool（新增或输入 Schema 变化），须管理员确认。 */
    pendingCapabilities: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
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
  sso: 'mock' | 'ai-hub-oidc' | 'local-password'
  dshRuntime: 'not-connected' | 'poc-validated' | 'connected'
  database: 'not-configured' | 'configured' | Record<string, unknown>
  artifactStorage: 'not-configured' | 'local-mvp'
}

/* ---------- Agent 验证与发布（S3，与 server agent-validation 契约对齐） ---------- */

export type ValidationCaseSource = 'example' | 'routine' | 'custom'
export type ValidationCaseStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled'

/** 固定三项机器检查；不全部通过时不能判为通过。 */
export interface ValidationChecks {
  runRecorded: boolean
  executionSucceeded: boolean
  outputNonEmpty: boolean
}

export interface ValidationCase {
  id: string
  position: number
  source: ValidationCaseSource
  sourceRef: string | null
  prompt: string
  status: ValidationCaseStatus
  runId: string | null
  attemptId: string | null
  runCount: number
  checks: ValidationChecks | null
  output: string
  error: string | null
  verdict: 'passed' | 'failed' | null
  verdictNote: string | null
  verdictBy: string | null
  verdictAt: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface AgentValidation {
  id: string
  agentId: string
  agentVersionId: string
  version: string
  status: 'running' | 'completed' | 'superseded' | 'published'
  createdBy: string
  createdAt: string
  completedAt: string | null
  cases: ValidationCase[]
  publishable: boolean
}

export interface AgentReleaseCheck {
  id: 'audience' | 'roles' | 'principal' | 'dependencies' | 'authorization' | 'mcp' | 'cases' | 'bindings'
  label: string
  passed: boolean
  detail: string
  /** 不阻断验证的提示。 */
  warning?: string
}

export interface AgentReleaseOverview {
  agentId: string
  activeVersion: { id: string; version: string } | null
  draft: { id: string; version: string; status: 'draft' | 'candidate' } | null
  candidate: { id: string; version: string } | null
  draftChanged: boolean
  testCases: Array<{ id: string; prompt: string }>
  plannedCases: Array<{ source: ValidationCaseSource; sourceRef: string | null; prompt: string }>
  checks: AgentReleaseCheck[]
  usesMcp: boolean
  validation: AgentValidation | null
}

export type AgentRunSource = 'conversation' | 'validation' | 'routine' | 'automation' | 'api' | 'event' | 'system'

/** 以 Agent 执行身份运行的最近 Run（详情页运行记录）。 */
export interface AgentRunSummary {
  runId: string
  status: string
  source: AgentRunSource
  version: string | null
  requestedBy: string
  sessionTitle: string | null
  errorCode: string | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface AgentVersionHistoryItem {
  id: string
  version: string
  status: AgentVersionStatus
  summary: string
  createdAt: string
  createdBy: string
  publishedAt: string | null
  publishedBy: string | null
  active: boolean
}
