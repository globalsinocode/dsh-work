import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertRuntimeModelRequirements, CapabilityGuardedRuntime, ExecutionCapabilityUnavailableError, UnavailableRuntime, probeExecutionCapability } from './execution-capabilities.ts'
import type { AgentRuntimePort, RuntimeManifest } from './runtime-types.ts'

test('unavailable port never admits work or fabricates tools/events/results', async () => {
  const runtime = new UnavailableRuntime('runtime-fixture')
  await runtime.configureScheduling('accepting')
  assert.equal((await runtime.health()).acceptingRuns, false)
  assert.equal((await runtime.health()).status, 'offline')
  await assert.rejects(runtime.execute({} as RuntimeManifest), { code: 'RUNTIME_UNAVAILABLE', status: 503 })
  await assert.rejects(runtime.listTools(), { code: 'RUNTIME_UNAVAILABLE' })
  assert.equal(runtime.status('run-fixture'), undefined)
  assert.deepEqual(await runtime.cancel('run-fixture', 'user-fixture'), { accepted: false })
  let events = 0; const unsubscribe = runtime.subscribe('run-fixture', () => { events++ }); unsubscribe()
  assert.equal(events, 0); await runtime.close()
})
test('failed optional probe returns a negative capability without exposing stderr or credentials', async () => {
  const result = await probeExecutionCapability('python', async () => { throw new Error('sensitive subprocess detail') })
  assert.deepEqual(result, { value: null, state: { status: 'unavailable', code: 'PYTHON_UNAVAILABLE' } })
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
  assert.deepEqual(await probeExecutionCapability('python', null), { value: null, state: { status: 'not-configured' } })
})
test('Python failure leaves non-Python tasks on the original DSH port', async () => {
  let executions = 0
  const delegate = { execute: async (manifest: RuntimeManifest) => { executions++; return { runId: manifest.run_id } } } as AgentRuntimePort
  const runtime = new CapabilityGuardedRuntime(delegate, { status: 'unavailable' })
  const manifest = { run_id: 'run-fixture', tools: [] } as unknown as RuntimeManifest
  assert.equal((await runtime.execute(manifest)).runId, 'run-fixture')
  await assert.rejects(runtime.execute({ ...manifest, tools: [{ id: 'python_execute', version: '1.0.0' }] }), { code: 'PYTHON_UNAVAILABLE' })
  assert.equal(executions, 1)
})
test('healthy probe and Python capability delegate without changing the Manifest', async () => {
  const result = await probeExecutionCapability('dsh', async () => 'fixed-installation')
  assert.equal(result.value, 'fixed-installation'); assert.equal(result.state.status, 'available')
  const manifest = { tools: [{ id: 'python_execute', version: '1.0.0' }] } as RuntimeManifest
  const runtime = new CapabilityGuardedRuntime({ execute: async (received: RuntimeManifest) => {
    assert.equal(received, manifest); return {} } } as AgentRuntimePort, { status: 'available' })
  await runtime.execute(manifest)
})
test('capability errors are typed as temporary dependency failures, not authorization denials', () => {
  const error = new ExecutionCapabilityUnavailableError('dsh')
  assert.equal(error.status, 503); assert.notEqual(error.code, 'AUTHORIZATION_REVOKED')
})

test('model admission fails closed without a verifier and forwards the exact target through wrappers', async () => {
  const target = { providerKey: 'test-provider', modelKey: 'test-model', baseUrl: 'https://example.invalid' }
  const absent = new CapabilityGuardedRuntime({} as AgentRuntimePort, { status: 'available' })
  await assertRuntimeModelRequirements(absent, [], target)
  await assert.rejects(assertRuntimeModelRequirements(absent, ['long-context'], target), { code: 'MODEL_CAPABILITY_UNAVAILABLE', status: 503 })
  let checks = 0
  const verifier: Pick<AgentRuntimePort, 'assertModelRequirements'> = { async assertModelRequirements(requirements, received) {
    checks++
    assert.deepEqual(requirements, ['structured-output'])
    assert.equal(received, target)
    throw new ExecutionCapabilityUnavailableError('model')
  } }
  const guarded = new CapabilityGuardedRuntime(verifier as AgentRuntimePort, { status: 'available' })
  await assert.rejects(assertRuntimeModelRequirements(guarded, ['structured-output'], target), { code: 'MODEL_CAPABILITY_UNAVAILABLE' })
  assert.equal(checks, 1)
})
