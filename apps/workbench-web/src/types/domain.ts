/** Workbench API DTOs. They are intentionally owned by the employee application. */
export type UserRole = 'employee' | 'department_manager' | 'business_admin' | 'platform_admin' | 'auditor'

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
  duration?: string
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
  type: 'xlsx' | 'docx' | 'pdf' | 'markdown' | 'csv' | 'text' | 'html'
  version: number
  size: string
  createdAt: string
  runId: string
  workspaceId: string
  summary: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface TaskRun {
  id: string
  attemptId: string | null
  title: string
  prompt: string
  status: RunStatus
  workspaceId: string
  workspaceName: string
  sessionId: string
  agentVersion: string
  createdAt: string
  updatedAt: string
  duration?: string
  tokenUsage?: number
  owner: string
  messages: ChatMessage[]
  steps: RunStep[]
  sources: TaskSource[]
  artifacts: Artifact[]
  attachments: string[]
  skill?: Pick<WorkbenchSkill, 'id' | 'name' | 'version'>
  summary?: string
  approval?: {
    object: string
    reason: string
    nextStep: string
    toolName: string
    dataScope: string
  }
  error?: {
    code: string
    message: string
    object: string
    reason: string
    suggestion: string
    retryable: boolean
  }
}

export interface WorkspaceFile {
  id: string
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  extractionStatus?: 'succeeded' | 'failed'
  /**
   * 逻辑文件 id（TW-07 起团队共享文件按逻辑文件聚合返回）。团队动态的
   * `objectId` 是逻辑文件 id，前端据此从已加载文件列表解析名称，不把它当名称显示。
   */
  logicalFileId?: string
  /**
   * 文件列表当前展示的版本号（TW-07：最高解析成功版本，无成功版本时退化为最高
   * 版本）。个人空间文件没有逻辑文件与版本，因此保持可选；缺失时前端不渲染版本 UI。
   */
  versionNo?: number
  /** 逻辑文件下的版本总数（含失败版本，用于追溯）。 */
  versionCount?: number
}

/** 版本解析状态（迁移 0025 的 CHECK 闭合集合，TW-07 契约）。 */
export type WorkspaceFileVersionParseStatus = 'pending' | 'succeeded' | 'failed'

/** 一个逻辑文件下的单个不可变版本（`GET …/files/:logicalFileId/versions`）。 */
export interface WorkspaceFileVersion {
  versionNo: number
  /** 不可变对象 id：下载与「引用此版本」都必须固定到它，而不是逻辑文件 id。 */
  fileId: string
  logicalFileId: string
  name: string
  type: string
  size: string
  /** 上传新版本时填写的更新说明；未填写为 `null`。 */
  note: string | null
  uploadedBy: string
  uploadedAt: string
  scanStatus: string
  parseStatus: WorkspaceFileVersionParseStatus
  /** 文件列表当前展示的版本（服务端判定，前端不自行比较）。 */
  current: boolean
  /** 是否可下载；一律以服务端为准，前端不按扫描/解析状态自行推断。 */
  canDownload: boolean
}

export interface WorkspaceFileVersionPage {
  logicalFileId: string
  name: string
  status: string
  latestVersionNo: number
  versionCount: number
  items: WorkspaceFileVersion[]
}

/** `POST …/files/:logicalFileId/versions` 的 201 返回：新版本的最小摘要。 */
export interface UploadedWorkspaceFileVersion {
  id: string
  logicalFileId: string
  versionNo: number
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  extractionStatus: 'succeeded'
}

export interface Workspace {
  id: string
  name: string
  description: string
  type: 'personal' | 'team'
  memberCount: number
  sessionCount: number
  artifactCount: number
  updatedAt: string
  owner: string
  members: string[]
  files: WorkspaceFile[]
  /**
   * 团队空间归档状态（design §2.1/§2.5 归档态）。3-T2 起服务端 `/workspaces`
   * 恒返回该字段（个人空间恒为 `active`），前端据此渲染归档只读态；不再可选，
   * 缺省即视为契约破损而不是活动空间。
   */
  status: WorkspaceStatus
  /** 归档时间；活动空间为 `null`。 */
  archivedAt: string | null
}

export type WorkspaceStatus = 'active' | 'archived'

/** `GET /workspaces?status=` 的筛选口径（design §2.1 / §6：默认全部，个人空间恒显）。 */
export type WorkspaceStatusFilter = 'active' | 'archived' | 'all'

/** 归档/恢复接口返回的最小状态（`POST /workspaces/:id/archive|restore`）。 */
export interface WorkspaceLifecycleResult {
  id: string
  status: WorkspaceStatus
  archivedAt: string | null
}

/** `PATCH /workspaces/:id` 的入参；`description: null` 显式清空说明（方案 3.3）。 */
export interface WorkspaceUpdateInput {
  name?: string
  description?: string | null
}

/**
 * 团队动态 kind 的闭合集合（迁移 0026 CHECK 约束，TW-08 / 3-T7 契约）。
 * 服务端不返回任何名称字段：动态文案由 kind + safeMetadata + 演员名生成。
 */
export type WorkspaceActivityKind =
  | 'member_added'
  | 'member_removed'
  | 'member_exit'
  | 'role_changed'
  | 'owner_transferred'
  | 'agent_member_added'
  | 'agent_member_removed'
  | 'file_uploaded'
  | 'file_removed'
  | 'file_version_added'
  | 'workspace_archived'
  | 'workspace_restored'

export type WorkspaceActivityObjectType = 'member' | 'agent_member' | 'file' | 'workspace'

/**
 * 一条团队动态。`objectId` 只是安全对象引用（成员／Agent／逻辑文件／空间 id），
 * 读取时由调用方按当前读取轨重新解析；它绝不是可展示的名称。
 */
export interface WorkspaceActivityItem {
  id: string
  kind: WorkspaceActivityKind
  actorUserId: string
  actorDisplayName: string
  objectType: WorkspaceActivityObjectType
  objectId: string
  /** safeMetadata：仅含 id／角色／版本号白名单，不含名称与正文。 */
  safeMetadata: Record<string, unknown>
  occurredAt: string
}

export interface WorkspaceActivityPage {
  workspaceId: string
  items: WorkspaceActivityItem[]
  /** null 表示已到末尾。 */
  nextCursor: string | null
}

/** 动态与通知分页参数；`limit` 服务端限定 1..100。 */
export interface WorkspaceActivityQuery {
  cursor?: string
  limit?: number
}

/** 未读／静音状态（`POST …/notifications/read|mute|unmute` 的最小返回）。 */
export interface WorkspaceNotificationState {
  workspaceId: string
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  /** `last_read_at` 之后的动态条数；静音时为 0。 */
  unreadCount: number
}

/**
 * 未读通知分页：与服务端「未读」口径一致（`items` 是未读条目），并附带调用者
 * 本人的静音与已读位置。静音不影响动态 feed。
 */
export interface WorkspaceNotificationView extends WorkspaceActivityPage {
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  unreadCount: number
}

/**
 * 空间用量时间窗（TW-09 / 4-T2 契约 §2）：只接受 `7d`/`30d`，缺省 `7d`。
 * 服务端按日零填充返回该窗口内的 token 与调用次数，不返回金额或币种。
 */
export type WorkspaceUsageRange = '7d' | '30d'

/** 空间用量合计。`totalTokens = inputTokens + outputTokens`，`estimatedCount` 是其中平台估算的次数。 */
export interface WorkspaceUsageTotals {
  callCount: number
  successCount: number
  failedCount: number
  estimatedCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** 按日分桶的一行；`day` 为 `MM-DD`，无消耗的日子零填充。 */
export interface WorkspaceUsageDay {
  day: string
  callCount: number
  successCount: number
  failedCount: number
  inputTokens: number
  outputTokens: number
}

/**
 * `GET /workspaces/:workspaceId/usage` 的 200 响应。契约字段严格按 §2，不新增金额、
 * 币种、provider/model 或员工身份字段（最小必要面）。
 */
export interface WorkspaceUsage {
  workspaceId: string
  range: WorkspaceUsageRange
  rangeDays: number
  totals: WorkspaceUsageTotals
  /** 长度恒为 `rangeDays`，升序，零填充。 */
  daily: WorkspaceUsageDay[]
}

/** 用量查询参数；`range` 缺省时服务端按 `7d`。 */
export interface WorkspaceUsageQuery {
  range?: WorkspaceUsageRange
}

/** 团队空间员工角色：负责人、管理员、成员、只读成员。 */
export type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/** 成员选择所需的最小员工字段；不暴露管理端全量身份数据。 */
export interface MemberCandidate {
  id: string
  displayName: string
  department: string
}

export interface MemberCandidatePage {
  items: MemberCandidate[]
  nextCursor: string | null
}

export interface WorkspaceMember {
  userId: string
  displayName: string
  role: TeamMemberRole
  joinedAt: string
  /**
   * 成员所属部门（5-T2）；服务端与候选名册同一口径
   * `coalesce(users.department_id, '未分配部门')`。添加/角色变更响应不带该字段，
   * 因此可选，名册渲染时按有无决定是否展示。
   */
  department?: string
}

/**
 * 团队员工成员名册 + 调用者自己的角色。服务端返回调用者角色，使员工端按服务端
 * 状态渲染允许动作：负责人转交后创建者不再是负责人，不能按创建者推断权限。
 */
export interface WorkspaceMemberDirectory {
  items: WorkspaceMember[]
  currentUserRole: TeamMemberRole | null
}

/**
 * 团队历史会话摘要（1B-T1，design §2.2）：一条对应一个稳定 Session，只带最新
 * Run 指针与状态，不携带对话正文。个人空间不会请求该数据（AC-23）。
 */
export interface WorkspaceSessionSummary {
  sessionId: string
  title: string
  creatorId: string
  creatorName: string
  /** ISO 时间；列表固定按该字段倒序（服务端排序，前端不重排）。 */
  lastActiveAt: string
  runCount: number
  latestRun: { id: string; status: RunStatus } | null
}

export interface WorkspaceSessionPage {
  items: WorkspaceSessionSummary[]
  /** null 表示已到末尾。 */
  nextCursor: string | null
}

/**
 * 团队历史会话查询参数；`limit` 服务端限定 1..100。
 *
 * 范围固定为调用者本人发起的会话：服务端按 `created_by` 强制过滤，没有范围参数
 * （原 `scope=mine/team` 已随 2A／2B 放弃一并移除）。
 */
export interface WorkspaceSessionQuery {
  query?: string
  cursor?: string
  limit?: number
}

/** Agent 成员候选的最小字段；不暴露模型、凭据与 Skill/Tool 配置明细。 */
export interface AgentCandidate {
  agentId: string
  name: string
  description: string
  activeVersionId: string
  activeVersion: string
  status: 'published'
  /**
   * 加入确认区展示项（design §2.6）。当前 T4 契约只返回职责与版本，这三项
   * 为可选：服务端补齐前前端显示「详情待平台补充」，不伪造内容。
   */
  skillNames?: string[]
  toolNames?: string[]
  dataScope?: string
}

export interface AgentCandidatePage {
  items: AgentCandidate[]
  nextCursor: string | null
}

/** Agent 成员状态：可用、已停用；移出不出现在列表中。 */
export type AgentMemberStatus = 'available' | 'disabled'

/** 当前操作人允许的动作；Agent 成员不套用员工角色语义。 */
export type AgentMemberAction = 'start_conversation' | 'disable' | 'enable' | 'upgrade' | 'remove'

export type AgentMemberPatchAction = 'disable' | 'enable' | 'upgrade'

export interface WorkspaceAgentMember {
  id: string
  agentId: string
  name: string
  description: string
  status: AgentMemberStatus
  version: string
  addedBy: string
  createdAt: string
  allowedActions: AgentMemberAction[]
  /**
   * 状态为不可用时的具体原因（平台未授权／版本失效／Runtime 不可用，design
   * §2.6）。status 仍为 available，服务端按优先级给出；status 为 disabled 时
   * 恒为 null，前端只在非空时展示行内 tooltip 与红色状态点。
   */
  unavailableReason?: string | null
}

export interface WorkbenchSession {
  user: UserProfile
  identityProvider: 'prototype-sso' | 'ai-hub-oidc'
  apiAudience: 'workbench'
}

export interface WorkbenchAgent {
  id: string
  name: string
  description: string
  welcomeMessage: string
  version: string
  examplePrompts: string[]
}

export interface WorkbenchSkill {
  id: string
  name: string
  version: string
  category: string
  description: string
  owner: string
  testPrompt: string
  updatedAt: string
}

/** AG-03 自动任务调度规则：manual 仅手动触发；daily/weekly 需 timeOfDay。 */
export interface AutomationSchedule {
  kind: 'manual' | 'daily' | 'weekly'
  timezone: string
  timeOfDay?: string
  /** weekly 必填；0=周日 … 6=周六。 */
  weekdays?: number[]
}

export interface AutomationBudget {
  timeoutSeconds?: number
  maxToolCalls?: number
  maxOutputBytes?: number
}

export interface AutomationInputTemplate {
  prompt: string
  fileIds?: string[]
  budget?: AutomationBudget
}

export type AutomationStatus = 'draft' | 'enabled' | 'paused' | 'disabled'

export interface Automation {
  id: string
  name: string
  agentVersionId: string
  /** 钉住版本所属的业务 Agent / 名称 / 版本号；Agent 删除后为 null。 */
  agentId: string | null
  agentName: string | null
  agentVersion: string | null
  workspaceId: string
  schedule: AutomationSchedule
  scheduleRevision: number
  nextSlotUtc: string | null
  inputTemplate: AutomationInputTemplate
  scopeCeiling: { roleIds?: string[]; dataScopes?: string[] }
  confirmedConfigRevision: string
  revision: number
  status: AutomationStatus
  createdAt: string
  updatedAt: string
}

export type AutomationExecutionKind = 'scheduled' | 'manual' | 'missed'
export type AutomationAdmissionStatus = 'accepted' | 'skipped' | 'interrupted'

export interface AutomationExecution {
  id: string
  automationId: string
  triggerId: string
  kind: AutomationExecutionKind
  plannedSlotUtc: string | null
  missedFromUtc: string | null
  missedToUtc: string | null
  taskRevision: number
  scheduleRevision: number
  sessionId: string | null
  runId: string | null
  /** 关联 Run 的当前状态投影；未受理为 null。 */
  runStatus: string | null
  admissionStatus: AutomationAdmissionStatus
  reasonCode: string | null
  createdAt: string
  updatedAt: string
}
