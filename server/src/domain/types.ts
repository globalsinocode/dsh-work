/** Prototype server domain model. Frontend applications own their API DTOs independently. */
import type { TaskResult } from './task-result.ts'

export type UserRole = 'employee' | 'department_manager' | 'business_admin' | 'platform_admin' | 'auditor'

/** Versioned Agent policy; Connector administration and credentials stay tenant-owned. */
export type AgentMcpScope =
  | { mode: 'none'; connectorIds: [] }
  | { mode: 'selected'; connectorIds: string[] }

export interface UserProfile {
  id: string
  name: string
  title: string
  department: string
  avatarText: string
  role: UserRole
  dataScopes: string[]
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_approval'

export interface RunStep {
  id: string
  title: string
  detail: string
  status: StepStatus
  tool?: string
  /** EX-01：工具调用步骤所属的调用；快照与实时事件按它合并为同一行。 */
  callId?: string
  duration?: string
  /** EX-PROGRESS-01：步骤来源的运行事件类型（如 `run.started`、`tool.completed`）。 */
  event?: string
  /** 来源事件的服务端发生时间（ISO）；工具调用结果步骤为调用结束时间。 */
  at?: string
  /** 工具调用开始时间（ISO，取同一调用的 `tool.started`）；未收到开始事件时缺省。 */
  startedAt?: string
}

export interface TaskSource {
  id: string
  type: 'knowledge' | 'erp' | 'mes' | 'file'
  title: string
  description: string
  version?: string
  effectiveAt?: string
  dataScope?: string
  synthetic?: boolean
  updatedAt?: string
}

export interface Artifact {
  id: string
  name: string
  type: 'xlsx' | 'docx' | 'pptx' | 'pdf' | 'png' | 'jpg' | 'markdown' | 'csv' | 'text' | 'html'
  version: number
  size: string
  createdAt: string
  runId: string
  workspaceId: string
  /** The artifact version's file; with canReference it can be attached to the next message. */
  fileId?: string
  canReference?: boolean
  /**
   * Office/PDF artifacts only (execution isolation 2b-5): whether the version's extracted text can be
   * previewed (`pending` while it has not been extracted); `textPreviewError` says why it failed.
   */
  textPreview?: 'available' | 'failed' | 'pending'
  textPreviewError?: string
  summary: string
  /**
   * 项目空间成果的来源（团队空间才返回）：所属项目任务、承接 Agent 及版本、发起人。
   * 个人空间与无法解析时为 null。
   */
  origin?: ArtifactOrigin | null
}

export interface ArtifactOrigin {
  projectTask: { id: string; title: string } | null
  agent: { name: string; version: string } | null
  initiatedBy: string | null
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 该消息所属的 Run；共享讨论消息为 null。 */
  runId?: string | null
  /** TW-10 共享讨论归因：用户消息作者；assistant 消息记录触发人与 Agent。 */
  senderId?: string
  senderName?: string
  runRequesterId?: string
  runRequesterName?: string
  agentName?: string
  /** 用户消息随发送附带的输入文件名（上传附件与引用文件）；无文件时缺省。 */
  attachments?: string[]
}

/** Run 失败的结构化错误（错误目录投影；I-06 起收敛进 TaskResult.error）。 */
export interface TaskRunError {
  code: string
  message: string
  object: string
  reason: string
  suggestion: string
  retryable: boolean
}

export interface TaskRun {
  id: string
  attemptId: string | null
  title: string
  prompt: string
  status: RunStatus
  workspaceId: string
  workspaceName: string
  /** Run 所属空间类型/状态，供客户端按服务端事实判定团队共享与归档只读。 */
  workspaceType?: 'personal' | 'team'
  workspaceStatus?: 'active' | 'archived'
  sessionId: string
  agentVersion: string
  createdAt: string
  updatedAt: string
  duration?: string
  tokenUsage?: number
  owner: string
  /** 触发人用户 id（TW-10 共享线程里用于区分「我发起的」与他人发起的 Run）。 */
  requestedBy: string
  /** 已停止的 Run：请求停止的员工姓名（项目空间方案第 5 节，线程中标注由谁停止）。 */
  stoppedBy?: string | null
  /** 调用者在 Run 所属空间的当前角色（TW-10 读轨）；个人/独立空间为 null。 */
  currentUserRole?: 'owner' | 'admin' | 'member' | 'viewer' | null
  messages: ChatMessage[]
  steps: RunStep[]
  /**
   * 个人会话详情会带回整段多轮消息：threadArtifacts 是这些消息所属各 Run
   * 的成果合集（按各自 current attempt 登记），供气泡按 runId 挂到对应回复下。
   * 本轮核验仍只用 result.artifacts（当前 Run）。团队 Run 详情与本轮一致时可省略。
   */
  threadArtifacts?: Artifact[]
  attachments: string[]
  skill?: {
    id: string
    name: string
    version: string
  }
  /**
   * I-06 版本化任务结果外层（task-result/v1）：业务核验状态、回执、待处理
   * 事项、来源、成果与错误统一收敛在此投影；执行状态仍以 status 为准，
   * succeeded 不直接等于业务目标达成。
   */
  result: TaskResult
  approval?: {
    object: string
    reason: string
    nextStep: string
    toolName: string
    dataScope: string
  }
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
  /** Runtime 配置紧急停用的内置工具。 */
  disabledTools: string[]
  lastHeartbeat: string
  checkedAt: string
  healthMessage: string
  capabilities: string[]
}

export interface UpdateRuntimeConfigurationInput {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
  /** 省略时保留当前停用清单。 */
  disabledTools?: string[]
  actor: string
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

export interface WorkspaceFile {
  id: string
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  /** TW-07 logical file id; present for team workspace files only. */
  logicalFileId?: string
  /** Version number the `id` object belongs to (latest effective version). */
  versionNo?: number
  /** Total recorded versions under the logical file. */
  versionCount?: number
  /** Scan/parse status of the displayed version (team summaries). */
  scanStatus?: string
  parseStatus?: string
  /** Server-resolved capabilities; 评审低1：前端不得缺省放行引用。 */
  canDownload?: boolean
  canReference?: boolean
}

export interface Workspace {
  id: string
  name: string
  description: string
  type: 'personal' | 'team'
  /** 团队归档态（3-T2）；个人空间恒为 active（AC-23）。 */
  status: 'active' | 'archived'
  /** 最近一次归档时间（ISO 8601），未归档为 null。 */
  archivedAt: string | null
  memberCount: number
  sessionCount: number
  artifactCount: number
  updatedAt: string
  owner: string
  members: string[]
  files: WorkspaceFile[]
}

export type PublishStatus = 'draft' | 'published' | 'disabled'

/** S3：验证时草稿冻结为 candidate（不可变），通过验证后发布为 published。 */
export type AgentVersionStatus = PublishStatus | 'candidate'

export interface AgentDefinition {
  id: string
  name: string
  description: string
  owner: string
  department: string
  /** 员工可见范围的摘要文字，由 roleIds 派生。 */
  visibility: string
  /** Agent 级可见角色：哪些角色可以向它请求工作；随时可改、立即生效，不属于版本。 */
  roleIds: string[]
  /** 平台治理开关：关闭后不再出现在团队空间「添加 Agent」候选，也不能被加入（convergence §1）。 */
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
  /** 是否允许联网搜索（web_search）；其他内置工具由平台统一装配。 */
  webSearchEnabled: boolean
  /** 是否允许项目任务管理（project_task_*）；仅团队空间运行装配，见项目空间方案 S6。 */
  projectTasksEnabled: boolean
  mcpScope?: AgentMcpScope
  updatedAt: string
  /** 草稿编辑的乐观并发修订：保存时原样回传为 expectedRevision（F-05）。原型模式不提供。 */
  revision?: string
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
  /** 是否允许联网搜索（web_search）；编辑时省略则保留当前设置，新建时默认关闭。 */
  webSearchEnabled?: boolean
  /** 是否允许项目任务管理；编辑时省略则保留当前设置，新建时默认关闭。 */
  projectTasksEnabled?: boolean
  mcpScope?: AgentMcpScope
  changeSummary: string
}

export interface CreateAgentDraftInput extends AgentDraftConfiguration {
  actor: string
  /** 初始访问授权（选填）；之后通过 Agent 访问授权接口调整。 */
  visibleRoleIds?: string[]
  executionRoleIds?: string[]
  executionDataScopes?: string[]
}

export interface UpdateAgentDraftInput extends Omit<AgentDraftConfiguration, 'id'> {
  agentId: string
  actor: string
  /** HTTP 编辑入口必填：读取草稿时的修订，过期则拒绝保存（F-05）。 */
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
  /** 是否允许联网搜索（web_search）；其他内置工具由平台统一装配。 */
  webSearchEnabled: boolean
  /** 是否允许项目任务管理（project_task_*）。 */
  projectTasksEnabled: boolean
  mcpScope?: AgentMcpScope
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

export interface SkillConfiguration {
  id: string
  name: string
  category: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
}

export interface CreateSkillInput extends Omit<SkillConfiguration, 'id'> {
  actor: string
}

export interface UpdateSkillInput extends Omit<SkillConfiguration, 'id'> {
  skillId: string
  actor: string
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

export interface ConnectorConfiguration {
  id: string
  name: string
  system: string
  protocol: ConnectorDefinition['protocol']
  endpoint: string
  authType: string
  credentialRef: string
  scopeDescription: string
}

export interface RegisterMcpConnectorInput {
  name: string
  endpoint: string
  authType: 'none' | 'bearer'
  bearerToken?: string
  scopeDescription: string
  actor: string
}

export interface TestMcpConnectionInput {
  name: string
  endpoint: string
  authType: 'none' | 'bearer'
  bearerToken?: string
  actor: string
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
  occurredAt: Date
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

export interface ListPageQuery {
  page?: number
  pageSize?: number
}

export interface SessionListQuery extends ListPageQuery {
  query?: string
  status?: string
  workspace?: string
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

export interface AuditEventListQuery extends ListPageQuery {
  query?: string
  status?: string
  category?: string
}

export interface ModelUsageListQuery extends ListPageQuery {
  query?: string
  employee?: string
  provider?: string
  status?: string
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
