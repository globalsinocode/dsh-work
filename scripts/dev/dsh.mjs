import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** @returns {string} */
export function resolveDshRuntimeHome(env = process.env) {
  const configured = env.DSH_RUNTIME_HOME ?? env.DSH_REPOSITORY
  if (configured) return resolve(configured)
  for (const relative of ['deploy/deepseek-harness', '../deepseek-harness']) {
    const candidate = resolve(projectRoot, relative)
    if (existsSync(resolve(candidate, 'package.json'))) return candidate
  }
  return resolve(projectRoot, 'deploy/deepseek-harness')
}

function main() {
  const home = resolveDshRuntimeHome()
  const packageJson = resolve(home, 'package.json')
  if (!existsSync(packageJson)) {
    console.error(
      [
        '未找到 DSH 源码 checkout。',
        `期望路径：${home}`,
        '请将 deepseek-harness 克隆到 deploy/deepseek-harness，或设置 DSH_RUNTIME_HOME。',
        '参见 docs/release/dsh-runtime-delivery.md',
      ].join('\n'),
    )
    process.exit(1)
  }
  if (!existsSync(resolve(home, 'node_modules'))) {
    console.error(`DSH checkout 缺少依赖，请在该目录执行：pnpm install\n  cd ${home}`)
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const entry = resolve(home, 'apps/cli/src/bin.ts')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', entry, ...args],
    {
      cwd: home,
      stdio: 'inherit',
      env: process.env,
    },
  )
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
