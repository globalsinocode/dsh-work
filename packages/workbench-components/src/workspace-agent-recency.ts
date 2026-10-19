const STORAGE_KEY = 'dsh-workbench:recent-workspace-agent-member'

type RecentMap = Record<string, string>

function readMap(): RecentMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
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
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
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
