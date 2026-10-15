import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'

/**
 * Appends assistant output already committed by earlier Attempts of the same
 * Run (e.g. a partial answer preserved after RUN_TIMEOUT) to the retry's
 * conversation history, so the new Attempt continues from confirmed content
 * instead of starting blank. The triggering user question is re-appended
 * before the partial outputs — otherwise the model sees "partial answer →
 * question" and re-answers instead of continuing. The manifest message then
 * becomes a continue instruction rather than the question repeated.
 * The merge stays inside the manifest bound (≤12 messages, ≤24000 chars);
 * oldest entries are evicted first because the interrupted output is more
 * relevant than the oldest turn.
 */
export async function withContinuationOutputs(
conversations: Pick<PostgresConversationRepository, 'getRunAssistantOutputs'>,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  runId: string,
  prompt: string,
): Promise<{ history: Array<{ role: 'user' | 'assistant'; content: string }>; message: string }> {
  const outputs = (await conversations.getRunAssistantOutputs(runId)).filter(output => output.content.trim())
  if (!outputs.length) {
    const merged = [...history]
    while (merged.length > 12) merged.shift()
    let used = merged.reduce((total, entry) => total + entry.content.length, 0)
    while (used > 24_000 && merged.length > 1) used -= merged.shift()!.content.length
    if (used > 24_000) merged[0] = { ...merged[0]!, content: merged[0]!.content.slice(-24_000) }
    return { history: merged, message: prompt }
  }
  // 尾部受保护段 = 原始问题 + 各次已提交的部分回答。裁剪只动更早的会话历史与
  // 最旧的部分回答，绝不让超长部分输出把原始问题挤掉——否则模型失去任务目标。
  const merged = [...history, { role: 'user' as const, content: prompt }]
  for (const output of outputs) merged.push({ role: 'assistant' as const, content: output.content })
  const pinned = outputs.length + 1
  while (merged.length > 12 && merged.length > pinned) merged.shift()
  let used = merged.reduce((total, entry) => total + entry.content.length, 0)
  while (used > 24_000 && merged.length > pinned) used -= merged.shift()!.content.length
  // 受保护段仍超限：逐个丢弃最旧的部分回答（保留原始问题与最新输出）。
  while (used > 24_000 && merged.length > 2) used -= merged.splice(1, 1)[0]!.content.length
  if (used > 24_000) {
    const last = merged.at(-1)!
    const room = Math.max(0, 24_000 - (used - last.content.length))
    merged[merged.length - 1] = { ...last, content: last.content.slice(-room) }
  }
  return {
    history: merged,
    message: '上一次回答在输出中途被中断。请从已有内容的断点处继续完成回答，不要重复已输出的部分。',
  }
}
