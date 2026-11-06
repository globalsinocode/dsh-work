#!/usr/bin/env node
/**
 * Build and run the dsh-work dev container (full stack + hot reload).
 * Usage: node scripts/dev/dsh-work-docker.mjs up|up:fg|down|logs|build|reset-volumes
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '../..')
const composeFile = resolve(projectRoot, 'deploy/dsh-work.compose.yaml')
const envFile = resolve(projectRoot, '.env')

function loadDotEnv() {
  if (!existsSync(envFile)) return
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function composeArgs() {
  return ['compose', '--project-name', 'dsh-work-dev', '--env-file', envFile, '-f', composeFile]
}

function runDocker(args, { inherit = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: projectRoot,
    env: process.env,
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    if (!inherit && result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
}

function freeDevPortsOnHost() {
  const freeScript = resolve(projectRoot, 'scripts/dev/free-dev-ports.mjs')
  spawnSync(process.execPath, ['--env-file-if-exists=.env', freeScript], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })
}

function warnExecutionImage() {
  if (!process.env.DSH_WORK_EXECUTION_IMAGE?.trim()) {
    console.warn('提示：.env 未设置 DSH_WORK_EXECUTION_IMAGE，AI 对话会因执行容器检查失败。见 .env.example。')
  }
}

function printUrls() {
  const wb = process.env.DSH_WORK_WORKBENCH_PORT ?? '4174'
  const admin = process.env.DSH_WORK_ADMIN_PORT ?? '4180'
  const api = process.env.DSH_WORK_SERVER_PORT ?? '4190'
  console.log('')
  console.log('容器 dsh-work-dev-hot 已启动（改本地代码会自动热更新）：')
  console.log(`  员工端  http://localhost:${wb}/workbench`)
  console.log(`  管理端  http://localhost:${admin}/overview`)
  console.log(`  后端    http://localhost:${api}/health`)
  console.log('  Docker Desktop 里可对容器 dsh-work-dev-hot 点 Start / Stop')
  console.log('  日志: pnpm dev:docker:logs')
}

function main() {
  const command = process.argv[2] ?? 'up'
  loadDotEnv()
  warnExecutionImage()

  switch (command) {
    case 'up':
      freeDevPortsOnHost()
      runDocker([...composeArgs(), 'up', '--build', '-d'], { inherit: true })
      printUrls()
      break
    case 'up:fg':
      freeDevPortsOnHost()
      runDocker([...composeArgs(), 'up', '--build'], { inherit: true })
      break
    case 'build':
      runDocker([...composeArgs(), 'build'], { inherit: true })
      break
    case 'down':
      runDocker([...composeArgs(), 'down'], { inherit: true })
      break
    case 'reset-volumes':
      runDocker([...composeArgs(), 'down', '-v'], { inherit: true })
      console.warn('已删除 dsh-work 的 node_modules 卷；下次 up 会重新 pnpm install。')
      break
    case 'logs':
      runDocker([...composeArgs(), 'logs', '-f', 'dsh-work-dev'], { inherit: true })
      break
    default:
      console.error('Usage: node scripts/dev/dsh-work-docker.mjs up|up:fg|down|logs|build|reset-volumes')
      process.exit(1)
  }
}

main()
