import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const isTestFile = path => /\.test\.[cm]?[jt]s$/.test(path)

/**
 * 服务启动时从 `server/config` 读取的定义（DSH 配置、执行脚本、内置 Skill、Agent 预置等）必须随发布包交付。
 * 规则按目录而非逐项登记：`server/config` 下除测试文件外的每个受版本管理的文件都必须被打包脚本复制，
 * 新增配置不会被遗漏；未纳入版本管理的本机文件（.DS_Store、编辑器临时文件）不参与判断。
 */
export function serverConfigFiles(root) {
  const configRoot = resolve(root, 'server/config')
  if (!existsSync(configRoot)) return []
  let files
  try {
    files = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'server/config'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean).filter(file => existsSync(resolve(root, file)))
  } catch {
    // 不在 Git 仓库中（测试夹具）：按目录列出，跳过隐藏文件。
    files = readdirSync(configRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => `server/config/${join(entry.parentPath, entry.name).slice(configRoot.length + 1).split('\\').join('/')}`)
      .filter(file => !file.split('/').some(part => part.startsWith('.')))
  }
  return files.filter(file => !isTestFile(file)).sort()
}

/** 打包脚本中 `cp` 命令以 `${project_root}/…` 引用的源路径（注释掉的命令不算）。 */
export function releaseCopySources(script) {
  return script.split('\n')
    .filter(line => /^\s*cp\s/.test(line))
    .flatMap(line => [...line.matchAll(/"\$\{project_root\}\/([^"$]+)"/g)].map(match => match[1].replace(/\/$/, '')))
}

/** 没有被任何复制源（文件本身或其上级目录）覆盖的配置文件。 */
export function uncoveredConfigFiles(root, script = readFileSync(resolve(root, 'scripts/release/build-release.sh'), 'utf8')) {
  const sources = releaseCopySources(script)
  return serverConfigFiles(root).filter(file => !sources.some(source => file === source || file.startsWith(`${source}/`)))
}

/** 发布包中缺少的配置文件。 */
export function missingBundleFiles(root, bundle) {
  return serverConfigFiles(root).filter(file => !existsSync(resolve(bundle, file)))
}
