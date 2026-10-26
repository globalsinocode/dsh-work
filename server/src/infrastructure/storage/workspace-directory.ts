import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/**
 * Execution isolation 1c (plan 3.7): code in the execution container can replace a
 * workspace directory such as `output/` with a symlink to any host path. A host-side
 * reader calls this before listing the directory: it must be a real directory (not a
 * link) at exactly its place inside the resolved workspace. Entries inside are still
 * checked one by one by the caller (regular files only). Returns false when the
 * directory does not exist.
 */
export async function assertRealWorkspaceDirectory(workspaceRoot: string, directory: string): Promise<boolean> {
  const expected = relative(workspaceRoot, directory)
  if (expected === '' || expected.startsWith('..') || isAbsolute(expected)) throw new Error('工作区目录不在工作区内')
  let details
  try {
    details = await lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`工作区目录不是真实目录：${expected}`)
  const [root, resolved] = await Promise.all([realpath(workspaceRoot), realpath(directory)])
  if (resolved !== join(root, expected)) throw new Error(`工作区目录解析到了工作区之外：${expected}`)
  return true
}
