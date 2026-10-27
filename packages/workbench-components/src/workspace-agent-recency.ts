const STORAGE_KEY = 'dsh-workbench:recent-workspace-agent-member'

type RecentMap = Record<string, string>

/**
 * 浏览器里用 localStorage；测试或受限环境（没有 window.localStorage）时退化为
 * 进程内 Map，保证“最近使用 Agent”的语义仍可验证，而不是静默失效。
 */
const memoryStore = new Map<string, string>()

function storage(): Storage | undefined {
  try {
    const candidate = globalThis.window?.localStorage ?? globalThis.localStorage
    return candidate ?? undefined
  } catch {
    return undefined
  }
}

function readRaw(): string | null {
  const store = storage()
  if (store) return store.getItem(STORAGE_KEY)
  return memoryStore.get(STORAGE_KEY) ?? null
}

function writeRaw(value: string) {
  const store = storage()
  if (store) {
    store.setItem(STORAGE_KEY, value)
    return
  }
  memoryStore.set(STORAGE_KEY, value)
}

function readMap(): RecentMap {
  try {
    const raw = readRaw()
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const map: RecentMap = {}
    for (const [workspaceId, memberId] of Object.entries(parsed)) {
      if (typeof workspaceId === 'string' && typeof memberId === 'string' && workspaceId && memberId) {
        map[workspaceId] = memberId
      }
    }
    return map
  } catch {
    return {}
  }
}

function writeMap(map: RecentMap) {
  try {
    writeRaw(JSON.stringify(map))
  } catch {
    // 隐私模式或配额满时静默降级，不影响输入与发送。
  }
}

/** 读取某团队空间最近一次成功 @ 并发起执行的 Agent 成员 id。 */
export function getRecentWorkspaceAgentMemberId(workspaceId: string): string | null {
  if (!workspaceId) return null
  return readMap()[workspaceId] ?? null
}

/** 在团队空间成功提交带 @Agent 的消息后写入最近使用记录。 */
export function recordRecentWorkspaceAgentMember(workspaceId: string, memberId: string) {
  if (!workspaceId || !memberId) return
  const map = readMap()
  map[workspaceId] = memberId
  writeMap(map)
}
