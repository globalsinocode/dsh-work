/**
 * 推荐 AI 同事的预填问题（推荐方案 4.3）：经浏览器历史状态传给目标对话页，不进入地址栏。
 * 目标页读取一次后从历史状态中删除，刷新或前进后退都不会再次预填。
 */
const STATE_KEY = 'agentRecommendationPrefill'

export function recommendationPrefillState(prompt: string): Record<string, string> {
  return { [STATE_KEY]: prompt }
}

export function takeRecommendationPrefill(): string {
  const state = (window.history.state ?? {}) as Record<string, unknown>
  const value = typeof state[STATE_KEY] === 'string' ? state[STATE_KEY] : ''
  if (value) {
    const rest = { ...state }
    delete rest[STATE_KEY]
    window.history.replaceState(rest, '')
  }
  return value
}
