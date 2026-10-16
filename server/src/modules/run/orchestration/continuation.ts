import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'

/**
 * Appends assistant output already committed by earlier Attempts of the same
 * Run (e.g. a partial answer preserved after RUN_TIMEOUT) to the retry's
 * conversation history, so the new Attempt continues from confirmed content
 * instead of starting blank. The triggering user question is re-appended
 * before the partial outputs — otherwise the model sees "partial answer →
 * question" and re-answers instead of continuing. The manifest message then
 * becomes a continue instruction rather than the question repeated.
 * The merge stays inside the conversation budget (EX-02, 64000 chars); the
 * session's first message is kept, then the oldest remaining entries are
 * evicted first because the interrupted output is more relevant than them.
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
  if (!outputs.length) {
    const merged = [...history]
    const size = () => merged.reduce((total, entry) => total + entry.content.length, 0)
    while (merged.length > maxMessages && merged.length > evictFrom + 1) merged.splice(evictFrom, 1)
    while (size() > maxChars && merged.length > evictFrom + 1) merged.splice(evictFrom, 1)
    if (size() > maxChars) {
      const last = merged.at(-1)!
      const room = Math.max(0, maxChars - (size() - last.content.length))
      merged[merged.length - 1] = { ...last, content: last.content.slice(-room) }
    }
    return { history: merged.filter(entry => entry.content), message: prompt }
  }
  // 尾部受保护段 = 原始问题 + 各次已提交的部分回答。裁剪只动更早的会话历史与
  // 最旧的部分回答，绝不让超长部分输出把原始问题挤掉——否则模型失去任务目标。
  const merged = [...history, { role: 'user' as const, content: prompt }]
  for (const output of outputs) merged.push({ role: 'assistant' as const, content: output.content })
  const pinned = outputs.length + 1 + evictFrom
  let used = merged.reduce((total, entry) => total + entry.content.length, 0)
  while ((merged.length > maxMessages || used > maxChars) && merged.length > pinned) {
    used -= merged.splice(evictFrom, 1)[0]!.content.length
  }
  // 受保护段仍超限：逐个丢弃最旧的部分回答（保留首条消息、原始问题与最新输出）。
  const questionIndex = () => merged.length - outputs.length - 1
  while (used > maxChars && merged.length - questionIndex() > 2) {
    used -= merged.splice(questionIndex() + 1, 1)[0]!.content.length
    outputs.pop()
  }
  if (used > maxChars && evictFrom && merged.length > 2) used -= merged.splice(0, 1)[0]!.content.length
  if (used > maxChars) {
    const last = merged.at(-1)!
    const room = Math.max(0, maxChars - (used - last.content.length))
    merged[merged.length - 1] = { ...last, content: last.content.slice(-room) }
  }
  return {
    history: merged.filter(entry => entry.content),
    message: '上一次回答在输出中途被中断。请从已有内容的断点处继续完成回答，不要重复已输出的部分。',
  }
}
