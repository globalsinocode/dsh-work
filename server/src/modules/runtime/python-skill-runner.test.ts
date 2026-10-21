import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  boundedUtf8Collector,
  buildPythonSandboxArguments,
  createPythonContainerName,
  listArtifacts,
  PYTHON_SANDBOX_LIMITS,
  pythonMountReadable,
  PythonSkillRunner,
  resolvePythonSandboxUser,
  type PythonSandboxArgumentOptions,
} from './python-skill-runner.ts'
import type { RuntimeManifest } from './runtime-types.ts'

const image = `python@sha256:${'a'.repeat(64)}`

function argumentOptions(overrides: Partial<PythonSandboxArgumentOptions> = {}): PythonSandboxArgumentOptions {
  return {
    name: `dsh-py-${'ab'.repeat(8)}`,
    user: '65534:65534',
    memorySwap: false,
    apparmor: false,
    ...overrides,
  }
}

test('Python Skill runner requires a digest-pinned image and builds a closed sandbox command', () => {
  assert.throws(() => new PythonSkillRunner('python:3.13'), /sha256/)
  assert.equal(new PythonSkillRunner(image).user, `${process.getuid?.()}:${process.getgid?.()}`)
  assert.throws(() => resolvePythonSandboxUser('0:0'), /uid:gid/)
  assert.throws(() => resolvePythonSandboxUser('root'), /uid:gid/)
  assert.equal(resolvePythonSandboxUser('65534:65534'), '65534:65534')
  const args = buildPythonSandboxArguments(image, '/runtime/skill', '/runtime/input', '/runtime/output', 'scripts/check.py', ['value'], argumentOptions())
  const imageIndex = args.indexOf(image)
  assert.deepEqual(args.slice(imageIndex), [image, 'python', '-I', '-B', 'scripts/check.py', 'value'])
  const options = args.slice(0, imageIndex)
  for (const flag of ['--env', '-e', '--privileged', '--network=host']) assert.equal(options.includes(flag), false)
  assert.deepEqual(options.slice(0, 8), ['run', '--rm', '--name', `dsh-py-${'ab'.repeat(8)}`, '--label', 'dsh-work.python-sandbox=1', '--init', '--pull'])
  assert.equal(options[options.indexOf('--pull') + 1], 'never')
  assert.ok(options.includes('--network') && options[options.indexOf('--network') + 1] === 'none')
  assert.ok(options.includes('--read-only'))
  assert.ok(options.includes('--cap-drop') && options[options.indexOf('--cap-drop') + 1] === 'ALL')
  assert.ok(options.includes('no-new-privileges'))
  assert.ok(options.includes('seccomp=builtin'))
  assert.equal(options.includes('apparmor=docker-default'), false)
  assert.equal(options.includes('--memory-swap'), false)
  assert.equal(options[options.indexOf('--user') + 1], '65534:65534')
  assert.equal(options[options.indexOf('--shm-size') + 1], PYTHON_SANDBOX_LIMITS.shmSize)
  assert.equal(options[options.indexOf('--memory') + 1], '256m')
  assert.equal(options[options.indexOf('--cpus') + 1], '0.5')
  assert.equal(options[options.indexOf('--pids-limit') + 1], '64')
  assert.equal(options[options.indexOf('--stop-timeout') + 1], '2')
  assert.equal(options[options.indexOf('--tmpfs') + 1], '/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777')
  assert.ok(options.includes('type=bind,src=/runtime/skill,dst=/skill,readonly'))
  assert.ok(options.includes('type=bind,src=/runtime/input,dst=/input,readonly'))
  assert.ok(options.includes('type=bind,src=/runtime/output,dst=/output'))
  assert.ok(options.indexOf('--ulimit') < imageIndex)
})

test('sandbox pins optional swap and apparmor only when the daemon supports them', () => {
  const args = buildPythonSandboxArguments(image, '/s', '/i', '/o', 'run.py', [], argumentOptions({ memorySwap: true, apparmor: true }))
  const imageIndex = args.indexOf(image)
  const options = args.slice(0, imageIndex)
  assert.equal(options[options.indexOf('--memory') + 1], '256m')
  assert.equal(options[options.indexOf('--memory-swap') + 1], '256m')
  assert.ok(options.includes('apparmor=docker-default'))
  assert.ok(options.includes('seccomp=builtin'))
})

test('sandbox caps each file one byte above the collected maximum', () => {
  const args = buildPythonSandboxArguments(image, '/s', '/i', '/o', 'run.py', [], argumentOptions())
  const index = args.indexOf('--ulimit')
  const limit = PYTHON_SANDBOX_LIMITS.maxArtifactBytes + 1
  assert.equal(args[index + 1], `fsize=${limit}:${limit}`)
  assert.ok(index < args.indexOf(image))
  assert.match(createPythonContainerName(), /^dsh-py-[0-9a-f]{16}$/)
  assert.throws(() => buildPythonSandboxArguments(image, '/tmp/a,b', '/i', '/o', 'run.py', [], argumentOptions()), /挂载路径/)
})

test('captured output keeps UTF-8 split across chunks and truncates by bytes without a broken character', () => {
  const bytes = Buffer.from('生产计划')
  const split = boundedUtf8Collector()
  split.write(bytes.subarray(0, 4))
  split.write(bytes.subarray(4))
  assert.equal(split.text(), '生产计划')
  const limited = boundedUtf8Collector(7)
  limited.write(bytes)
  limited.write(Buffer.from('ignored after the limit'))
  assert.equal(limited.text(), '生产', '7 bytes hold two 3-byte characters; the cut third is dropped')
})

test('output collection drops truncated, excess, unsafe and uncollected files', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-py-out-'))
  try {
    const root = join(parent, 'output')
    const outside = join(parent, 'secret.txt')
    await mkdir(root)
    await writeFile(outside, 'secret')
    await symlink(outside, join(root, 'linked'))
    await writeFile(join(root, 'has space.txt'), 'nope')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'inner.txt'), 'x')
    await writeFile(join(root, 'keep.txt'), 'ok')
    await writeFile(join(root, 'exact.bin'), '')
    await truncate(join(root, 'exact.bin'), PYTHON_SANDBOX_LIMITS.maxArtifactBytes)
    await writeFile(join(root, 'truncated.bin'), '')
    await truncate(join(root, 'truncated.bin'), PYTHON_SANDBOX_LIMITS.maxArtifactBytes + 1)
    for (const name of ['m0.bin', 'm1.bin', 'm2.bin']) {
      await writeFile(join(root, name), '')
      await truncate(join(root, name), 9 * 1024 * 1024)
    }
    const collected = await listArtifacts(root)
    assert.equal(collected.dropped, true)
    assert.deepEqual(collected.artifacts.map(artifact => artifact.name), ['exact.bin', 'keep.txt', 'm0.bin'])
    assert.deepEqual((await readdir(root)).sort(), ['exact.bin', 'keep.txt', 'm0.bin'])
    assert.equal(await readFile(outside, 'utf8'), 'secret')

    const counted = join(parent, 'counted')
    await mkdir(counted)
    for (let index = 0; index < PYTHON_SANDBOX_LIMITS.maxArtifactFiles + 1; index += 1) {
      await writeFile(join(counted, `n${String(index).padStart(2, '0')}.txt`), 'x')
    }
    const limited = await listArtifacts(counted)
    assert.equal(limited.artifacts.length, PYTHON_SANDBOX_LIMITS.maxArtifactFiles)
    assert.equal(limited.dropped, true)
    assert.equal((await readdir(counted)).length, PYTHON_SANDBOX_LIMITS.maxArtifactFiles)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('mount readability follows the sandbox uid and does not follow links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-mount-'))
  try {
    await writeFile(join(root, 'run.py'), 'print(1)\n', { mode: 0o400 })
    await chmod(join(root, 'run.py'), 0o400)
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    assert.equal(await pythonMountReadable(root, uid, gid), true)
    assert.equal(await pythonMountReadable(root, 65534, 65534), false)
    await symlink(join(root, 'run.py'), join(root, 'alias.py'))
    await assert.rejects(pythonMountReadable(root, uid, gid), /符号链接/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('abort stops the mock container before the call settles and a failed removal is reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-mock-'))
  const script = join(root, 'docker.mjs')
  await writeFile(script, mockDocker, { mode: 0o755 })
  await chmod(script, 0o755)
  await writeFile(join(root, 'info.out'), 'true\n["name=apparmor"]\n')
  const previous = process.env.DSH_PY_SANDBOX_SENTINEL
  process.env.DSH_PY_SANDBOX_SENTINEL = 'sentinel'
  const user = `${process.getuid?.()}:${process.getgid?.()}`
  const runner = new PythonSkillRunner(image, { command: script, user })
  try {
    await runner.preflight()
    const planted = `dsh-py-${'cd'.repeat(8)}`
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state', planted), 'up')
    await runner.preflight()
    const swept = await readCalls(root)
    assert.ok(swept.some(call => call.args[0] === 'rm' && call.args.includes(planted)))
    assert.deepEqual(await readdir(join(root, 'state')).catch(() => []), [])

    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    const ok = await runner.execute({ skill: 'demo', entry: 'ok.py' }, manifest('ok.py'), workspace, new AbortController().signal)
    assert.equal(ok.exitCode, 0)
    const runCall = (await readCalls(root)).find(call => call.args[0] === 'run' && call.args.at(-1) === 'ok.py')
    assert.ok(runCall)
    assert.equal(runCall.sentinel, false)
    assert.equal(runCall.hasPath, true)
    assert.ok(runCall.args.includes('seccomp=builtin'))
    assert.ok(runCall.args.includes('apparmor=docker-default'))
    assert.ok(runCall.args.includes('--memory-swap'))
    assert.ok(runCall.args.includes('--init'))
    assert.equal(runCall.args.includes('-e'), false)
    assert.equal(runCall.args[runCall.args.indexOf('--user') + 1], user)

    const controller = new AbortController()
    const pending = runner.execute({ skill: 'demo', entry: 'abort.py' }, manifest('abort.py'), workspace, controller.signal)
    const leak = join(workspace, 'python-output', segment('demo'), 'leak.bin')
    await waitForFile(leak)
    const beforeAbort = Date.now()
    controller.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    const settledAt = Date.now()
    const abortLog = await readCalls(root)
    const stop = abortLog.find(call => call.args[0] === 'stop' && call.t >= beforeAbort)
    const removed = abortLog.find(call => call.args[0] === 'rm' && call.t >= beforeAbort)
    assert.ok(stop && stop.args[1] === '-t' && stop.args[2] === '2')
    assert.ok(removed && removed.args.includes('-f'))
    assert.ok(settledAt >= (removed?.t ?? 0))
    await new Promise(resolve => setTimeout(resolve, 200))
    const stamps = (await readFile(leak, 'utf8')).trim().split('\n').map(Number)
    assert.ok(stamps.every(stamp => stamp <= settledAt))

    const failing = new AbortController()
    const cleanup = runner.execute({ skill: 'demo', entry: 'failclean.py' }, manifest('failclean.py'), workspace, failing.signal)
    await waitFor(() => existsCall(root, 'failclean.py'))
    failing.abort()
    await assert.rejects(cleanup, /清理失败/)

    const quotaController = new AbortController()
    const quotaPending = runner.execute({ skill: 'demo', entry: 'quota.py' }, manifest('quota.py'), workspace, quotaController.signal)
    try {
      const quota = await Promise.race([
        quotaPending,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('quota stop timed out')), 5_000)),
      ])
      assert.notEqual(quota.exitCode, 0)
      assert.match(quota.stderr, /执行已停止/)
      assert.ok(quota.artifacts.length <= PYTHON_SANDBOX_LIMITS.maxArtifactFiles)
      const left = await readdir(join(workspace, 'python-output', segment('demo')))
      assert.ok(left.length <= PYTHON_SANDBOX_LIMITS.maxArtifactFiles)
    } finally {
      quotaController.abort()
      await quotaPending.catch(() => undefined)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PY_SANDBOX_SENTINEL
    else process.env.DSH_PY_SANDBOX_SENTINEL = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a non-root service rejects a sandbox uid other than its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-user-'))
  try {
    const runner = new PythonSkillRunner(image, { command: join(root, 'missing-docker'), user: '65534:65534' })
    const workspace = join(root, 'ws')
    const skillRoot = join(workspace, 'skills', segment('demo'))
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(join(skillRoot, 'scripts', 'ok.py'), 'print(1)\n', { mode: 0o400 })
    await assert.rejects(
      runner.execute({ skill: 'demo', entry: 'scripts/ok.py' }, manifest('scripts/ok.py'), workspace, new AbortController().signal),
      /服务进程用户不一致/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const dockerIntegration = dockerIntegrationTarget()

test('docker abort removes the sandbox container and stops host writes', { skip: dockerIntegration.skip, timeout: 60_000 }, async () => {
  const imageRef = dockerIntegration.image
  assert.ok(imageRef)
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-docker-'))
  const before = new Set(sandboxContainers())
  const controller = new AbortController()
  try {
    const workspace = join(root, 'ws')
    const skillRoot = join(workspace, 'skills', segment('demo'))
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(join(skillRoot, 'scripts', 'ignore_term.py'), [
      'import os, signal, tempfile, time, pathlib',
      'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
      'tempfile.mkstemp(prefix="sandbox-")',
      'pathlib.Path("/output/uid.txt").write_text(str(os.getuid()))',
      'leak = pathlib.Path("/output/leak.bin")',
      'while True:',
      '    leak.write_bytes((leak.read_bytes() if leak.exists() else b"") + b"x")',
      '    time.sleep(0.05)',
      '',
    ].join('\n'), { mode: 0o644 })
    const runner = new PythonSkillRunner(imageRef)
    await runner.preflight()
    const pending = runner.execute(
      { skill: 'demo', entry: 'scripts/ignore_term.py' },
      manifest('scripts/ignore_term.py'),
      workspace,
      controller.signal,
    )
    const uidFile = join(workspace, 'python-output', segment('demo'), 'uid.txt')
    const leak = join(workspace, 'python-output', segment('demo'), 'leak.bin')
    await waitForFile(uidFile)
    const uidText = (await readFile(uidFile, 'utf8')).trim()
    assert.notEqual(uidText, '0')
    assert.equal(uidText, String(process.getuid?.()))
    assert.equal((await lstat(uidFile)).uid, process.getuid?.())
    controller.abort()
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    const settled = (await lstat(leak)).size
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal((await lstat(leak)).size, settled)
    const leaked = sandboxContainers().filter(name => !before.has(name))
    assert.deepEqual(leaked, [])
  } finally {
    controller.abort()
    const leaked = sandboxContainers().filter(name => !before.has(name))
    if (leaked.length) spawnSync('docker', ['rm', '-f', ...leaked], { timeout: 15_000 })
    await rm(root, { recursive: true, force: true })
  }
})

const mockDocker = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const log = join(root, 'calls.ndjson')
appendFileSync(log, JSON.stringify({
  t: Date.now(),
  args,
  sentinel: Object.prototype.hasOwnProperty.call(process.env, 'DSH_PY_SANDBOX_SENTINEL'),
  hasPath: Boolean(process.env.PATH),
}) + '\\n')
const state = join(root, 'state')
if (args[0] === 'info') {
  process.stdout.write(existsSync(join(root, 'info.out')) ? readFileSync(join(root, 'info.out')) : 'false\\n[]\\n')
  process.exit(0)
}
if (args[0] === 'image') process.exit(0)
if (args[0] === 'ps') {
  const names = existsSync(state) ? readdirSync(state) : []
  process.stdout.write(names.filter(name => /^dsh-py-[0-9a-f]{16}$/.test(name)).join('\\n'))
  process.exit(0)
}
if (args[0] === 'stop') process.exit(0)
if (args[0] === 'rm') {
  const mode = existsSync(join(root, 'mode')) ? readFileSync(join(root, 'mode'), 'utf8').trim() : ''
  if (mode === 'failclean.py') {
    process.stderr.write('Error: removal failed\\n')
    process.exit(1)
  }
  for (const name of args) if (name.startsWith('dsh-py-')) rmSync(join(state, name), { force: true })
  process.exit(0)
}
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1]
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, name), 'up')
  const entry = args.at(-1) ?? ''
  writeFileSync(join(root, 'mode'), entry)
  const output = mountSrc(args, '/output')
  if (entry === 'ok.py') process.exit(0)
  if (entry === 'quota.py' && output) {
    for (let index = 0; index < 21; index += 1) writeFileSync(join(output, 'f' + String(index).padStart(2, '0') + '.txt'), 'x')
  }
  if (entry === 'abort.py' && output) {
    const leak = join(output, 'leak.bin')
    setInterval(() => appendFileSync(leak, String(Date.now()) + '\\n'), 30)
  }
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
}
function mountSrc(argv, dst) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--mount') continue
    const value = argv[index + 1] ?? ''
    if (!value.includes('dst=' + dst)) continue
    return value.match(/src=([^,]+)/)?.[1]
  }
}
`

interface MockCall { t: number; args: string[]; sentinel: boolean; hasPath: boolean }

async function readCalls(root: string): Promise<MockCall[]> {
  const text = await readFile(join(root, 'calls.ndjson'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as MockCall)
}

async function existsCall(root: string, entry: string): Promise<boolean> {
  const calls = await readCalls(root)
  return calls.some(call => call.args[0] === 'run' && call.args.at(-1) === entry)
}

function manifest(entry: string): RuntimeManifest {
  return {
    agent_configuration: {
      skill_instructions: [{
        id: 'demo',
        version: '1',
        files: [{ path: entry, sha256: 'ab', size: 1 }],
      }],
    },
  } as RuntimeManifest
}

function segment(id: string): string {
  const readable = id.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return `${readable}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      if ((await lstat(path)).isFile()) return
    } catch { /* not created yet */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition was not reached')
}

function sandboxContainers(): string[] {
  const listed = spawnSync('docker', ['ps', '-aq', '--filter', 'name=dsh-py-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (listed.status !== 0) return []
  return listed.stdout.split('\n').map(name => name.trim()).filter(name => /^dsh-py-[0-9a-f]{16}$/.test(name))
}

function dockerIntegrationTarget(): { skip: string | false; image?: string } {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5_000 })
  if (info.error || info.status !== 0) return { skip: 'Docker is not available' }
  const configured = process.env.DSH_WORK_PYTHON_IMAGE?.trim()
  if (configured && /^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(configured)) {
    const inspect = spawnSync('docker', ['image', 'inspect', configured], { encoding: 'utf8', timeout: 15_000 })
    if (inspect.status === 0) return { skip: false, image: configured }
    return { skip: 'DSH_WORK_PYTHON_IMAGE is not present locally' }
  }
  const digests = spawnSync('docker', ['image', 'inspect', 'python:3.12-slim', '--format', '{{json .RepoDigests}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (digests.status !== 0) return { skip: 'python:3.12-slim is not present locally' }
  try {
    const parsed = JSON.parse(digests.stdout) as unknown
    const digest = Array.isArray(parsed) ? parsed.find(value => typeof value === 'string' && /@sha256:[a-f0-9]{64}$/.test(value)) : undefined
    if (typeof digest === 'string') return { skip: false, image: digest }
  } catch { /* fall through */ }
  return { skip: 'python:3.12-slim has no repo digest to pin' }
}
