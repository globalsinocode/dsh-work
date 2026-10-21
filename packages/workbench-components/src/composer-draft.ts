/** TaskComposer 可序列化的未发送草稿（不含工作空间 id）。 */
export interface ComposerDraft {
  prompt: string
  files: File[]
  mentions: Array<{ id: string; name: string; start: number }>
}

export function emptyComposerDraft(): ComposerDraft {
  return { prompt: '', files: [], mentions: [] }
}
