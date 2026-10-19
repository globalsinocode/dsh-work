import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { isResolvedPathInsideDirectory } from './contained-resolved-path.ts'

describe('isResolvedPathInsideDirectory', () => {
  it('accepts descendants on POSIX-style roots', () => {
    const root = resolve('/tmp/workspace/skills/my-skill')
    const child = join(root, 'SKILL.md')
    assert.equal(isResolvedPathInsideDirectory(root, child), true)
  })

  it('accepts descendants when the root uses Windows drive letters', () => {
    const root = resolve('G:\\workspace\\data\\skills\\demo')
    const child = join(root, 'references', 'guide.md')
    assert.equal(isResolvedPathInsideDirectory(root, child), true)
  })

  it('rejects paths that escape the root', () => {
    const root = resolve('/tmp/workspace')
    const outside = resolve('/tmp/other/file.txt')
    assert.equal(isResolvedPathInsideDirectory(root, outside), false)
  })

  it('treats the directory itself as inside', () => {
    const root = resolve('/tmp/workspace')
    assert.equal(isResolvedPathInsideDirectory(root, root), true)
  })
})
