import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers'
import { apply, createRemoteSubprocess, name } from './dsh-work-remote-subprocess.js'
import { createPlatformToolBridge } from '../../src/modules/runtime/platform-tool-bridge.ts'

const collect = maxBytes => ({ maxBytes, spill: { maxBytes: 1024 } })

function spec(overrides = {}) {
  return {
    argv: ['/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', '--files'],
    cwd: '/ws',
    stdio: { stdin: 'ignore', stdout: collect(4096), stderr: collect(1024) },
    graceMs: 100,
    env: { DSH_HOME: '/secret/dsh-home', DSH_SESSION_ID: 's-1' },
    ...overrides,
  }
}

test('plugin registers itself as ctx.subprocess without importing DSH', () => {
  const provided = new Map()
  apply({ provide: (key, value) => { provided.set(key, value) } })
  assert.equal(name, 'dsh-work-remote-subprocess')
  assert.deepEqual([...provided.keys()], ['subprocess'])
  for (const method of ['resolveExecutable', 'spawn', 'spawnTerminal']) assert.equal(typeof provided.get('subprocess')[method], 'function')
})

test('spawn goes through the bridge, returns collected output and never sends env', async () => {
  const bodies = []
  const bridge = await createPlatformToolBridge({}, 0, undefined, undefined, undefined, async body => {
    bodies.push(body)
    return { exitCode: 0, stdout: 'a.txt\nb.txt\n', stderr: '', truncated: false, timedOut: false }
  })
  try {
    const runtime = createRemoteSubprocess(bridge.socket)
    const handle = runtime.spawn(spec())
    assert.equal(handle.collected.stdout.readFrom(0).text, '', 'empty before the command ends')
    assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
    assert.equal(await handle.waitForExit(), true)
    const read = handle.collected.stdout.readFrom(0)
    assert.equal(read.text, 'a.txt\nb.txt\n')
    assert.equal(handle.collected.stdout.readFrom(6).text, 'b.txt\n', 'readers use byte offsets and do not consume')
    assert.equal(bodies.length, 1)
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['argv', 'cwd', 'maxOutputBytes', 'timeoutMs'])
    assert.equal(bodies[0].maxOutputBytes, 4096)
    assert.equal(JSON.stringify(bodies[0]).includes('/secret/dsh-home'), false)
  } finally { await bridge.close() }
})

test('spawn rejects modes the remote world cannot serve', () => {
  const runtime = createRemoteSubprocess('/tmp/not-used.sock')
  assert.throws(() => runtime.spawn(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: collect(1) } })), /collected output/)
  assert.throws(() => runtime.spawn(spec({ stdio: { stdin: 'pipe', stdout: collect(1), stderr: collect(1) } })), /stdin/)
  assert.throws(() => runtime.spawn(spec({ argv: [] })), /argv/)
  assert.throws(() => createRemoteSubprocess(undefined).spawn(spec()), /not available/)
  return assert.rejects(runtime.spawnTerminal({}), /terminal/)
})

test('cancel disconnects the request and settles as killed', async () => {
  let aborted = false
  const bridge = await createPlatformToolBridge({}, 0, undefined, undefined, undefined, async (_body, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    aborted = true
    throw new globalThis.DOMException('Aborted', 'AbortError')
  })
  try {
    const controller = new globalThis.AbortController()
    const handle = createRemoteSubprocess(bridge.socket).spawn(spec({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 30)
    assert.deepEqual(await handle.done, { exitCode: null, signal: 'SIGKILL' })
    const deadline = Date.now() + 5000
    while (!aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(aborted, true, 'the platform saw the disconnect and stopped the command')
  } finally { await bridge.close() }
})

test('a refused command surfaces the platform message', async () => {
  const bridge = await createPlatformToolBridge({}, 0, undefined, undefined, undefined, async () => {
    const error = new Error('执行容器不允许运行该程序：bash')
    error.status = 403
    throw error
  })
  try {
    const handle = createRemoteSubprocess(bridge.socket).spawn(spec())
    await assert.rejects(handle.done, /不允许运行该程序/)
  } finally { await bridge.close() }
})
