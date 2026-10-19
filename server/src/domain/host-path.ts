import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 本机文件系统路径（Node 进程所在 OS：Windows 本地开发、Linux Docker 容器等）。
 *
 * - 拼接/解析：使用 `path.resolve` / `path.join`（自动使用当前 OS 的 `path.sep`）。
 * - 判断「是否在目录内」：使用本模块的 `isResolvedPathInsideDirectory` / `isStrictResolvedPathInside`，
 *   基于 `path.relative`，**不要**用硬编码 `'/'` 与 `resolve()` 结果做 `startsWith`。
 *
 * 与对象存储键、Manifest 工作区相对路径等「跨环境逻辑路径」无关；那些键始终为 POSIX `/`，
 * 请使用 `joinObjectKey()`（见 `object-storage.ts`）。
 */

/** `target` 解析后等于 `directory` 或位于其之下（跨平台）。 */
export function isResolvedPathInsideDirectory(directory: string, target: string): boolean {
  const base = resolve(directory)
  const resolved = resolve(target)
  if (base === resolved) return true
  const rel = relative(base, resolved)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** `child` 必须严格位于 `parent` 之下（不能等于 `parent`）。 */
export function isStrictResolvedPathInside(parent: string, child: string): boolean {
  const base = resolve(parent)
  const resolved = resolve(child)
  if (base === resolved) return false
  return isResolvedPathInsideDirectory(parent, child)
}

/** 将本机绝对路径转为相对 `base` 的 POSIX 路径（`/` 分隔，供 DSH/Manifest 使用）。 */
export function portableRelativePath(base: string, target: string): string {
  const rel = relative(resolve(base), resolve(target))
  if (rel === '') return ''
  return rel.split(sep).join('/')
}
