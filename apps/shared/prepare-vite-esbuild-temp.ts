import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Windows 上 esbuild 默认使用 %TEMP%，杀毒或并行构建常导致清理临时文件 Access denied。
 * 在 vite.config 最顶部 import 一次，把 TMP/TEMP 指到应用包内可写目录。
 */
export function prepareViteEsbuildTemp(configUrl: string) {
  const packageRoot = fileURLToPath(new URL('.', configUrl))
  const localTemp = join(packageRoot, '.esbuild-tmp')
  mkdirSync(localTemp, { recursive: true })
  process.env.TMP = localTemp
  process.env.TEMP = localTemp
  process.env.ESBUILD_TMPDIR = localTemp
}
