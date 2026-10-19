/**
 * 请求失败的两种性质，页面对它们的处理完全不同，不能混为一谈：
 *
 * - **确实不存在/无权访问**（`isNotFoundError`）：目标真的没了，缓存条目可以逐出，
 *   页面落成「未找到对话」是对的。
 * - **暂时性失败**（`isTransientRequestError`）：5xx（含网关 504）、超时、限流、断网。
 *   按「不存在」处理会让员工以为对话丢了，而且缓存被删后没有自动恢复路径。
 *
 * 两者都用鸭子类型而不是 `instanceof`：测试替身会整模块替换 `@/api/client`，
 * 取不到错误类。也无法识别的错误形态一律**不当作**暂时性失败，保持既有回退语义。
 */

const NOT_FOUND_CODES = new Set([
  'run_not_found',
  'session_not_found',
  'not_found',
  'resource_not_found',
])

/** 明确表示「不存在/无权」：HTTP 404 或显式 not_found 业务码。 */
export function isNotFoundError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  if ((cause as { status?: unknown }).status === 404) return true
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && NOT_FOUND_CODES.has(code)
}

/**
 * 明确表示「稍后可以再试」：5xx、408、429，以及 fetch 在网络故障时抛出的 TypeError
 * （此类错误没有 status）。其余形态返回 false，避免把未知错误误判成暂时性故障。
 */
export function isTransientRequestError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const status = (cause as { status?: unknown }).status
  if (typeof status === 'number') return status >= 500 || status === 408 || status === 429
  return (cause as { name?: unknown }).name === 'TypeError'
}
