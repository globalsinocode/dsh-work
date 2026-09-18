import type {
  AgentCandidatePage,
  AgentMemberPatchAction,
  Artifact,
  Automation,
  AutomationExecution,
  AutomationInputTemplate,
  AutomationSchedule,
  MemberCandidatePage,
  SessionThread,
  TaskRun,
  TeamMemberRole,
  WorkbenchAgent,
  WorkbenchSession,
  WorkbenchSkill,
  Workspace,
  WorkspaceActivityPage,
  WorkspaceActivityQuery,
  WorkspaceAgentMember,
  WorkspaceFile,
  WorkspaceFileVersionPage,
  WorkspaceLifecycleResult,
  WorkspaceMember,
  WorkspaceMemberDirectory,
  WorkspaceNotificationState,
  WorkspaceNotificationView,
  WorkspaceSessionPage,
  WorkspaceSessionQuery,
  WorkspaceStatusFilter,
  WorkspaceUpdateInput,
  WorkspaceUsage,
  WorkspaceUsageQuery,
  UploadedWorkspaceFileVersion,
} from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'workbench'
    adapter: 'prototype-memory' | 'postgres'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_WORKBENCH_API_BASE_URL ?? '/api/workbench/v1'

interface ApiErrorPayload {
  code?: string
  message?: string
  object?: string
  suggestion?: string
  traceId?: string
}

export class WorkbenchApiError extends Error {
  readonly code: string
  readonly object: string
  readonly suggestion: string
  readonly traceId: string
  readonly status: number

  constructor(payload: ApiErrorPayload, status: number, fallback: string) {
    super(payload.message ?? fallback)
    this.name = 'WorkbenchApiError'
    this.code = payload.code ?? 'request_failed'
    this.object = payload.object ?? '当前操作'
    this.suggestion = payload.suggestion ?? '请稍后重试；若问题持续，请联系管理员。'
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
    const error = await parseApiError(response, `员工工作台接口请求失败（${response.status}）`)
    if (response.status === 401 && path !== '/session') redirectToLogin()
    throw error
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

async function requestBlob(path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/octet-stream' },
  })
  if (!response.ok) {
    const error = await parseApiError(response, `文件下载失败（${response.status}）`)
    if (response.status === 401) redirectToLogin()
    throw error
  }
  return response.blob()
}

function redirectToLogin() {
  if (typeof window === 'undefined') return
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/auth/workbench/login?return_to=${encodeURIComponent(returnTo)}`)
}

async function parseApiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => undefined) as { error?: ApiErrorPayload } | undefined
  return new WorkbenchApiError(payload?.error ?? {}, response.status, fallback)
}

export const workbenchApi = {
  getSession: () => request<WorkbenchSession>('/session'),
  getTasks: () => request<TaskRun[]>('/tasks'),
  getAgents: () => request<WorkbenchAgent[]>('/agents'),
  getSkills: () => request<WorkbenchSkill[]>('/skills'),
  getRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}`),
  createSession: (input: { title: string; workspaceId?: string; agentId?: string; skillId?: string; workspaceAgentMemberId?: string }) =>
    // TW-10：团队讨论会话可为 null（首次 @Agent 前不绑定 Agent）。
    request<{ id: string; workspaceId: string; agentVersionId: string | null; title: string; createdAt: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteSession: (sessionId: string) => request<{ sessionId: string; title: string; archived: true }>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  ),
  /** TW-10：团队会话共享线程（全员可读的消息流 + Run 列表 + 归因）。 */
  getSessionThread: (sessionId: string) =>
    request<SessionThread>(`/sessions/${encodeURIComponent(sessionId)}`),
  /** TW-10：不产生 Run 的讨论消息（仅团队空间会话）。 */
  postSessionMessage: (sessionId: string, content: string) =>
    request<{ messageId: string; sessionId: string }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  /**
   * 在会话中发起一次执行。团队会话按消息绑定 Agent 成员（@ 触发），传
   * `workspaceAgentMemberId`；个人会话沿用会话绑定版本，忽略该字段。
   */
  startRun: (sessionId: string, input: { prompt: string; idempotencyKey: string; fileIds?: string[]; workspaceAgentMemberId?: string }) =>
    request<TaskRun>(`/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  cancelRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  retryRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }),
  runEventsUrl: (runId: string) => `${baseUrl}/runs/${encodeURIComponent(runId)}/events`,
  /**
   * 空间列表（3-T2/3-T3）。`status` 由服务端按可见范围过滤：`all`（默认，与不带
   * 参数等价）返回个人空间与全部有权团队空间；`archived` 只返回仍是现任成员的
   * 已归档团队空间，个人空间不出现（design §2.1，AC-23）。
   */
  getWorkspaces: (status: WorkspaceStatusFilter = 'all') => request<Workspace[]>(
    status === 'all' ? '/workspaces' : `/workspaces?status=${status}`,
    { method: 'GET' },
  ),
  createWorkspace: (input: { name: string; description: string }) => request<Workspace>('/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  /** 团队空间名称/说明保存（仅负责人；说明传 `null` 显式清空）。 */
  updateWorkspace: (workspaceId: string, input: WorkspaceUpdateInput) =>
    request<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  /** 归档团队空间（仅负责人）；有排队/运行中 Run 时服务端返回 409 state_conflict。 */
  archiveWorkspace: (workspaceId: string) =>
    request<WorkspaceLifecycleResult>(`/workspaces/${encodeURIComponent(workspaceId)}/archive`, {
      method: 'POST',
    }),
  /** 恢复已归档团队空间（仅负责人）。 */
  restoreWorkspace: (workspaceId: string) =>
    request<WorkspaceLifecycleResult>(`/workspaces/${encodeURIComponent(workspaceId)}/restore`, {
      method: 'POST',
    }),
  uploadWorkspaceFile: async (workspaceId: string, file: File) => request<Workspace['files'][number]>(
    `/workspaces/${encodeURIComponent(workspaceId)}/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
  ),
  uploadSessionFile: async (sessionId: string, file: File) => request<WorkspaceFile>(
    `/sessions/${encodeURIComponent(sessionId)}/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
  ),
  deleteSessionFile: (sessionId: string, fileId: string) =>
    request<{ id: string; removed: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' },
    ),
  /**
   * 逻辑文件的全部版本（TW-07 / 3-T9，读取轨：归档空间的现任成员仍可查看）。
   * 服务端按版本号倒序返回**含失败版本**的全部版本；`current` 与 `canDownload`
   * 均由服务端判定，前端不自行推断。只在团队分支调用（个人空间服务端返回 422）。
   */
  listWorkspaceFileVersions: (workspaceId: string, logicalFileId: string) =>
    request<WorkspaceFileVersionPage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(logicalFileId)}/versions`,
      { method: 'GET' },
    ),
  /**
   * 在既有逻辑文件下上传新版本（TW-07 / 3-T9，执行轨：归档与只读成员服务端返回
   * 403）。文件名走 `X-File-Name`（必须 `encodeURIComponent`），更新说明走可选的
   * `X-File-Note`（≤500；留空则不发送该头部，服务端存 `null`）。
   */
  uploadWorkspaceFileVersion: (workspaceId: string, logicalFileId: string, file: File, note?: string) => {
    const trimmedNote = clampFileNote(note)
    return request<UploadedWorkspaceFileVersion>(
      `/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(logicalFileId)}/versions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          ...(trimmedNote ? { 'X-File-Note': encodeURIComponent(trimmedNote) } : {}),
        },
        body: file,
      },
    )
  },
  /** 指定版本的历史下载（读取轨）；服务端在不可下载时拒绝。 */
  downloadWorkspaceFileVersion: (workspaceId: string, logicalFileId: string, versionNo: number) => requestBlob(
    `/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(logicalFileId)}/versions/${versionNo}/download`,
  ),
  getArtifacts: () => request<Artifact[]>('/artifacts'),
  downloadArtifact: (artifactId: string, version: number) => requestBlob(
    `/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`,
  ),
  artifactDownloadUrl: (artifactId: string, version: number) =>
    `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`,
  fileDownloadUrl: (fileId: string) => `${baseUrl}/files/${encodeURIComponent(fileId)}/download`,
  listMemberCandidates: (workspaceId: string, input: { query?: string; cursor?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<MemberCandidatePage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/member-candidates${suffix}`,
      { method: 'GET' },
    )
  },
  listWorkspaceMembers: (workspaceId: string) =>
    request<WorkspaceMemberDirectory>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'GET',
    }),
  /**
   * 团队历史会话分页（1B-T1）。只在团队分支调用：服务端对个人空间返回 422，
   * 对非成员返回 403（AC-23）。
   *
   * 服务端固定返回本人历史列表（TW-03 的 1B 口径）。
   * 依赖服务端默认值，`team` 只用于「本人无会话」时的一次性空间探测。
   */
  listWorkspaceSessions: (workspaceId: string, input: WorkspaceSessionQuery = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<WorkspaceSessionPage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sessions${suffix}`,
      { method: 'GET' },
    )
  },
  addWorkspaceMember: (workspaceId: string, input: { userId: string; role: TeamMemberRole }) =>
    request<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMemberRole: (workspaceId: string, userId: string, input: { role: TeamMemberRole }) =>
    request<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  removeWorkspaceMember: (workspaceId: string, userId: string) =>
    request<{ userId: string; removed: true }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  exitWorkspace: (workspaceId: string) =>
    request<{ workspaceId: string; exited: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/exit`, {
      method: 'POST',
    }),
  transferWorkspaceOwner: (workspaceId: string, input: { toUserId: string }) =>
    request<{ workspaceId: string; previousOwnerId: string; newOwnerId: string }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/owner-transfer`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  listWorkspaceAgentCandidates: (workspaceId: string, input: { query?: string; cursor?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<AgentCandidatePage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-candidates${suffix}`,
      { method: 'GET' },
    )
  },
  listWorkspaceAgentMembers: (workspaceId: string) =>
    request<WorkspaceAgentMember[]>(`/workspaces/${encodeURIComponent(workspaceId)}/agent-members`, {
      method: 'GET',
    }),
  addWorkspaceAgentMember: (workspaceId: string, input: { agentId: string }) =>
    request<WorkspaceAgentMember>(`/workspaces/${encodeURIComponent(workspaceId)}/agent-members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateWorkspaceAgentMember: (workspaceId: string, id: string, input: { action: AgentMemberPatchAction }) =>
    request<WorkspaceAgentMember>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-members/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    ),
  removeWorkspaceAgentMember: (workspaceId: string, id: string) =>
    request<{ id: string; removed: true }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-members/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /**
   * 团队动态 feed（TW-08 / design §2.9，读取轨）。摘要传 `limit: 3`，抽屉传
   * `limit: 20` + `cursor`。归档团队空间仍可读；个人空间服务端返回 422（AC-23），
   * 因此调用方只在团队分支请求。
   */
  listWorkspaceActivity: (workspaceId: string, input: WorkspaceActivityQuery = {}) => {
    const search = new URLSearchParams()
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<WorkspaceActivityPage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/activity${suffix}`,
      { method: 'GET' },
    )
  },
  /**
   * 未读通知分页 + 调用者本人的静音／已读状态。`items` 是**未读**条目，未读计数
   * 由服务端按 `last_read_at` 计算；静音时服务端报 0，但动态 feed 不受影响。
   */
  getWorkspaceNotifications: (workspaceId: string, input: WorkspaceActivityQuery = {}) => {
    const search = new URLSearchParams()
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<WorkspaceNotificationView>(
      `/workspaces/${encodeURIComponent(workspaceId)}/notifications${suffix}`,
      { method: 'GET' },
    )
  },
  /** 标记全部已读：只推进调用者本人的 `last_read_at`，归档空间同样可用。 */
  markWorkspaceNotificationsRead: (workspaceId: string) =>
    request<WorkspaceNotificationState>(
      `/workspaces/${encodeURIComponent(workspaceId)}/notifications/read`,
      { method: 'POST' },
    ),
  /** 关闭提醒：不隐藏动态，只让未读计数按服务端口径归零。 */
  muteWorkspaceNotifications: (workspaceId: string) =>
    request<WorkspaceNotificationState>(
      `/workspaces/${encodeURIComponent(workspaceId)}/notifications/mute`,
      { method: 'POST' },
    ),
  /** 恢复提醒。 */
  unmuteWorkspaceNotifications: (workspaceId: string) =>
    request<WorkspaceNotificationState>(
      `/workspaces/${encodeURIComponent(workspaceId)}/notifications/unmute`,
      { method: 'POST' },
    ),
  /**
   * 空间用量（TW-09 / 4-T2，读取轨）。只展示 token 与调用次数，服务端不返回金额
   * （口径 §1）。仅负责人／管理员可读：普通成员与只读成员服务端返回 403，个人空间
   * 422，因此调用方必须先在角色门禁内判定后才请求（AC-30）。
   */
  listWorkspaceUsage: (workspaceId: string, input: WorkspaceUsageQuery = {}) => {
    const search = new URLSearchParams()
    if (input.range) search.set('range', input.range)
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<WorkspaceUsage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/usage${suffix}`,
      { method: 'GET' },
    )
  },
  // ---- AG-03 自动任务 ----
  getAutomations: () => request<Automation[]>('/automations'),
  createAutomation: (input: {
    name: string
    agentId: string
    workspaceId: string
    schedule: AutomationSchedule
    inputTemplate: AutomationInputTemplate
  }) => request<Automation>('/automations', { method: 'POST', body: JSON.stringify(input) }),
  getAutomation: (id: string) => request<Automation>(`/automations/${encodeURIComponent(id)}`),
  updateAutomation: (id: string, input: {
    name?: string
    agentId?: string
    workspaceId?: string
    schedule?: AutomationSchedule
    inputTemplate?: AutomationInputTemplate
  }) => request<Automation>(`/automations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  enableAutomation: (id: string) =>
    request<Automation>(`/automations/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
  pauseAutomation: (id: string) =>
    request<Automation>(`/automations/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  disableAutomation: (id: string) =>
    request<Automation>(`/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  trialRunAutomation: (id: string, idempotencyKey: string) =>
    request<AutomationExecution>(`/automations/${encodeURIComponent(id)}/trial-runs`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey }),
    }),
  runAutomationNow: (id: string, idempotencyKey: string) =>
    request<AutomationExecution>(`/automations/${encodeURIComponent(id)}/run-now`, {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey }),
    }),
  listAutomationExecutions: (id: string) =>
    request<AutomationExecution[]>(`/automations/${encodeURIComponent(id)}/executions`),
}

/**
 * 更新说明的客户端上限（TW-07 / 3-T9）：先 trim，再按**码点**截断到 UTF-16 长度
 * ≤500。直接 `slice(0, 500)` 会把代理对劈成孤立半区，`encodeURIComponent` 随即抛
 * `URIError: URI malformed`（评审 P2 实测 `'a'.repeat(499) + '😀'`）；按码点累加也
 * 保证服务端再 `slice(0, 500)` 时不会二次截断到半个字符。
 */
export function clampFileNote(note: string | undefined): string {
  const trimmed = (note ?? '').trim()
  let result = ''
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0
    // 孤立代理半区（D800–DFFF）会让 encodeURIComponent 抛 URIError：无论长度是否
    // 超限都必须先剔除，否则一个恰好 500 长度的坏串就能打挂上传。
    if (code >= 0xd800 && code <= 0xdfff) continue
    if (result.length + character.length > 500) break
    result += character
  }
  return result
}
