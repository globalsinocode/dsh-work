import { describe, expect, it } from 'vitest'

import { continueChoice, isBareContinue } from './continue-intent'

const artifact = (name: string, extra: Partial<{ fileId: string; canReference: boolean }> = {}) =>
  ({ name, version: 1, fileId: `file-${name}`, canReference: true, ...extra })

describe('continue intent', () => {
  it('recognises a bare “继续” with punctuation and spacing, nothing more', () => {
    for (const prompt of ['继续', ' 继续。', '请继续！', '继续吧~', '接着做', 'Go on.', 'continue']) {
      expect(isBareContinue(prompt), prompt).toBe(true)
    }
    for (const prompt of ['继续写第三节', '继续修改标题', '不要继续', '', '继续，然后加一张表']) {
      expect(isBareContinue(prompt), prompt).toBe(false)
    }
  })

  it('asks to re-run a failed or stopped round only when it may be re-run', () => {
    const base = { prompt: '继续', hasAttachments: false, artifacts: [] }
    expect(continueChoice({ ...base, status: 'failed', canRetry: true })).toEqual({ kind: 'retry' })
    expect(continueChoice({ ...base, status: 'cancelled', canRetry: true })).toEqual({ kind: 'retry' })
    expect(continueChoice({ ...base, status: 'failed', canRetry: false })).toBeNull()
  })

  it('offers to revise the referable deliverables of a successful round', () => {
    const choice = continueChoice({
      prompt: '继续', hasAttachments: false, status: 'succeeded', canRetry: false,
      artifacts: [artifact('周报.md'), artifact('草稿.md', { canReference: false }), artifact('附录.csv')],
    })
    expect(choice).toEqual({ kind: 'revise', artifacts: [
      { fileId: 'file-周报.md', name: '周报.md', version: 1 },
      { fileId: 'file-附录.csv', name: '附录.csv', version: 1 },
    ] })
  })

  it('sends as usual otherwise', () => {
    const base = { hasAttachments: false, canRetry: true, artifacts: [artifact('周报.md')] }
    expect(continueChoice({ ...base, prompt: '继续', status: 'succeeded', artifacts: [] })).toBeNull()
    expect(continueChoice({ ...base, prompt: '继续', status: 'running' })).toBeNull()
    expect(continueChoice({ ...base, prompt: '把标题改短', status: 'succeeded' })).toBeNull()
    expect(continueChoice({ ...base, prompt: '继续', status: 'succeeded', hasAttachments: true })).toBeNull()
  })
})
