import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { stateConflict } from '../../domain/request-errors.ts'
import { AttemptExecutionContainers, assertExclusiveToolScheduling } from './attempt-execution-containers.ts'
import { buildExecutionContainerArguments, EXECUTION_COMMAND_ENV } from './docker-execution-backend.ts'
import { withExecutionContainerOverlay, type DshRuntimeInstallation } from './dsh-runtime-installation.ts'
import {
  EXECUTION_CONTAINER_LIMITS,
  type ContainerCommand,
  type ContainerCommandResult,
  type ExecutionBackend,
  type ExecutionContainerSpec,
} from './execution-backend.ts'
import type { ExecutionTool } from './execution-toolchain.ts'
import { createPlatformToolBridge } from './platform-tool-bridge.ts'
import { createRemoteSubprocessGateway, mapExecutable, type ContainerCommandAudit } from './remote-subprocess-gateway.ts'

const image = `exec@sha256:${'c'.repeat(64)}`
const darwinRg = '/opt/dsh/node_modules/.pnpm/@vscode+ripgrep-darwin-arm64@1.18.0/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'

class FakeExecBackend implements ExecutionBackend {
  readonly started: ExecutionContainerSpec[] = []
  readonly removed: string[] = []
  readonly commands: Array<{ name: string; command: ContainerCommand }> = []
  removeFailures = 0
  startDelayMs = 0
  /** Results of successive quiesce calls; `true` when the list is empty. */
  quiesceResults: boolean[] = []
  readonly quiesced: string[] = []

  async inspectImage() {}
  toolchain: ExecutionTool[] = [{ id: 'bash', version: '5.2.37' }, { id: 'rg', version: '15.0.0' }]
  async inspectExecutionImage() { return this.toolchain }
  async detectFeatures() {}
  async removeOrphans() {}
  startPythonSandbox(): never { throw new Error('not used') }
  async stop() {}

  async startExecutionContainer(spec: ExecutionContainerSpec) {
    this.started.push(spec)
    if (this.startDelayMs) await new Promise(resolve => setTimeout(resolve, this.startDelayMs))
    return { keeperPid: 7 }
  }

  async quiesce(name: string) {
    this.quiesced.push(name)
    return this.quiesceResults.shift() ?? true
  }

  /** Overrides how a command behaves; by default it succeeds at once. */
  execBehavior?: (command: ContainerCommand, signal: AbortSignal) => Promise<ContainerCommandResult>

  async exec(name: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult> {
    this.commands.push({ name, command })
    if (this.execBehavior) return this.execBehavior(command, signal)
    return { exitCode: 0, stdout: `ran ${command.argv[0]}`, stderr: '', truncated: false, timedOut: false }
  }

  async remove(name: string) {
    if (this.removeFailures > 0) {
      this.removeFailures -= 1
      throw stateConflict(`沙箱容器清理失败，容器可能仍在运行：${name}`)
    }
    this.removed.push(name)
  }
}

function command(overrides: Partial<ContainerCommand> = {}): ContainerCommand {
  return { argv: ['rg', '--files'], cwd: '/ws', maxOutputBytes: 1024, timeoutMs: 1000, ...overrides }
}

test('only DSH-bundled ripgrep and bash -c map into the container; anything else is refused', () => {
  assert.equal(mapExecutable([darwinRg, '--files']), 'rg')
  assert.equal(mapExecutable(['/srv/dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg']), 'rg')
  assert.equal(mapExecutable(['/srv/dsh/node_modules/@vscode/ripgrep/bin/rg']), 'rg')
  // dsh-bash-local's only form; the image's bash runs it.
  assert.equal(mapExecutable(['bash', '-c', 'python x.py']), 'bash')
  for (const argv of [['bash'], ['bash', '-c'], ['bash', 'script.sh'], ['bash', '-c', 'x', 'extra'], ['bash', '-lc', 'x'],
    ['/bin/bash', '-c', 'x'], ['/opt/homebrew/bin/bash', '-c', 'x'], ['sh', '-c', 'x'], ['rg'], ['/usr/bin/rg'],
    ['/tmp/@vscode/ripgrep-x/bin/rg-evil'], ['sandbox-exec', '-p', 'x', 'bash', '-c', 'x']]) {
    assert.throws(() => mapExecutable(argv), /不允许运行/, argv.join(' '))
  }
})

test('gateway keeps commands inside the workspace, caps limits and audits every command', async () => {
  const audits: ContainerCommandAudit[] = []
  const ran: ContainerCommand[] = []
  const gateway = createRemoteSubprocessGateway({
    workspace: '/runtime/t/run/attempt/workspace',
    run: async command => { ran.push(command); return { exitCode: 0, stdout: 'a.txt\n', stderr: '', truncated: false, timedOut: false } },
    onCommand: audit => audits.push(audit),
  })
  const signal = new AbortController().signal
  const result = await gateway({
    argv: [darwinRg, '--files', '--glob=*.txt'], cwd: '/runtime/t/run/attempt/workspace/notes',
    maxOutputBytes: 2048, timeoutMs: 999_999_999, env: { DSH_HOME: '/secret' },
  }, signal)
  assert.equal(result.stdout, 'a.txt\n')
  assert.deepEqual(ran[0]!.argv, ['rg', '--files', '--glob=*.txt'])
  assert.equal(ran[0]!.timeoutMs, EXECUTION_CONTAINER_LIMITS.maxCommandMs, 'timeout is capped')
  assert.equal(Object.hasOwn(ran[0]!, 'env'), false, 'no env reaches the container command')
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.executable, 'rg')
  assert.equal(audits[0]!.exitCode, 0)
  assert.equal(audits[0]!.stdoutBytes, 6)
  assert.match(audits[0]!.summary, /^rg --files/)

  for (const cwd of ['/runtime/t/run/attempt/workspace-other', '/runtime/t/run/attempt', '/runtime/t/run/attempt/workspace/../secrets']) {
    await assert.rejects(gateway({ argv: [darwinRg], cwd, maxOutputBytes: 1 }, signal), /工作区内/, cwd)
  }
  await assert.rejects(gateway({ argv: [], cwd: '/runtime/t/run/attempt/workspace', maxOutputBytes: 1 }, signal), /argv/)
  await assert.rejects(gateway({ argv: [darwinRg, 'a\0b'], cwd: '/runtime/t/run/attempt/workspace', maxOutputBytes: 1 }, signal), /argv/)
  await assert.rejects(gateway({ argv: [darwinRg], cwd: 'relative', maxOutputBytes: 1 }, signal), /绝对路径/)
  await assert.rejects(gateway({ argv: [darwinRg], cwd: '/runtime/t/run/attempt/workspace', maxOutputBytes: 0 }, signal), /maxOutputBytes/)
  await gateway({ argv: [darwinRg], cwd: '/runtime/t/run/attempt/workspace', maxOutputBytes: 64 * 1024 * 1024 }, signal)
  assert.equal(ran.at(-1)!.maxOutputBytes, EXECUTION_CONTAINER_LIMITS.maxOutputBytes, 'a larger request is clamped to the platform cap')
  await assert.rejects(gateway({ argv: ['/bin/bash', '-c', 'id'], cwd: '/runtime/t/run/attempt/workspace', maxOutputBytes: 1 }, signal), /不允许运行/)
  assert.equal(ran.length, 2, 'rejected requests never reach the container')
  assert.equal(audits.length, 2, 'rejected requests are not executed and not audited as commands')
})

test('a failing command is still audited', async () => {
  const audits: ContainerCommandAudit[] = []
  const gateway = createRemoteSubprocessGateway({
    workspace: '/ws',
    run: async () => { throw new Error('container gone') },
    onCommand: audit => audits.push(audit),
  })
  await assert.rejects(gateway({ argv: [darwinRg, '--json'], cwd: '/ws', maxOutputBytes: 10 }, new AbortController().signal), /container gone/)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]!.exitCode, null)
})

test('one container per Attempt: created once on first use, removed on release', async () => {
  assert.throws(() => new AttemptExecutionContainers(new FakeExecBackend(), { image: 'exec:latest', user: '501:20' }), /sha256/)
  const backend = new FakeExecBackend()
  backend.startDelayMs = 20
  const containers = new AttemptExecutionContainers(backend, { image, user: '501:20' })
  const signal = new AbortController().signal
  await Promise.all([
    containers.exec('attempt-1', '/ws/a1', command({ cwd: '/ws/a1' }), signal),
    containers.exec('attempt-1', '/ws/a1', command({ cwd: '/ws/a1' }), signal),
    containers.exec('attempt-2', '/ws/a2', command({ cwd: '/ws/a2' }), signal),
  ])
  assert.equal(backend.started.length, 2, 'concurrent first commands share one start')
  assert.deepEqual(backend.started.map(spec => spec.workspace).sort(), ['/ws/a1', '/ws/a2'])
  assert.ok(backend.started.every(spec => /^dsh-exec-[0-9a-f]{16}$/.test(spec.name) && spec.image === image && spec.user === '501:20'))
  await assert.rejects(containers.exec('attempt-1', '/ws/other', command(), signal), /一个工作区/)

  const first = backend.started.find(spec => spec.workspace === '/ws/a1')!.name
  await containers.release('attempt-1')
  assert.deepEqual(backend.removed, [first])
  assert.deepEqual(containers.activeAttempts, ['attempt-2'])
  await containers.release('attempt-never-used')
  assert.equal(backend.removed.length, 1, 'an Attempt that ran no command has nothing to remove')
})

test('a failed removal is retried later for this process only', async () => {
  const backend = new FakeExecBackend()
  const containers = new AttemptExecutionContainers(backend, { image, user: '501:20' })
  await containers.exec('attempt-1', '/ws', command(), new AbortController().signal)
  backend.removeFailures = 2
  await assert.rejects(containers.release('attempt-1'), /清理失败/)
  const name = backend.started[0]!.name
  assert.deepEqual(containers.pendingRemovals, [name])
  await containers.retryRemovals()
  assert.deepEqual(containers.pendingRemovals, [name])
  await containers.retryRemovals()
  assert.deepEqual(containers.pendingRemovals, [])
  assert.deepEqual(backend.removed, [name])
  containers.startMaintenance(60_000)
  containers.close()
})

test('quiescence: rg needs no check; a command that may leave processes is swept, and a dirty container is replaced', async () => {
  const backend = new FakeExecBackend()
  const containers = new AttemptExecutionContainers(backend, { image, user: '501:20' })
  const signal = new AbortController().signal
  await containers.exec('a1', '/ws', command(), signal)
  assert.deepEqual(backend.quiesced, [], 'ripgrep only reads and exits')

  await containers.exec('a1', '/ws', command({ argv: ['bash', '-c', 'x'], mayLeaveProcesses: true }), signal)
  assert.equal(backend.quiesced.length, 1)
  assert.equal(backend.removed.length, 0, 'a clean sweep keeps the container')

  backend.quiesceResults = [false]
  await containers.exec('a1', '/ws', command({ argv: ['bash', '-c', 'x &'], mayLeaveProcesses: true }), signal)
  assert.equal(backend.removed.length, 1, 'not confirmed clean: removed')
  assert.deepEqual(containers.activeAttempts, [], 'no container until the next command')
  await containers.exec('a1', '/ws', command(), signal)
  assert.equal(backend.started.length, 2, 'the next command recreates it')
  assert.equal(await containers.waitUntilIdle('a1', 100), 'idle')
})

test('quiescence: a cancelled command stays busy until cleanup finished, even after the caller gave up', async () => {
  const backend = new FakeExecBackend()
  let finishSweep: (clean: boolean) => void = () => {}
  backend.quiesce = async name => { backend.quiesced.push(name); return new Promise<boolean>(resolve => { finishSweep = resolve }) }
  backend.execBehavior = async (_command, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw new DOMException('Aborted', 'AbortError')
  }
  const containers = new AttemptExecutionContainers(backend, { image, user: '501:20' })
  const controller = new AbortController()
  const pending = containers.exec('a1', '/ws', command(), controller.signal)
  await waitFor(() => backend.commands.length === 1)
  controller.abort()
  await waitFor(() => backend.quiesced.length === 1)
  assert.equal(await containers.waitUntilIdle('a1', 50), 'busy', 'the sweep after a cancel is still running')
  finishSweep(true)
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(await containers.waitUntilIdle('a1', 1000), 'idle')
})

test('quiescence: if even removal fails the Attempt is failed and refuses further commands', async () => {
  const backend = new FakeExecBackend()
  backend.quiesceResults = [false]
  backend.removeFailures = 1
  const containers = new AttemptExecutionContainers(backend, { image, user: '501:20' })
  const signal = new AbortController().signal
  await containers.exec('a1', '/ws', command({ argv: ['bash'], mayLeaveProcesses: true }), signal)
  assert.equal(await containers.waitUntilIdle('a1', 100), 'failed')
  await assert.rejects(containers.exec('a1', '/ws', command(), signal), /无法恢复静止/)
  assert.equal(backend.started.length, 1, 'no new container for a failed Attempt')
  assert.deepEqual(containers.pendingRemovals, [backend.started[0]!.name], 'removal is still retried in the background')
  assert.equal(await containers.waitUntilIdle('other-attempt', 100), 'idle', 'other Attempts are unaffected')
})

test('admission: only plain reads may run alongside other tools; bash and writes must be exclusive', () => {
  // What DSH 0.1.2-rc.1 reports (plan 3.7), including parallel tools the policy never allows.
  const reported = [
    ['read', 'parallel'], ['read_image', 'parallel'], ['web_search', 'parallel'], ['glob', 'exclusive'], ['grep', 'exclusive'],
    ['write', 'exclusive'], ['edit', 'exclusive'], ['str_replace_editor', 'exclusive'], ['todo_write', 'exclusive'],
    ['bash', 'exclusive'], ['web_fetch', 'parallel'], ['subagent', 'parallel'],
  ] as const
  const catalog = reported.map(([id, dshScheduling]) => ({ id, dshScheduling }))
  assertExclusiveToolScheduling(catalog)

  const withMode = (id: string, mode: 'parallel' | 'exclusive' | undefined) =>
    catalog.map(tool => tool.id === id ? { id, ...(mode ? { dshScheduling: mode } : {}) } : tool)
  assert.throws(() => assertExclusiveToolScheduling(withMode('bash', 'parallel')), /静止保证：bash（parallel）/)
  assert.throws(() => assertExclusiveToolScheduling(withMode('write', 'parallel')), /write（parallel）/)
  assert.throws(() => assertExclusiveToolScheduling(withMode('grep', undefined)), /grep（未报告）/, 'an unreported mode fails closed')
  assert.throws(() => assertExclusiveToolScheduling([...catalog, { id: 'python_execute', dshScheduling: 'parallel' as const }]), /python_execute/)
  assertExclusiveToolScheduling(withMode('read', 'exclusive'))
})

test('execution container posture is fixed and mounts the workspace at the same path', () => {
  const args = buildExecutionContainerArguments(
    { name: `dsh-exec-${'ab'.repeat(8)}`, image, user: '501:20', workspace: '/runtime/t/r/a/workspace' },
    { memorySwap: true, apparmor: false },
  )
  const imageIndex = args.indexOf(image)
  assert.deepEqual(args.slice(imageIndex), [image, 'infinity'])
  const options = args.slice(0, imageIndex)
  for (const [flag, value] of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--pull', 'never'], ['--user', '501:20'],
    ['--memory', '1g'], ['--memory-swap', '1g'], ['--pids-limit', '256'], ['--entrypoint', 'sleep'], ['--workdir', '/runtime/t/r/a/workspace'],
    ['--ulimit', `fsize=${256 * 1024 * 1024}:${256 * 1024 * 1024}`]]) {
    assert.equal(options[options.indexOf(flag!) + 1], value, flag)
  }
  for (const flag of ['--read-only', '--init', 'no-new-privileges', 'seccomp=builtin', '-d']) assert.ok(options.includes(flag), flag)
  assert.ok(options.includes('type=bind,src=/runtime/t/r/a/workspace,dst=/runtime/t/r/a/workspace'))
  assert.ok(options.some(value => value.startsWith('/home/exec:') && value.includes('uid=501,gid=20')))
  for (const flag of ['--privileged', '-e', '--env', '--network=host', '-v']) assert.equal(options.includes(flag), false, flag)
  assert.throws(() => buildExecutionContainerArguments({ name: 'other', image, user: '501:20', workspace: '/w' }, { memorySwap: false, apparmor: false }), /名称/)
  assert.throws(() => buildExecutionContainerArguments({ name: `dsh-exec-${'ab'.repeat(8)}`, image, user: '0:0', workspace: '/w' }, { memorySwap: false, apparmor: false }), /非 root/)
  assert.throws(() => buildExecutionContainerArguments({ name: `dsh-exec-${'ab'.repeat(8)}`, image, user: '501:20', workspace: '/a,b' }, { memorySwap: false, apparmor: false }), /工作区/)
  assert.deepEqual(EXECUTION_COMMAND_ENV.map(entry => entry.split('=')[0]), ['LANG', 'PATH', 'HOME', 'TMPDIR'])
})

test('bridge exec endpoint is not a counted tool, re-checks authorization and aborts on disconnect', async () => {
  let authorization: 'allowed' | 'revoked' = 'allowed'
  let seenSignal: AbortSignal | undefined
  let release: () => void = () => {}
  const bridge = await createPlatformToolBridge({}, 0, async () => {
    if (authorization === 'revoked') throw Object.assign(new Error('revoked'), { code: 'permission_denied' })
  }, undefined, undefined, async (body, signal) => {
    seenSignal = signal
    if (body['hang'] === true) await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false }
  })
  try {
    assert.deepEqual(await postJson(bridge.socket, '/subprocess/exec', { argv: ['x'] }), {
      status: 200, body: { exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false },
    }, 'max_tool_calls is 0, yet the exec endpoint still answers')
    assert.deepEqual(bridge.outcomes(), [], 'exec requests are not recorded as tool calls')
    authorization = 'revoked'
    const denied = await postJson(bridge.socket, '/subprocess/exec', {})
    assert.equal(denied.status, 403)
    authorization = 'allowed'
    const pending = postJson(bridge.socket, '/subprocess/exec', { hang: true }, 50)
    await assert.rejects(pending)
    await waitFor(() => seenSignal?.aborted === true)
    release()
  } finally { await bridge.close() }

  const without = await createPlatformToolBridge({}, 1)
  try {
    const refused = await postJson(without.socket, '/subprocess/exec', {})
    assert.equal(refused.status, 403)
  } finally { await without.close() }
})

test('execution container overlay is appended to every DSH process of the installation', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-exec-overlay-'))
  try {
    await mkdir(join(projectRoot, 'server/config/dsh'), { recursive: true })
    const real = resolve(import.meta.dirname, '../../../config/dsh')
    await writeFile(join(projectRoot, 'server/config/dsh/execution-container.cordis.patch.yml'), await readFile(join(real, 'execution-container.cordis.patch.yml')))
    await writeFile(join(projectRoot, 'server/config/dsh/dsh-work-remote-subprocess.js'), await readFile(join(real, 'dsh-work-remote-subprocess.js')))
    const installation = {
      adapter: 'official-acp-profile',
      process: { command: 'node', args: ['apps/cli/src/bin.ts', '--profile', 'acp', '--patch', '/base.yml'], cwd: '/dsh' },
    } as DshRuntimeInstallation
    const patched = await withExecutionContainerOverlay(installation, { projectRoot, env: { DSH_WORK_DATA_ROOT: 'data' } })
    const overlay = join(projectRoot, 'data/dsh-config/execution-container.cordis.patch.yml')
    assert.deepEqual(patched.process.args.slice(-2), ['--patch', overlay])
    assert.deepEqual(patched.process.args.slice(0, 5), installation.process.args, 'the deployment patch stays first')
    const text = await readFile(overlay, 'utf8')
    assert.doesNotMatch(text, /__DSH_WORK_REMOTE_SUBPROCESS_MODULE__/)
    assert.match(text, new RegExp(JSON.stringify(join(projectRoot, 'server/config/dsh/dsh-work-remote-subprocess.js')).replaceAll('/', '\\/')))
    // Stage 2: bash runs unwrapped in the container (bash-local), so the host sandbox wrapper and
    // the permission presets that refuse an unwrapped executor are off; no background jobs.
    for (const disabled of ['subprocess', 'tool-jobs', 'bash-sandbox', 'permission']) assert.match(text, new RegExp(`- id: ${disabled}\\n  disabled: true`))
    assert.match(text, /enableRunInBackground: false/)
    assert.match(text, /- id: bash-local\n\s+name: '@deepseek-ai\/dsh-bash-local'/)
    assert.match(text, /maxTimeoutMs: 600000/)
    assert.doesNotMatch(text, /- id: (fs-sandbox|sandbox-policy|sandbox|approval)\n\s+disabled: true/, 'the file fence and approval stay on')
    await assert.rejects(withExecutionContainerOverlay({ ...installation, adapter: 'legacy-acp-demo' } as DshRuntimeInstallation, { projectRoot }), /官方 acp Profile/)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

const dockerTarget = realDockerTarget()

test('real docker: commands run as the service user at the host path, and timeout or abort kill the whole process group', { skip: dockerTarget.skip, timeout: 120_000 }, async () => {
  const { DockerExecutionBackend } = await import('./docker-execution-backend.ts')
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-exec-real-'))
  const backend = new DockerExecutionBackend()
  const user = `${process.getuid?.()}:${process.getgid?.()}`
  const name = `dsh-exec-${'5a'.repeat(8)}`
  await backend.remove(name).catch(() => undefined)
  try {
    await backend.detectFeatures()
    await backend.startExecutionContainer({ name, image: dockerTarget.image!, user, workspace })
    const signal = new AbortController().signal
    const basic = await backend.exec(name, {
      argv: ['sh', '-c', 'id -u; pwd; echo hello > out.txt; printenv | cut -d= -f1 | sort | tr "\\n" " "'],
      cwd: workspace, maxOutputBytes: 4096, timeoutMs: 10_000,
    }, signal)
    const [uid, cwd, envKeys] = basic.stdout.trim().split('\n')
    assert.equal(basic.exitCode, 0)
    assert.equal(uid, String(process.getuid?.()))
    assert.equal(cwd, workspace, 'the workspace is mounted at the same absolute path')
    assert.equal(await readFile(join(workspace, 'out.txt'), 'utf8'), 'hello\n', 'writes land in the host workspace')
    assert.doesNotMatch(envKeys ?? '', /DSH_|DOCKER_/)

    const capped = await backend.exec(name, { argv: ['sh', '-c', 'head -c 5000 /dev/zero'], cwd: workspace, maxOutputBytes: 100, timeoutMs: 10_000 }, signal)
    assert.equal(capped.stdout.length, 100)
    assert.equal(capped.truncated, true)

    // A background child would survive if only the exec client were killed.
    const timedOut = await backend.exec(name, { argv: ['sh', '-c', 'sleep 300 & sleep 300'], cwd: workspace, maxOutputBytes: 1024, timeoutMs: 500 }, signal)
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.exitCode, null)
    assert.equal(await sleepersIn(backend, name, workspace), 0, 'timeout killed the whole process group')

    const controller = new AbortController()
    const pending = backend.exec(name, { argv: ['sh', '-c', 'sleep 300 & sleep 300'], cwd: workspace, maxOutputBytes: 1024, timeoutMs: 60_000 }, controller.signal)
    setTimeout(() => controller.abort(), 300)
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    assert.equal(await sleepersIn(backend, name, workspace), 0, 'abort killed the whole process group')
  } finally {
    await backend.remove(name).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('real docker: the quiescence sweep clears leftover processes and reports fork pressure as not clean', { skip: dockerTarget.skip, timeout: 120_000 }, async () => {
  const { DockerExecutionBackend } = await import('./docker-execution-backend.ts')
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-exec-quiesce-'))
  const backend = new DockerExecutionBackend()
  const user = `${process.getuid?.()}:${process.getgid?.()}`
  const name = `dsh-exec-${'6b'.repeat(8)}`
  await backend.remove(name).catch(() => undefined)
  const run = (cmd: string) => backend.exec(name, { argv: ['sh', '-c', cmd], cwd: workspace, maxOutputBytes: 4096, timeoutMs: 10_000 }, new AbortController().signal)
  // Count through a plain `docker exec` (no wrapper or watchdog), like the sweep itself runs.
  const others = async (keeper: number) => Number(spawnSync('docker', ['exec', name, 'sh', '-c',
    'k="$1"; n=0; for d in /proc/[0-9]*; do p=${d#/proc/}; case "$p" in 1|"$k"|$$) continue;; esac; read -r s < "$d/stat" 2>/dev/null || continue; set -- ${s##*) }; case "$1" in Z|X) continue;; esac; [ "$2" = "$$" ] && continue; n=$((n+1)); done; echo $n',
    'dsh-count', String(keeper)], { encoding: 'utf8' }).stdout.trim())
  try {
    await backend.detectFeatures()
    let { keeperPid } = await backend.startExecutionContainer({ name, image: dockerTarget.image!, user, workspace })
    let keeper = keeperPid
    assert.ok(keeperPid > 1)
    await run('sleep 300 & setsid sh -c "sleep 301" </dev/null >/dev/null 2>&1 & nohup sh -c "while true; do sleep 1; done" >/dev/null 2>&1 &')
    assert.ok(await others(keeperPid) >= 3, 'leftover processes outlive the command')
    assert.equal(await backend.quiesce(name, keeperPid), true)
    assert.equal(await others(keeperPid), 0, 'the sweep left only PID 1 and the keeper')
    assert.equal((await run('echo alive')).stdout.trim(), 'alive', 'the container is still usable')

    // Fork pressure: "clean" may only be reported when nothing is left; otherwise false (the caller then removes the container).
    for (const settleMs of [0, 1500]) {
      await run('(while true; do sleep 5 & done) >/dev/null 2>&1 &').catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, settleMs))
      const clean = await backend.quiesce(name, keeperPid)
      if (clean) assert.equal(await others(keeperPid), 0, `reported clean after ${settleMs} ms of fork pressure, so nothing may be left`)
      else {
        await backend.remove(name)
        const restarted = await backend.startExecutionContainer({ name, image: dockerTarget.image!, user, workspace })
        keeper = restarted.keeperPid
      }
      keeperPid = keeper
    }
  } finally {
    await backend.remove(name).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
})

async function sleepersIn(backend: { exec: ExecutionBackend['exec'] }, name: string, cwd: string): Promise<number> {
  const listed = await backend.exec(name, {
    argv: ['sh', '-c', 'for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f" 2>/dev/null; echo; done | grep -c "^sleep 300" || true'],
    cwd, maxOutputBytes: 1024, timeoutMs: 10_000,
  }, new AbortController().signal)
  return Number(listed.stdout.trim())
}

function realDockerTarget(): { skip: string | false; image?: string } {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5_000 })
  if (info.error || info.status !== 0) return { skip: 'Docker is not available' }
  const digests = spawnSync('docker', ['image', 'inspect', 'python:3.12-slim', '--format', '{{json .RepoDigests}}'], { encoding: 'utf8', timeout: 15_000 })
  if (digests.status !== 0) return { skip: 'python:3.12-slim is not present locally' }
  const digest = (JSON.parse(digests.stdout) as string[]).find(value => /@sha256:[a-f0-9]{64}$/.test(value))
  return digest ? { skip: false, image: digest } : { skip: 'python:3.12-slim has no repo digest to pin' }
}

function postJson(socketPath: string, path: string, body: unknown, destroyAfterMs?: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : undefined }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
    if (destroyAfterMs !== undefined) setTimeout(() => req.destroy(new Error('client went away')), destroyAfterMs)
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
