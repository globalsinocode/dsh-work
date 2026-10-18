import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'

/**
 * Appends assistant output already committed by earlier Attempts of the same
 * Run (e.g. a partial answer preserved after RUN_TIMEOUT) to the retry's
 * conversation history, so the new Attempt continues from confirmed content
 * instead of starting blank. The triggering user question is re-appended
 * before the partial outputs — otherwise the model sees "partial answer →
 * question" and re-answers instead of continuing. The manifest message then
 * becomes a continue instruction rather than the question repeated.
 * The merge stays inside the conversation budget (EX-02, 64000 chars): older
 * partial outputs go first, then the oldest history (keeping the first message),
 * and the newest partial output is only ever truncated, never dropped — dropping
 * it would silently turn the continuation into a fresh answer.
 */
export interface ContinuationBounds {
  maxMessages: number
  maxChars: number
  /** Keep the first history entry (the session's first message, EX-02) when trimming. */
  keepFirst: boolean
}

/** Workbench conversations (EX-02 budget). */
export const workbenchContinuationBounds: ContinuationBounds = { maxMessages: 500, maxChars: 64_000, keepFirst: true }
/** Admin conversations keep their own 12-message / 24000-character window. */
export const adminContinuationBounds: ContinuationBounds = { maxMessages: 12, maxChars: 24_000, keepFirst: false }

export async function withContinuationOutputs(
  conversations: Pick<PostgresConversationRepository, 'getRunAssistantOutputs'>,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  runId: string,
  prompt: string,
  bounds: ContinuationBounds = workbenchContinuationBounds,
): Promise<{ history: Array<{ role: 'user' | 'assistant'; content: string }>; message: string }> {
  const { maxMessages, maxChars } = bounds
  const outputs = (await conversations.getRunAssistantOutputs(runId)).filter(output => output.content.trim())
  // Index of the oldest entry that may be evicted.
  const evictFrom = bounds.keepFirst && history.length > 0 ? 1 : 0
  // 没有部分输出时不追加问题：调用方会把 prompt 作为 input.message 单独发送，
  // 追加会在上下文里重复同一句话。
  const merged = [...history]
  const questionIndex = outputs.length ? merged.length : -1
  if (questionIndex >= 0) merged.push({ role: 'user' as const, content: prompt })
  for (const output of outputs) merged.push({ role: 'assistant' as const, content: output.content })
  let keptOutputs = outputs.length
  let used = merged.reduce((total, entry) => total + entry.content.length, 0)
  const overBudget = () => used > maxChars || merged.length > maxMessages
  // 淘汰顺序（P2-26）：
  // 1. 较早的部分回答——最新一条是续写的断点，必须保留；
  // 2. 最旧的会话历史（保留首条消息，EX-02）——会在摘要与保留历史之间留下空档，只在 1 不够时动；
  // 3. 最后截取最新部分回答的结尾。整段丢掉最新输出会让续写退回重新作答。
  const firstOutputIndex = questionIndex + 1
  while (overBudget() && keptOutputs > 1) {
    used -= merged.splice(firstOutputIndex, 1)[0]!.content.length
    keptOutputs -= 1
  }
  // 受保护的尾部：原始问题与最新部分回答（无部分输出时是最后一条历史）。
  const protectedTail = keptOutputs > 0 ? 2 : 1
  while (overBudget() && merged.length > evictFrom + protectedTail) {
    used -= merged.splice(evictFrom, 1)[0]!.content.length
  }
  while (overBudget() && evictFrom > 0 && merged.length > protectedTail) {
    used -= merged.splice(0, 1)[0]!.content.length
  }
  if (used > maxChars && merged.length) {
    const last = merged.at(-1)!
    const room = Math.max(0, maxChars - (used - last.content.length))
    merged[merged.length - 1] = { ...last, content: last.content.slice(-room) }
  }
  return {
    history: merged.filter(entry => entry.content),
    message: keptOutputs > 0
      ? '上一次回答在输出中途被中断。请从已有内容的断点处继续完成回答，不要重复已输出的部分。'
      : prompt,
  }
}
