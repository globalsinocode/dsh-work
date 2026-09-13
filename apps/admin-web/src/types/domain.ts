/** Admin API DTOs. They are intentionally owned by the management application. */
export type AdminRole = 'business_admin' | 'platform_admin' | 'auditor'

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
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
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
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  changeSummary: string
}

export type CreateAgentDraftInput = AgentDraftConfiguration

export interface UpdateAgentDraftInput extends Omit<AgentDraftConfiguration, 'id'> {
  agentId: string
}

export interface AgentVersionRecord {
  id: string
  agentId: string
  version: string
  status: PublishStatus
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
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
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
  status: 'queued' | 'running' | 'cancel_requested' | 'passed' | 'failed' | 'cancelled'
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
  timeoutSeconds: number
  allowedRoles: string[]
  dataScopes: string[]
  approvalPolicy: 'none' | 'sensitive' | 'always'
  lastCheckedAt: string
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
