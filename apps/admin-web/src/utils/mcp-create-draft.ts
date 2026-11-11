/** 管理端「新增 MCP」表单草稿：OAuth 跳转或关闭弹窗后仍可恢复，避免重复填写。 */

const STORAGE_KEY = 'dsh-work:admin:mcp-create-draft'
const TTL_MS = 7 * 24 * 60 * 60 * 1000

export type McpCreateFormDraft = {
  name: string
  endpoint: string
  authType: 'none' | 'bearer' | 'user_oauth'
  bearerToken: string
  scopeDescription: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  scopesText: string
  resource: string
}

export type McpCreateDraft = {
  savedAt: string
  form: McpCreateFormDraft
  testError?: { title: string; description: string } | null
  awaitingProbeOAuth?: boolean
  /** OAuth 探活跳转前为「编辑登记」时带回连接器 id */
  mode?: 'create' | 'edit'
  editingConnectorId?: string
}

type StoredPayload = McpCreateDraft & { expiresAt: number }

function hasSessionStorage(): boolean {
  try {
    return typeof sessionStorage !== 'undefined'
  } catch {
    return false
  }
}

export function saveMcpCreateDraft(draft: Omit<McpCreateDraft, 'savedAt'>): void {
  if (!hasSessionStorage()) return
  const payload: StoredPayload = {
    ...draft,
    savedAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL_MS,
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 配额或隐私模式：不阻断主流程
  }
}

export function loadMcpCreateDraft(): McpCreateDraft | null {
  if (!hasSessionStorage()) return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredPayload
    if (!parsed?.form || typeof parsed.expiresAt !== 'number' || parsed.expiresAt < Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    const { expiresAt: _expiresAt, ...draft } = parsed
    return draft
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function clearMcpCreateDraft(): void {
  if (!hasSessionStorage()) return
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

export function hasMcpCreateDraft(): boolean {
  return loadMcpCreateDraft() !== null
}
