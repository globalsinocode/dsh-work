/**
 * EX-02「继续」的语义：员工只发一句“继续”时，意图可能是重新执行失败的一轮、继续修改
 * 上一轮成果，或接着讨论。只有这两种上下文需要先问清楚：
 *
 * - 当前一轮失败或已停止（且允许重新执行）：重新执行上一轮，或作为新消息发送；
 * - 当前一轮成功并留下可引用的成果：继续修改这些成果，或作为新消息发送。
 *
 * 其他情况（带附件、已引用成果、内容不只是“继续”）照常发送。历史与摘要中的
 * “同意”“继续”只是历史内容，不构成新的工具授权——这一条由运行时提示词保证。
 */

const BARE_CONTINUE = new Set([
  '继续', '请继续', '继续吧', '继续执行', '继续做', '继续处理', '接着', '接着做', '接着来',
  'go on', 'continue',
])

/** 去掉空白与常见标点后，是否只是一句“继续”。 */
export function isBareContinue(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase()
    .replace(/[\s。．.！!？?~～…，,、]+$/u, '')
    .replace(/^[\s，,]+/u, '')
  return BARE_CONTINUE.has(normalized)
}

export interface ContinueArtifact { fileId: string; name: string; version: number }

export type ContinueChoice =
  | { kind: 'retry' }
  | { kind: 'revise'; artifacts: ContinueArtifact[] }

export const MAX_REFERENCED_ARTIFACTS = 5

export function continueChoice(input: {
  prompt: string
  hasAttachments: boolean
  status: string
  canRetry: boolean
  artifacts: Array<{ fileId?: string; name: string; version: number; canReference?: boolean }>
}): ContinueChoice | null {
  if (input.hasAttachments || !isBareContinue(input.prompt)) return null
  if (['failed', 'cancelled'].includes(input.status)) return input.canRetry ? { kind: 'retry' } : null
  if (input.status !== 'succeeded') return null
  const artifacts = input.artifacts
    .filter((item): item is typeof item & { fileId: string } => Boolean(item.canReference && item.fileId))
    .slice(0, MAX_REFERENCED_ARTIFACTS)
    .map(item => ({ fileId: item.fileId, name: item.name, version: item.version }))
  return artifacts.length ? { kind: 'revise', artifacts } : null
}
