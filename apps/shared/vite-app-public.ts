import fs from 'node:fs'
import path from 'node:path'

interface BuildWriteOptions {
  dir?: string
}

/** 与 Vite Plugin 结构兼容；此处不 import 'vite'，因为共享目录没有依赖解析路径。 */
export interface AppPublicPlugin {
  name: string
  apply: 'build'
  writeBundle(options: BuildWriteOptions): void
}

function copyEntry(src: string, dest: string): void {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const child of fs.readdirSync(src)) {
      copyEntry(path.join(src, child), path.join(dest, child))
    }
    return
  }
  fs.copyFileSync(src, dest)
}

/**
 * publicDir 只能指向一个目录。两个前端的 publicDir 都换成了共享品牌资源目录，
 * 应用自己的 public/（例如 workbench 的 push-sw.js）因此不会进产物。
 * 这里在产物写出后把应用 public/ 逐条目合并进去，保持 publicDir 语义不变。
 */
export function copyAppPublic(appPublicDir: string): AppPublicPlugin {
  return {
    name: 'dsh-work:copy-app-public',
    apply: 'build',
    writeBundle(options) {
      if (!fs.existsSync(appPublicDir)) return
      const outDir = options.dir ?? path.resolve('dist')
      fs.mkdirSync(outDir, { recursive: true })
      for (const entry of fs.readdirSync(appPublicDir)) {
        copyEntry(path.join(appPublicDir, entry), path.join(outDir, entry))
      }
    },
  }
}
