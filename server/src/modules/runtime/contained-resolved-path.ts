import { isAbsolute, relative, resolve } from 'node:path'

/** True when `target` resolves to `directory` or a path under it (portable across platforms). */
export function isResolvedPathInsideDirectory(directory: string, target: string): boolean {
  const base = resolve(directory)
  const resolved = resolve(target)
  if (base === resolved) return true
  const rel = relative(base, resolved)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}
