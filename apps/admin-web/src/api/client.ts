import { isAuthorizationChangeCode, notifyAuthorizationChange } from '../utils/authorization-change'
import type { AdminConversation, SkillInstallation } from '../types/assistant'
import type {
  AdminSession,
  AdminTaskSummary,
  AgentDefinition,
  AgentJoinedWorkspaceRecord,
  AgentAccess,
  AgentRoutine,
  AgentRoutineExecution,
  CreateAgentDraftInput,
  CreateSkillInput,
  AgentReleaseOverview,
  AgentValidation,
  AgentVersionHistoryItem,
  AgentRunSummary,
  AgentVersionRecord,
  AuditEvent,
  ConnectorDefinition,
  BuiltinToolStatus,
  BuiltinSkillScenario,
  BuiltinSkillStatus,
  McpConnectionTestResult,
  McpConnectorDeletionResult,
  McpInvocationAudit,
  DirectorySyncState,
  EmployeeModelUsageSummary,
  GrantSourceReconciliationView,
  HealthComponent,
  IdentityRoleSummary,
  UpdateAgentAccessInput,
  IdentityUserPage,
  IdentityUserSummary,
  ListPage,
  LocalPermissionDefinition,
  ModelUsagePage,
  ManagedWorkspaceDefinition,
  ModelProvider,
  ModelRoute,
  ModelRoutePurpose,
  OperationsSummary,
  PlatformStatus,
  PersistentApproval,
  AgentExperience,
  ExperienceIterationAgentSummary,
  ExperienceIterationApplication,
  RuntimeDefinition,
  SessionListPage,
  SkillDefinition,
  SkillReleaseRecord,
  SkillTestRunProgress,
  SkillVersionRecord,
  ToolCatalogCandidate,
  ToolCatalogSyncResult,
  ToolDefinition,
  ToolBindingRecord,
  DshRuntimeToolConnectorStatus,
  UpdateAgentDraftInput,
  UpdateRuntimeConfigurationInput,
  UpdateSkillInput,
  UsagePoint,
} from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'admin'
    adapter: 'prototype-memory' | 'postgres'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_ADMIN_API_BASE_URL ?? '/api/admin/v1'

interface ApiErrorPayload {
  code?: string
  message?: string
  object?: string
  suggestion?: string
  traceId?: string
}

export class AdminApiError extends Error {
  readonly code: string
  readonly object: string
  readonly suggestion: string
  readonly traceId: string
  readonly status: number

  constructor(payload: ApiErrorPayload, status: number, fallback: string) {
    super(payload.message ?? fallback)
    this.name = 'AdminApiError'
    this.code = payload.code ?? 'request_failed'
    this.object = payload.object ?? '当前操作'
    this.suggestion = payload.suggestion ?? '请稍后重试；若问题持续，请检查系统健康。'
    this.traceId = payload.traceId ?? '—'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const fallback = `管理后台接口请求失败（${response.status}）`
    const payload = await response.json().catch(() => undefined) as { error?: ApiErrorPayload } | undefined
    const error = new AdminApiError(payload?.error ?? {}, response.status, fallback)
    if (response.status === 401 && path !== '/session') redirectToLogin()
    if (response.status === 403 && isAuthorizationChangeCode(error.code)) {
      await notifyAuthorizationChange(error)
    }
    throw error
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

function listQuery(input: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === '' || value === 'all') continue
    params.set(key === 'pageSize' ? 'page_size' : key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ''
}

function redirectToLogin() {
  if (typeof window === 'undefined') return
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/auth/admin/login?return_to=${encodeURIComponent(returnTo)}`)
}

export const adminApi = {
  getExperienceIterationAgents: () =>
    request<ExperienceIterationAgentSummary[]>('/experience-iterations/agents'),
  getExperienceIterationApplications: (agentId?: string, status?: ExperienceIterationApplication['status']) => {
    const query = new URLSearchParams()
    if (agentId) query.set('agentId', agentId)
    if (status) query.set('status', status)
    return request<ExperienceIterationApplication[]>(`/experience-iterations/applications${query.size ? `?${query}` : ''}`)
  },
  reviewExperienceIterationApplication: (applicationId: string, input: { decision: 'approved' | 'rejected'; resolutionKey: string; comment?: string }) =>
    request<ExperienceIterationApplication>(`/experience-iterations/applications/${encodeURIComponent(applicationId)}/review`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  getAgentExperiences: (agentId: string) =>
    request<AgentExperience[]>(`/experience-iterations/agents/${encodeURIComponent(agentId)}/experiences`),
  setAgentExperienceVersion: (agentId: string, entryId: string, input: { versionId: string | null; expectedVersionId: string | null; reason: string }) =>
    request<AgentExperience>(`/experience-iterations/agents/${encodeURIComponent(agentId)}/experiences/${encodeURIComponent(entryId)}/current`, {
      method: 'PUT', body: JSON.stringify(input),
    }),
  getApprovals: (status?: PersistentApproval['status']) => request<PersistentApproval[]>(`/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  resolveApproval: (approvalId: string, input: { decision: 'approved' | 'rejected'; resolutionKey: string; comment?: string }) =>
    request<PersistentApproval>(`/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: 'POST', body: JSON.stringify(input) }),
  getAssistantConversations: () => request<Array<{ id: string; title: string }>>('/assistant/sessions'),
  getAssistantConversation: (id: string) => request<AdminConversation>(`/assistant/sessions/${encodeURIComponent(id)}`),
  sendAssistantMessage: (input: { sessionId: string; message: string; requestId: string }) => request<AdminConversation>('/assistant/messages', { method: 'POST', body: JSON.stringify(input) }),
  confirmSkillInstallation: (runId: string, planSha256: string) => request<AdminConversation>(`/assistant/runs/${encodeURIComponent(runId)}/confirm`, { method: 'POST', body: JSON.stringify({ planSha256 }) }),
  confirmAssistantProposal: (proposalId: string, proposalSha256: string) => request<AdminConversation>(`/assistant/task-proposals/${encodeURIComponent(proposalId)}/confirm`, { method: 'POST', body: JSON.stringify({ proposalSha256 }) }),
  cancelAssistantProposal: (proposalId: string) => request<AdminConversation>(`/assistant/task-proposals/${encodeURIComponent(proposalId)}/cancel`, { method: 'POST' }),
  confirmAssistantAction: (actionId: string, planSha256: string) => request<AdminConversation>(`/assistant/action-plans/${encodeURIComponent(actionId)}/confirm`, { method: 'POST', body: JSON.stringify({ planSha256 }) }),
  cancelAssistantAction: (actionId: string) => request<AdminConversation>(`/assistant/action-plans/${encodeURIComponent(actionId)}/cancel`, { method: 'POST' }),
  prepareLinkSkillInstallation: (input: { url: string; selected?: string }) => request<SkillInstallation>('/skill-installations/link', { method: 'POST', body: JSON.stringify(input) }),
  confirmDirectSkillInstallation: (id: string, planSha256: string) => request<SkillInstallation>(`/skill-installations/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({ planSha256 }) }),
  getDirectSkillInstallation: (id: string) => request<SkillInstallation>(`/skill-installations/${encodeURIComponent(id)}`),
  cancelDirectSkillInstallation: (id: string) => request<SkillInstallation>(`/skill-installations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  prepareZipSkillInstallation: (file: File) => request<SkillInstallation>('/skill-installations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  }),
  confirmZipSkillInstallation: (installationId: string, planSha256: string) => request<SkillInstallation>(`/skill-installations/${encodeURIComponent(installationId)}/confirm`, { method: 'POST', body: JSON.stringify({ planSha256 }) }),
  cancelAssistantRun: (runId: string) => request<AdminConversation>(`/assistant/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  retryAssistantRun: (runId: string) => request<AdminConversation>(`/assistant/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }),
  getSession: () => request<AdminSession>('/session'),
  getTasks: () => request<AdminTaskSummary[]>('/tasks'),
  getRuntimes: () => request<RuntimeDefinition[]>('/runtimes'),
  checkRuntime: (input: { runtimeId: string }) =>
    request<RuntimeDefinition>('/runtimes/check', { method: 'POST', body: JSON.stringify(input) }),
  updateRuntimeConfiguration: (input: UpdateRuntimeConfigurationInput) =>
    request<RuntimeDefinition>('/runtimes/configuration', { method: 'PATCH', body: JSON.stringify(input) }),
  getSessions: (input: { query?: string; status?: string; workspace?: string; page?: number; pageSize?: number } = {}) =>
    request<SessionListPage>(`/sessions${listQuery(input)}`),
  getWorkspaces: () => request<ManagedWorkspaceDefinition[]>('/workspaces'),
  getAgents: () => request<AgentDefinition[]>('/agents'),
  getAgentVersions: () => request<AgentVersionRecord[]>('/agent-versions'),
  createAgentDraft: (input: CreateAgentDraftInput) =>
    request<{ agent: AgentDefinition; version: AgentVersionRecord }>('/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAgentDraft: (input: UpdateAgentDraftInput) =>
    request<{ agent: AgentDefinition; version: AgentVersionRecord }>('/agents/draft', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  setAgentStatus: (input: { agentId: string; status: 'published' | 'disabled' }) =>
    request<{ agent: AgentDefinition }>('/agents/status', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  rollbackAgent: (input: { agentId: string; version: string }) =>
    request<{ agent: AgentDefinition }>('/agents/rollback', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setAgentWorkspaceJoin: (input: { agentId: string; allowWorkspaceJoin: boolean }) =>
    request<{ agent: AgentDefinition }>(`/agents/${encodeURIComponent(input.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ allowWorkspaceJoin: input.allowWorkspaceJoin }),
    }),
  getAgentAccess: (agentId: string) =>
    request<AgentAccess>(`/agents/${encodeURIComponent(agentId)}/access`),
  updateAgentAccess: (agentId: string, input: UpdateAgentAccessInput) =>
    request<AgentAccess>(`/agents/${encodeURIComponent(agentId)}/access`, {
      method: 'PATCH', body: JSON.stringify(input),
    }),
  getAgentRoutines: (agentId: string) =>
    request<AgentRoutine[]>(`/agents/${encodeURIComponent(agentId)}/routines`),
  createAgentRoutine: (agentId: string, input: Pick<AgentRoutine,
    'name' | 'agentVersionId' | 'workspaceId' | 'recipientUserId' | 'schedule' | 'inputTemplate'>) =>
    request<AgentRoutine>(`/agents/${encodeURIComponent(agentId)}/routines`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  updateAgentRoutine: (agentId: string, routineId: string, input: Partial<Pick<AgentRoutine,
    'name' | 'agentVersionId' | 'workspaceId' | 'recipientUserId' | 'schedule' | 'inputTemplate'>> & { expectedRevision: number }) =>
    request<AgentRoutine>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    }),
  enableAgentRoutine: (agentId: string, routineId: string, input: { expectedRevision: number; roleIds: string[]; dataScopes: string[] }) =>
    request<AgentRoutine>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}/enable`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  setAgentRoutineStatus: (agentId: string, routineId: string, status: 'paused' | 'disabled') =>
    request<AgentRoutine>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}${status === 'paused' ? '/pause' : ''}`, {
      method: status === 'paused' ? 'POST' : 'DELETE',
    }),
  runAgentRoutineNow: (agentId: string, routineId: string, idempotencyKey: string) =>
    request<AgentRoutineExecution>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}/run-now`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey }),
    }),
  triggerAgentRoutineEvent: (agentId: string, routineId: string, input: { eventType: string; source: string; eventId: string }) =>
    request<AgentRoutineExecution>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}/events`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  getAgentRoutineExecutions: (agentId: string, routineId: string) =>
    request<AgentRoutineExecution[]>(`/agents/${encodeURIComponent(agentId)}/routines/${encodeURIComponent(routineId)}/executions`),
  getAgentRelease: (agentId: string) =>
    request<{ agent: AgentDefinition; release: AgentReleaseOverview }>(`/agents/${encodeURIComponent(agentId)}`),
  getAgentRuns: (agentId: string, limit = 20) =>
    request<{ items: AgentRunSummary[] }>(`/agents/${encodeURIComponent(agentId)}/runs?limit=${limit}`),
  getAgentVersionHistory: (agentId: string) =>
    request<{ items: AgentVersionHistoryItem[] }>(`/agents/${encodeURIComponent(agentId)}/versions`),
  replaceAgentTestCases: (agentId: string, prompts: string[]) =>
    request<AgentReleaseOverview>(`/agents/${encodeURIComponent(agentId)}/test-cases`, {
      method: 'PUT', body: JSON.stringify({ prompts }),
    }),
  startAgentValidation: (agentId: string) =>
    request<AgentReleaseOverview>(`/agents/${encodeURIComponent(agentId)}/validations`, { method: 'POST' }),
  getAgentValidation: (agentId: string, validationId: string) =>
    request<AgentValidation>(`/agents/${encodeURIComponent(agentId)}/validations/${encodeURIComponent(validationId)}`),
  rerunAgentValidationCase: (agentId: string, validationId: string, caseId: string) =>
    request<AgentValidation>(`/agents/${encodeURIComponent(agentId)}/validations/${encodeURIComponent(validationId)}/cases/${encodeURIComponent(caseId)}/rerun`, { method: 'POST' }),
  setAgentValidationVerdict: (agentId: string, validationId: string, caseId: string, input: { verdict: 'passed' | 'failed'; note?: string }) =>
    request<AgentValidation>(`/agents/${encodeURIComponent(agentId)}/validations/${encodeURIComponent(validationId)}/cases/${encodeURIComponent(caseId)}/verdict`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  publishAgent: (agentId: string, input: { validationId: string; note?: string }) =>
    request<AgentReleaseOverview>(`/agents/${encodeURIComponent(agentId)}/publish`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  getAgentJoinedWorkspaces: (agentId: string) =>
    request<{ items: AgentJoinedWorkspaceRecord[] }>(`/agents/${encodeURIComponent(agentId)}/workspaces`),
  getGrantSourceReconciliation: () =>
    request<GrantSourceReconciliationView>('/grant-sources/unresolved'),
  reconcileGrantSources: (input: { sourceIds: string[] }) =>
    request<{ reconciled: number; sourceIds: string[]; workspaceIds: string[] }>('/grant-sources/reconcile', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getSkills: () => request<SkillDefinition[]>('/skills'),
  getSkillVersions: () => request<SkillVersionRecord[]>('/skill-versions'),
  getSkillReleaseRecords: () => request<SkillReleaseRecord[]>('/skill-release-records'),
  createSkill: (input: CreateSkillInput) =>
    request<{ skill: SkillDefinition; version: SkillVersionRecord }>('/skills', { method: 'POST', body: JSON.stringify(input) }),
  updateSkill: (input: UpdateSkillInput) =>
    request<{ skill: SkillDefinition; version: SkillVersionRecord }>('/skills', { method: 'PATCH', body: JSON.stringify(input) }),
  testSkill: (input: { skillId: string; prompt?: string }) =>
    request<{ id: string; skillId: string; version: string; status: 'passed' | 'failed'; resultSummary: string; testedAt: string }>('/skills/test', { method: 'POST', body: JSON.stringify(input) }),
  startSkillTestRun: (input: { skillId: string; prompt?: string }) =>
    request<SkillTestRunProgress>('/skills/test-runs', { method: 'POST', body: JSON.stringify(input) }),
  getSkillTestRun: (skillId: string, runId: string) =>
    request<SkillTestRunProgress>(`/skills/${encodeURIComponent(skillId)}/test-runs/${encodeURIComponent(runId)}`),
  setSkillStatus: (input: { skillId: string; status: 'published' | 'disabled' }) =>
    request<{ skill: SkillDefinition; release: SkillReleaseRecord }>('/skills/status', { method: 'PATCH', body: JSON.stringify(input) }),
  rollbackSkill: (input: { skillId: string; version: string }) =>
    request<{ skill: SkillDefinition; release: SkillReleaseRecord }>('/skills/rollback', { method: 'POST', body: JSON.stringify(input) }),
  getTools: () => request<ToolDefinition[]>('/tools'),
  getToolBindings: () => request<{ items: ToolBindingRecord[] }>('/tools/bindings'),
  getToolCatalog: () => request<ToolCatalogCandidate[]>('/tools/catalog'),
  syncDshTools: () => request<ToolCatalogSyncResult>('/tools/sync', { method: 'POST' }),
  addTool: (input: {
    catalogId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) => request<ToolDefinition>('/tools', { method: 'POST', body: JSON.stringify(input) }),
  setToolStatus: (input: { toolId: string; status: 'available' | 'disabled' }) =>
    request<ToolDefinition>('/tools/status', { method: 'PATCH', body: JSON.stringify(input) }),
  updateToolPermissions: (input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) => request<ToolDefinition>('/tools/permissions', { method: 'PATCH', body: JSON.stringify(input) }),
  getMcpConnectors: () => request<ConnectorDefinition[]>('/connectors'),
  getDshRuntimeToolConnector: () => request<DshRuntimeToolConnectorStatus>('/runtimes/dsh-tool-connector'),
  checkDshRuntimeToolConnector: () => request<DshRuntimeToolConnectorStatus>('/runtimes/dsh-tool-connector/check', { method: 'POST' }),
  getBuiltinTools: () => request<BuiltinToolStatus>('/runtimes/builtin-tools'),
  getBuiltinSkills: () => request<BuiltinSkillStatus>('/skills/builtin'),
  setSkillBuiltinCoverage: (input: { skillId: string; scenarios: BuiltinSkillScenario[] }) =>
    request<SkillDefinition>('/skills/builtin-coverage', { method: 'PATCH', body: JSON.stringify(input) }),
  getMcpInvocationAudits: (connectorId: string) =>
    request<McpInvocationAudit[]>(`/connectors/mcp/invocations?connector_id=${encodeURIComponent(connectorId)}`),
  testMcpConnection: (input: {
    name: string
    endpoint: string
    authType: 'none' | 'bearer' | 'user_oauth'
    bearerToken?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
    clientId?: string
    clientSecret?: string
    scopes?: string[]
    resource?: string
  }) => request<McpConnectionTestResult>('/connectors/mcp/test', { method: 'POST', body: JSON.stringify(input) }),
  beginMcpProbeAuthorization: (input: {
    name: string
    endpoint: string
    authType: 'user_oauth'
    authorizationEndpoint: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    scopes: string[]
    resource?: string
  }) => request<{ authorizationUrl: string }>('/connectors/mcp/probe-authorization', { method: 'POST', body: JSON.stringify(input) }),
  registerMcpConnector: (input: {
    name: string
    endpoint: string
    authType: 'none' | 'bearer' | 'user_oauth'
    bearerToken?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
    clientId?: string
    clientSecret?: string
    scopes?: string[]
    resource?: string
    scopeDescription: string
  }) => request<ConnectorDefinition>('/connectors/mcp', { method: 'POST', body: JSON.stringify(input) }),
  deleteMcpConnector: (connectorId: string) =>
    request<McpConnectorDeletionResult>(`/connectors/mcp/${encodeURIComponent(connectorId)}`, { method: 'DELETE' }),
  rotateMcpCredential: (input: { connectorId: string; bearerToken: string }) =>
    request<ConnectorDefinition>('/connectors/mcp/credential', { method: 'PATCH', body: JSON.stringify(input) }),
  checkConnector: (input: { connectorId: string }) =>
    request<ConnectorDefinition>('/connectors/check', { method: 'POST', body: JSON.stringify(input) }),
  approveMcpCapabilities: (input: { connectorId: string; capabilityDigest: string }) =>
    request<ConnectorDefinition>('/connectors/mcp/capabilities/approve', { method: 'POST', body: JSON.stringify(input) }),
  setMcpConnectorStatus: (input: { connectorId: string; status: 'enabled' | 'disabled' }) =>
    request<ConnectorDefinition>('/connectors/mcp/status', { method: 'PATCH', body: JSON.stringify(input) }),
  getAuditEvents: (input: { query?: string; status?: string; category?: string; page?: number; pageSize?: number } = {}) =>
    request<ListPage<AuditEvent>>(`/audit-events${listQuery(input)}`),
  getOperationsSummary: () => request<OperationsSummary>('/operations/summary'),
  getRunOperations: (runId: string) => request<AuditEvent[]>(`/operations/runs/${encodeURIComponent(runId)}`),
  getHealth: () => request<HealthComponent[]>('/health'),
  getUsage: () => request<UsagePoint[]>('/usage'),
  getModelUsage: (input: { query?: string; employee?: string; provider?: string; status?: string; page?: number; pageSize?: number } = {}) =>
    request<ModelUsagePage>(`/model-usage${listQuery(input)}`),
  getModelUsageEmployees: (input: { query?: string; employee?: string; provider?: string; status?: string; page?: number; pageSize?: number } = {}) =>
    request<ListPage<EmployeeModelUsageSummary>>(`/model-usage/employees${listQuery(input)}`),
  getModelProviders: () => request<ModelProvider[]>('/model-providers'),
  createModelProvider: (input: {
    key: string
    name: string
    providerType: string
    baseUrl: string
  }) => request<ModelProvider>('/model-providers', { method: 'POST', body: JSON.stringify(input) }),
  setModelProviderStatus: (input: { providerId: string; status: 'active' | 'disabled' }) =>
    request<ModelProvider>('/model-providers/status', { method: 'PATCH', body: JSON.stringify(input) }),
  createProviderModel: (input: {
    providerId: string
    modelKey: string
    displayName: string
    capabilities: string[]
  }) => request<ModelProvider>('/provider-models', { method: 'POST', body: JSON.stringify(input) }),
  updateCredentialReference: (input: {
    providerId: string
    backend: 'dsh-managed' | 'keychain' | 'secret-manager'
    externalRef: string
    status: 'configured' | 'missing' | 'revoked'
  }) => request<ModelProvider>('/model-providers/credential-reference', {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  getModelRoutes: () => request<ModelRoute[]>('/model-routes'),
  createModelRoute: (input: {
    key: string
    name: string
    purpose: ModelRoutePurpose
    providerModelId: string
    priority: number
    enabled: boolean
  }) => request<ModelRoute>('/model-routes', { method: 'POST', body: JSON.stringify(input) }),
  getPlatformStatus: () => request<PlatformStatus>('/platform-status'),
  getIdentityUsers: (input: { query?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const query = new URLSearchParams()
    if (input.query) query.set('query', input.query)
    if (input.status && input.status !== 'all') query.set('status', input.status)
    query.set('page', String(input.page ?? 1))
    query.set('page_size', String(input.pageSize ?? 20))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return request<IdentityUserPage>(`/identity/users${suffix}`)
  },
  getIdentityRoles: () => request<IdentityRoleSummary[]>('/identity/roles'),
  getLocalPermissions: () => request<LocalPermissionDefinition[]>('/identity/permissions'),
  createIdentityRole: (input: {
    code: string
    name: string
    description: string
    permissions: string[]
    dataScopes: string[]
  }) => request<IdentityRoleSummary>('/identity/roles', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  updateIdentityRole: (roleId: string, input: {
    name: string
    description: string
    status: IdentityRoleSummary['status']
    permissions: string[]
    dataScopes: string[]
  }) => request<IdentityRoleSummary>(`/identity/roles/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  grantIdentityRole: (userId: string, input: { roleId: string; validUntil?: string | null }) =>
    request<IdentityUserSummary>(`/identity/users/${encodeURIComponent(userId)}/roles`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revokeIdentityRole: (userId: string, roleId: string) =>
    request<IdentityUserSummary>(
      `/identity/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      { method: 'DELETE' },
    ),
  replaceIdentityUserScopes: (userId: string, dataScopes: string[]) =>
    request<IdentityUserSummary>(`/identity/users/${encodeURIComponent(userId)}/scopes`, {
      method: 'PATCH',
      body: JSON.stringify({ dataScopes }),
    }),
  revokeIdentityUserSessions: (userId: string) =>
    request<{ userId: string; revokedSessions: number }>(
      `/identity/users/${encodeURIComponent(userId)}/sessions/revoke`,
      { method: 'POST' },
    ),
  createLocalAccount: (input: { username: string; password: string; name: string; department?: string; email?: string }) =>
    request<{ userId: string; username: string }>('/identity/users', { method: 'POST', body: JSON.stringify(input) }),
  checkLocalLoginAccount: (username: string) =>
    request<{ username: string; available: boolean }>('/identity/login-account/check', { method: 'POST', body: JSON.stringify({ username }) }),
  resetLocalPassword: (userId: string, password: string) =>
    request<{ userId: string }>(`/identity/users/${encodeURIComponent(userId)}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  setLocalAccountStatus: (userId: string, status: 'active' | 'disabled') =>
    request<{ userId: string; status: string }>(`/identity/users/${encodeURIComponent(userId)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  getDirectorySyncState: () => request<DirectorySyncState>('/identity/directory-sync'),
  synchronizeDirectory: (full = false) => request<DirectorySyncState>(
    `/identity/directory-sync${full ? '?full=true' : ''}`,
    { method: 'POST' },
  ),
}
