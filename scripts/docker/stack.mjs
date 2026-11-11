#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '../..')
const composeDir = resolve(projectRoot, 'deploy/docker')
const stackEnv = resolve(composeDir, 'stack.env')
const stackExample = resolve(composeDir, 'stack.env.example')
const tlsCert = resolve(composeDir, 'tls/server.crt')
const tlsKey = resolve(composeDir, 'tls/server.key')

function composeArgs() {
  return ['compose', '--project-name', 'dsh-work', '--env-file', 'stack.env', '-f', 'compose.yaml']
}

function runDocker(args, { inherit = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: composeDir,
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    if (!inherit && result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
}

function ensureStackEnv() {
  if (existsSync(stackEnv)) return
  console.error(`缺少 ${stackEnv}`)
  console.error(`请执行: copy deploy\\docker\\stack.env.example deploy\\docker\\stack.env 并编辑密码与 ACP 配置`)
  process.exit(1)
}

/** DSH harness build reads DSH_CLIENT_COMMIT_HASH; .git is not in the image build context. */
function resolveGitCommitForBuild() {
  const result = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status === 0) {
    const hash = result.stdout.trim()
    if (/^[0-9a-f]{7,40}$/i.test(hash)) return hash.slice(0, 7).toLowerCase()
  }
  return '0000000'
}

function ensureBuildMetadata() {
  if (!process.env.DSH_CLIENT_COMMIT_HASH) {
    process.env.DSH_CLIENT_COMMIT_HASH = resolveGitCommitForBuild()
  }
}

function ensureTls() {
  if (existsSync(tlsCert) && existsSync(tlsKey)) return
  console.error('缺少 TLS 证书。请先执行: pnpm docker:tls')
  process.exit(1)
}

function printUrls() {
  console.log('')
  console.log('Docker 栈 dsh-work 已启动：')
  console.log('  员工端  https://localhost:4174/workbench')
  console.log('  管理端  https://localhost:4180/overview')
  console.log('  容器    dsh-work-postgres / dsh-work-server / dsh-work-web')
  console.log('  日志    pnpm docker:logs')
}

function main() {
  const command = process.argv[2] ?? 'up'
  if (command !== 'build' && command !== 'tls') {
    ensureStackEnv()
    if (command === 'up' || command === 'up:fg') ensureTls()
  }

  switch (command) {
    case 'up':
      ensureBuildMetadata()
      runDocker([...composeArgs(), 'up', '--build', '-d'], { inherit: true })
      printUrls()
      break
    case 'up:fg':
      ensureBuildMetadata()
      runDocker([...composeArgs(), 'up', '--build'], { inherit: true })
      break
    case 'build':
      ensureBuildMetadata()
      runDocker([...composeArgs(), 'build'], { inherit: true })
      break
    case 'down':
      runDocker([...composeArgs(), 'down'], { inherit: true })
      break
    case 'logs':
      runDocker([...composeArgs(), 'logs', '-f'], { inherit: true })
      break
    case 'ps':
      runDocker([...composeArgs(), 'ps'], { inherit: true })
      break
    case 'init-env':
      if (existsSync(stackEnv)) {
        console.log('stack.env 已存在，未覆盖')
        break
      }
      copyFileSync(stackExample, stackEnv)
      console.log(`已创建 ${stackEnv}，请编辑后执行 pnpm docker:up`)
      break
    default:
      console.error('Usage: node scripts/docker/stack.mjs up|up:fg|build|down|logs|ps|init-env')
      process.exit(1)
  }
}

main()
