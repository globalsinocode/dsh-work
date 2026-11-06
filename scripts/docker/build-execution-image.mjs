#!/usr/bin/env node
/**
 * Build deploy/execution-image for this machine (amd64 on Windows/Linux, arm64 on Mac)
 * and print DSH_WORK_EXECUTION_IMAGE for .env / deploy/docker/stack.env.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tag = 'dsh-work/execution:local'
const context = resolve(projectRoot, 'deploy/execution-image')

function run(args, { capture = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return capture ? (result.stdout ?? '').trim() : ''
}

console.log('Building execution image（LibreOffice 等，首次约 10–30 分钟）…')
run(['build', '-t', tag, context])

const id = run(['inspect', '-f', '{{.Id}}', tag], { capture: true })
if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
  console.error('Unexpected image id:', id)
  process.exit(1)
}

const line = `DSH_WORK_EXECUTION_IMAGE=dsh-work/execution@${id}`
console.log('')
console.log('写入 .env 与 deploy/docker/stack.env：')
console.log(line)
console.log('')
console.log('GHCR 上的镜像为 arm64，Windows/amd64 请用上面这行。localhost:5000 需本地 registry 在跑，否则会 pull 超时。')
