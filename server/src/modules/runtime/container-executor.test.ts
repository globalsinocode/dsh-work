import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stateConflict } from '../../domain/request-errors.ts'
import { ContainerExecutor, DEFAULT_MAX_CONTAINERS, ExecutionSlots, parseMaxContainers, type PythonSandboxRequest } from './container-executor.ts'
import type { ContainerCommandResult, ExecutionBackend, PythonSandboxSpec, RunningSandbox } from './execution-backend.ts'

const image = `python@sha256:${'b'.repeat(64)}`

/** In-memory backend: containers "run" until the test exits them or `stop` is called. */
class FakeBackend implements ExecutionBackend {
  readonly started: PythonSandboxSpec[] = []
  readonly removed: string[] = []
  removeFailures = 0
  private readonly exits = new Map<string, (code: number) => void>()

  async inspectImage() {}
  async inspectExecutionImage() { return [] }
  async detectFeatures() {}
  async removeOrphans() {}
  async startExecutionContainer(): Promise<{ keeperPid: number }> { throw new Error('not used by these tests') }
  async quiesce() { return true }
  async exec(): Promise<ContainerCommandResult> { throw new Error('not used by these tests') }

  startPythonSandbox(spec: PythonSandboxSpec): RunningSandbox {
    this.started.push(spec)
    let alive = true
    let settle!: (code: number) => void
    const exited = new Promise<number>(resolve => { settle = resolve })
    const exit = (code: number) => {
      if (!alive) return
      alive = false
      settle(code)
    }
    this.exits.set(spec.name, exit)
    return { exited, stdout: () => 'out', stderr: () => '', alive: () => alive, kill: () => exit(137) }
  }

  async stop(name: string) { this.exits.get(name)?.(137) }

  async remove(name: string) {
    if (this.removeFailures > 0) {
      this.removeFailures -= 1
      throw stateConflict(`Python 沙箱容器清理失败，容器可能仍在运行：${name}`)
    }
    this.removed.push(name)
  }

  exit(index: number, code: number) {
    const spec = this.started[index]
    assert.ok(spec, `container ${index} was not started`)
    this.exits.get(spec.name)?.(code)
  }
}

function request(overrides: Partial<PythonSandboxRequest> = {}): PythonSandboxRequest {
  return { user: '1000:1000', skillRoot: '/s', inputRoot: '/i', outputRoot: '/o', entry: 'run.py', args: [], ...overrides }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('max containers defaults to 4 and rejects malformed values instead of falling back', () => {
  assert.equal(parseMaxContainers(undefined), DEFAULT_MAX_CONTAINERS)
  assert.equal(parseMaxContainers('  '), DEFAULT_MAX_CONTAINERS)
  assert.equal(parseMaxContainers('8'), 8)
  for (const value of ['0', '65', 'abc', '1.5', '-1', '4 containers', '0x4']) {
    assert.throws(() => parseMaxContainers(value), /DSH_WORK_EXECUTION_MAX_CONTAINERS/, value)
  }
})

test('slots queue in order, hand off on release, and an aborted wait leaves no trace', async () => {
  const slots = new ExecutionSlots(1)
  const first = await slots.acquire(new AbortController().signal)
  assert.equal(slots.inUse, 1)

  const abandoned = new AbortController()
  const waiting = slots.acquire(abandoned.signal)
  const second = slots.acquire(new AbortController().signal)
  assert.equal(slots.waiting, 2)
  abandoned.abort()
  await assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(slots.waiting, 1)

  first()
  first()
  const releaseSecond = await second
  assert.equal(slots.inUse, 1, 'the slot moved to the next waiter instead of being freed')
  releaseSecond()
  assert.equal(slots.inUse, 0)

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(slots.acquire(aborted.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(slots.inUse, 0)
  assert.throws(() => new ExecutionSlots(0), /并发上限/)
})

test('executor runs only the configured digest-pinned image and frees the slot after removal', async () => {
  assert.throws(() => new ContainerExecutor(new FakeBackend(), { pythonImage: 'python:3.13' }), /sha256/)
  const backend = new FakeBackend()
  const executor = new ContainerExecutor(backend, { pythonImage: image, maxContainers: 1 })
  const pending = executor.runPythonSandbox(request({ args: ['a'] }), new AbortController().signal)
  await until(() => backend.started.length === 1)
  assert.equal(executor.containersInUse, 1)
  backend.exit(0, 0)
  const result = await pending
  assert.deepEqual(result, { exitCode: 0, stdout: 'out', stderr: '', stoppedEarly: false })
  const spec = backend.started[0]!
  assert.equal(spec.image, image)
  assert.match(spec.name, /^dsh-py-[0-9a-f]{16}$/)
  assert.deepEqual(backend.removed, [spec.name])
  assert.equal(executor.containersInUse, 0)
})

test('a wait aborted while every slot is busy never starts a container', async () => {
  const backend = new FakeBackend()
  const executor = new ContainerExecutor(backend, { pythonImage: image, maxContainers: 1 })
  const busy = executor.runPythonSandbox(request(), new AbortController().signal)
  await until(() => backend.started.length === 1)
  const controller = new AbortController()
  const queued = executor.runPythonSandbox(request(), controller.signal)
  controller.abort()
  await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  assert.equal(backend.started.length, 1)
  backend.exit(0, 0)
  await busy
  assert.equal(executor.containersInUse, 0)
})

test('shouldStop stops the container early and reports it', async () => {
  const backend = new FakeBackend()
  const executor = new ContainerExecutor(backend, { pythonImage: image })
  const result = await executor.runPythonSandbox(request({ shouldStop: async () => true }), new AbortController().signal)
  assert.equal(result.stoppedEarly, true)
  assert.equal(result.exitCode, 137)
  assert.equal(backend.removed.length, 1)
  assert.equal(executor.containersInUse, 0)
})

test('a failed removal keeps the slot reserved until a retry removes the container', async () => {
  const backend = new FakeBackend()
  const executor = new ContainerExecutor(backend, { pythonImage: image, maxContainers: 1 })
  backend.removeFailures = 2
  const controller = new AbortController()
  const pending = executor.runPythonSandbox(request(), controller.signal)
  await until(() => backend.started.length === 1)
  controller.abort()
  await assert.rejects(pending, /清理失败/)
  const name = backend.started[0]!.name
  assert.deepEqual(executor.pendingRemovals, [name])
  assert.equal(executor.containersInUse, 1, 'a container that may still exist still counts')

  const next = executor.runPythonSandbox(request(), new AbortController().signal)
  await executor.retryRemovals()
  assert.deepEqual(executor.pendingRemovals, [name], 'still failing: keep retrying later')
  assert.equal(backend.started.length, 1)

  await executor.retryRemovals()
  assert.deepEqual(executor.pendingRemovals, [])
  assert.deepEqual(backend.removed, [name])
  await until(() => backend.started.length === 2)
  backend.exit(1, 0)
  await next
  assert.equal(executor.containersInUse, 0)
})

test('a backend error before the container exists releases the slot', async () => {
  const backend = new FakeBackend()
  backend.startPythonSandbox = () => { throw new Error('invalid mount') }
  const executor = new ContainerExecutor(backend, { pythonImage: image, maxContainers: 1 })
  await assert.rejects(executor.runPythonSandbox(request(), new AbortController().signal), /invalid mount/)
  assert.equal(executor.containersInUse, 0)
  assert.deepEqual(executor.pendingRemovals, [])
})

test('maintenance timer does not keep the process alive and close stops it', () => {
  const executor = new ContainerExecutor(new FakeBackend(), { pythonImage: image })
  executor.startMaintenance(60_000)
  executor.startMaintenance(60_000)
  executor.close()
  executor.close()
})
