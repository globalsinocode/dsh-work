import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'

/**
 * Appends assistant output already committed by earlier Attempts of the same
 * Run (e.g. a partial answer preserved after RUN_TIMEOUT) to the retry's
 * conversation history, so the new Attempt continues from confirmed content
 * instead of starting blank. The triggering user question is re-appended
 * before the partial outputs — otherwise the model sees "partial answer →
 * question" and re-answers instead of continuing. The manifest message then
 * becomes a continue instruction rather than the question repeated.
 * The merge stays inside the conversation budget (EX-02, 64000 chars); history
 * 是摘要覆盖点之后的对话，淘汰它会留下摘要与保留历史之间的静默空档，因此优先
 * 淘汰最旧的部分回答；只有历史与原始问题本身超限时才动历史（保留首条消息）。
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
  // 尾部受保护段 = 原始问题 + 各次已提交的部分回答。history 是摘要覆盖点之后的对话：
  // 淘汰它会留下“摘要说覆盖到 X、保留历史却从 Y 开始”的静默空档，因此优先淘汰最旧的
  // 部分回答；只有历史 + 原始问题本身超限时才动历史（并保留首条消息，EX-02）。
  const merged = [...history, { role: 'user' as const, content: prompt }]
  const firstOutputIndex = merged.length
  for (const output of outputs) merged.push({ role: 'assistant' as const, content: output.content })
  let keptOutputs = outputs.length
  let used = merged.reduce((total, entry) => total + entry.content.length, 0)
  while ((used > maxChars || merged.length > maxMessages) && merged.length > firstOutputIndex) {
    used -= merged.splice(firstOutputIndex, 1)[0]!.content.length
    keptOutputs -= 1
  }
  const protectedTail = evictFrom + 1
  while ((used > maxChars || merged.length > maxMessages) && merged.length > protectedTail + 1) {
    used -= merged.splice(evictFrom, 1)[0]!.content.length
  }
  if (used > maxChars) {
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
