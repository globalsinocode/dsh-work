/**
 * 进入与某位 AI 同事的新对话时的预填问题（推荐方案 4.3）：经浏览器历史状态传给目标对话页，不进入地址栏。
 * 目标页读取一次后从历史状态中删除，刷新或前进后退都不会再次预填。空字符串表示明确不预填
 * （Skill 广场“创建 Skill”，Skill 创建专家方案 4.8），目标页也不用同事的示例问题补位。
 */
const STATE_KEY = 'agentRecommendationPrefill'

export function recommendationPrefillState(prompt: string): Record<string, string> {
  return { [STATE_KEY]: prompt }
}

/** 读取并清除预填问题；没有传入时为 null。 */
export function takeRecommendationPrefill(): string | null {
  const state = (window.history.state ?? {}) as Record<string, unknown>
  const value = typeof state[STATE_KEY] === 'string' ? state[STATE_KEY] : null
  if (value !== null) {
    const rest = { ...state }
    delete rest[STATE_KEY]
    window.history.replaceState(rest, '')
  }
  return value
}
