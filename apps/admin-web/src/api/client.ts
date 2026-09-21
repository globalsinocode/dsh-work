import type { AdminConversation, SkillInstallation } from '../types/assistant'
import type {
  AdminSession,
  AdminTaskSummary,
  AgentDefinition,
  AgentEvalCase,
  AgentJoinedWorkspaceRecord,
  AgentPackageInspection,
  AgentReleaseState,
  AgentSubmissionSummary,
  AgentVersionEvidenceEntry,
  CreateAgentDraftInput,
  CreateSkillInput,
  AgentReleaseRecord,
  AgentVersionRecord,
  AuditEvent,
  ConnectorDefinition,
  McpInvocationAudit,
  DirectorySyncState,
  EmployeeModelUsageSummary,
  GrantSourceReconciliationView,
  HealthComponent,
  IdentityRoleSummary,
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
  RuntimeDefinition,
  SessionListPage,
  SkillDefinition,
  SkillReleaseRecord,
  SkillTestRunProgress,
  SkillVersionRecord,
  ToolBindingRecord,
  ToolDefinition,
  ToolCatalogCandidate,
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
  getAgentReleaseRecords: () => request<AgentReleaseRecord[]>('/agent-release-records'),
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
    request<{ agent: AgentDefinition; release: AgentReleaseRecord }>('/agents/status', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  rollbackAgent: (input: { agentId: string; version: string }) =>
    request<{ agent: AgentDefinition; release: AgentReleaseRecord }>('/agents/rollback', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setAgentWorkspaceJoin: (input: { agentId: string; allowWorkspaceJoin: boolean }) =>
    request<{ agent: AgentDefinition }>(`/agents/${encodeURIComponent(input.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ allowWorkspaceJoin: input.allowWorkspaceJoin }),
    }),
  getAgentReleaseSubmissions: () => request<{ items: AgentSubmissionSummary[] }>('/agent-release-submissions'),
  getAgentVersionEvidence: () => request<{ items: AgentVersionEvidenceEntry[] }>('/agent-version-evidence'),
  getAgentReleaseState: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release`),
  ensureAgentReleaseCandidate: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/candidate`, { method: 'POST' }),
  runAgentReleaseChecks: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/checks`, { method: 'POST' }),
  updateAgentReleaseCases: (agentId: string, cases: AgentEvalCase[]) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/cases`, {
      method: 'POST',
      body: JSON.stringify({ cases }),
    }),
  removeAgentReleaseDependency: (agentId: string, input: { kind: 'skills' | 'tools'; reference: string }) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/dependencies/remove`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  startAgentReleaseTrial: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/trials`, { method: 'POST' }),
  confirmAgentReleaseTrial: (agentId: string, trialId: string, verdicts: Array<{ caseId: string; verdict: 'passed' | 'failed'; note?: string }>) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/trials/${encodeURIComponent(trialId)}/confirm`, { method: 'POST', body: JSON.stringify({ verdicts }) }),
  cancelAgentReleaseTrial: (agentId: string, trialId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/trials/${encodeURIComponent(trialId)}/cancel`, { method: 'POST' }),
  submitAgentRelease: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/submit`, { method: 'POST' }),
  requestAgentReleaseChanges: (agentId: string, note: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/request-changes`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  withdrawAgentRelease: (agentId: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/withdraw`, { method: 'POST' }),
  publishAgentRelease: (agentId: string, note: string) =>
    request<AgentReleaseState>(`/agents/${encodeURIComponent(agentId)}/release/publish`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  inspectAgentPackage: (file: File) =>
    request<AgentPackageInspection>('/agent-packages/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    }),
  importAgentPackage: (file: File) =>
    request<AgentReleaseState>('/agent-packages/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
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
  addTool: (input: {
    catalogId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) => request<ToolDefinition>('/tools', { method: 'POST', body: JSON.stringify(input) }),
  setToolStatus: (input: { toolId: string; status: 'available' | 'disabled' }) =>
    request<ToolDefinition>('/tools/status', { method: 'PATCH', body: JSON.stringify(input) }),
  getConnectors: () => request<ConnectorDefinition[]>('/connectors'),
  getMcpInvocationAudits: (connectorId: string) =>
    request<McpInvocationAudit[]>(`/connectors/mcp/invocations?connector_id=${encodeURIComponent(connectorId)}`),
  registerMcpConnector: (input: {
    name: string
    endpoint: string
    authType: 'none' | 'bearer'
    bearerToken?: string
    scopeDescription: string
  }) => request<ConnectorDefinition>('/connectors/mcp', { method: 'POST', body: JSON.stringify(input) }),
  rotateMcpCredential: (input: { connectorId: string; bearerToken: string }) =>
    request<ConnectorDefinition>('/connectors/mcp/credential', { method: 'PATCH', body: JSON.stringify(input) }),
  checkConnector: (input: { connectorId: string }) =>
    request<ConnectorDefinition>('/connectors/check', { method: 'POST', body: JSON.stringify(input) }),
  approveMcpConnector: (input: { connectorId: string; capabilityDigest: string }) =>
    request<ConnectorDefinition>('/connectors/mcp/approve', { method: 'POST', body: JSON.stringify(input) }),
  setMcpConnectorStatus: (input: { connectorId: string; status: 'enabled' | 'disabled' }) =>
    request<ConnectorDefinition>('/connectors/mcp/status', { method: 'PATCH', body: JSON.stringify(input) }),
  setAgentMcpAccess: (input: { connectorId: string; agentId: string; enabled: boolean }) =>
    request<ConnectorDefinition>('/connectors/mcp/agent-access', { method: 'PATCH', body: JSON.stringify(input) }),
  updateToolPermissions: (input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) => request<ToolDefinition>('/tools/permissions', { method: 'PATCH', body: JSON.stringify(input) }),
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
  getDirectorySyncState: () => request<DirectorySyncState>('/identity/directory-sync'),
  synchronizeDirectory: (full = false) => request<DirectorySyncState>(
    `/identity/directory-sync${full ? '?full=true' : ''}`,
    { method: 'POST' },
  ),
}
