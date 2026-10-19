import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join, posix, resolve, win32 } from 'node:path'

import {
  isResolvedPathInsideDirectory,
  isStrictResolvedPathInside,
  portableRelativePath,
} from './host-path.ts'

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

describe('isStrictResolvedPathInside', () => {
  it('accepts child directories on POSIX paths', () => {
    const root = posix.resolve('/var/run/ws-1')
    const output = posix.resolve(root, 'output')
    assert.equal(isStrictResolvedPathInside(root, output), true)
  })

  it('accepts child directories on Windows-style paths', () => {
    const root = win32.resolve('G:\\runtime\\ws-1')
    const output = win32.resolve(root, 'output')
    assert.equal(isStrictResolvedPathInside(root, output), true)
  })

  it('rejects the parent itself', () => {
    const root = posix.resolve('/var/run/ws-1')
    assert.equal(isStrictResolvedPathInside(root, root), false)
  })

  it('rejects paths outside the parent', () => {
    const root = posix.resolve('/var/run/ws-1')
    const outside = posix.resolve('/var/run/ws-2')
    assert.equal(isStrictResolvedPathInside(root, outside), false)
  })
})

describe('portableRelativePath', () => {
  it('uses forward slashes on Windows-style roots', () => {
    const root = win32.resolve('G:\\run\\ws\\output')
    const file = win32.resolve(root, 'note.md')
    assert.equal(portableRelativePath(root, file), 'note.md')
  })
})
