import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_CAPABILITIES,
  RELEASE_HEALTH_BUDGET_SECONDS,
  RELEASE_HEALTH_POLL_INTERVAL_MS,
  RELEASE_READINESS_ATTEMPTS,
  createRequester,
  isMainModule,
  parseOptions,
  runReleaseWait,
  validateReadiness,
  waitForHttpOk,
  waitForReadiness,
} from '../deploy/release-wait.mjs'

function fakeClock() {
  let milliseconds = 0
  return {
    now: () => milliseconds,
    sleep: async duration => { milliseconds += duration },
    elapsed: () => milliseconds,
  }
}

function sequenceRequester(responses) {
  let index = 0
  return async () => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return typeof response === 'function' ? response() : response
  }
}

const okHealth = { statusCode: 200, body: '' }
const failedHealth = { statusCode: 0, body: '' }
const readyBody = JSON.stringify({
  status: 'ready',
  core: true,
  executionCapabilities: {
    dsh: { status: 'available' },
    python: { status: 'available' },
    executionContainer: { status: 'available' },
  },
})

test('wait budget covers the full startup probe upper bound', () => {
  // DSH 94 s + execution container 3 x ~400 s is ~21 minutes; keep a margin above it.
  assert.ok(RELEASE_HEALTH_BUDGET_SECONDS * 1000 > 22 * 60 * 1000)
  assert.equal(RELEASE_HEALTH_BUDGET_SECONDS, 1500)
  assert.equal(RELEASE_HEALTH_POLL_INTERVAL_MS, 2000)
  assert.equal(RELEASE_READINESS_ATTEMPTS, 30)
  assert.deepEqual(REQUIRED_CAPABILITIES, ['dsh', 'executionContainer'])
})

test('waitForHttpOk keeps waiting past the old 90-attempt/180 s limit', async () => {
  const clock = fakeClock()
  const slow = Array.from({ length: 120 }, () => failedHealth)
  const response = await waitForHttpOk({
    request: sequenceRequester([...slow, okHealth]),
    url: 'https://192.0.2.10:4174/health',
    budgetMs: 300_000,
    intervalMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
  })
  assert.equal(response.ok, true)
  assert.equal(response.attempts, 121)
  assert.ok(response.elapsedMs > 180_000)
})

test('waitForHttpOk fails once the budget is exhausted', async () => {
  const clock = fakeClock()
  const response = await waitForHttpOk({
    request: sequenceRequester([failedHealth]),
    url: 'https://192.0.2.10:4174/health',
    budgetMs: 300_000,
    intervalMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
  })
  assert.equal(response.ok, false)
  assert.ok(response.elapsedMs >= 300_000)
  assert.ok(response.attempts > 90)
})

test('validateReadiness accepts available capabilities and reports python', () => {
  assert.deepEqual(validateReadiness(readyBody), { ok: true, python: 'available' })
  const withoutPython = JSON.parse(readyBody)
  delete withoutPython.executionCapabilities.python
  assert.deepEqual(validateReadiness(JSON.stringify(withoutPython)), { ok: true, python: 'unknown' })
})

test('validateReadiness rejects missing capabilities and invalid bodies', () => {
  const missingContainer = JSON.parse(readyBody)
  missingContainer.executionCapabilities.executionContainer = { status: 'unavailable', code: 'EXECUTION_CONTAINER_UNAVAILABLE' }
  assert.deepEqual(validateReadiness(JSON.stringify(missingContainer)), {
    ok: false,
    kind: 'capability',
    missing: ['executionContainer'],
  })
  assert.deepEqual(validateReadiness('<html>bad gateway</html>'), { ok: false, kind: 'invalid-response' })
})

test('waitForReadiness retries database readiness but fails capabilities immediately', async () => {
  const clock = fakeClock()
  const retried = await waitForReadiness({
    request: sequenceRequester([
      { statusCode: 502, body: '<html>bad gateway</html>' },
      { statusCode: 503, body: JSON.stringify({ status: 'not-ready', code: 'DATABASE_UNAVAILABLE' }) },
      { statusCode: 200, body: readyBody },
    ]),
    url: 'http://127.0.0.1:4190/health/ready',
    attempts: 30,
    intervalMs: 2000,
    sleep: clock.sleep,
  })
  assert.equal(retried.ok, true)
  assert.equal(retried.attempt, 3)

  const capabilityFailure = await waitForReadiness({
    request: sequenceRequester([{
      statusCode: 200,
      body: JSON.stringify({ executionCapabilities: { dsh: { status: 'unavailable' }, executionContainer: { status: 'unavailable' } } }),
    }]),
    url: 'http://127.0.0.1:4190/health/ready',
    attempts: 30,
    intervalMs: 2000,
    sleep: clock.sleep,
  })
  assert.equal(capabilityFailure.ok, false)
  assert.equal(capabilityFailure.kind, 'capability')
  assert.equal(capabilityFailure.attempt, 1)
})

test('waitForReadiness reports a database or transient timeout and an unexpected status', async () => {
  const clock = fakeClock()
  const databaseTimeout = await waitForReadiness({
    request: sequenceRequester([{ statusCode: 503, body: '' }]),
    url: 'http://127.0.0.1:4190/health/ready',
    attempts: 3,
    intervalMs: 2000,
    sleep: clock.sleep,
  })
  assert.deepEqual(databaseTimeout, { ok: false, kind: 'database', status: 503, attempt: 3 })

  const transientTimeout = await waitForReadiness({
    request: sequenceRequester([
      { statusCode: 0, body: '' },
      { statusCode: 502, body: '<html>bad gateway</html>' },
      { statusCode: 504, body: '' },
    ]),
    url: 'http://127.0.0.1:4190/health/ready',
    attempts: 3,
    intervalMs: 2000,
    sleep: clock.sleep,
  })
  assert.equal(transientTimeout.ok, false)
  assert.equal(transientTimeout.kind, 'transient')
  assert.equal(transientTimeout.attempt, 3)

  const unexpected = await waitForReadiness({
    request: sequenceRequester([{ statusCode: 500, body: 'boom' }]),
    url: 'http://127.0.0.1:4190/health/ready',
    attempts: 3,
    intervalMs: 2000,
    sleep: clock.sleep,
  })
  assert.equal(unexpected.ok, false)
  assert.equal(unexpected.kind, 'http')
  assert.equal(unexpected.attempt, 1)
})

test('runReleaseWait treats capability unavailability as a hard failure', async () => {
  const clock = fakeClock()
  const stdout = []
  const stderr = []
  const result = await runReleaseWait({
    healthUrl: 'https://192.0.2.10:4174/health',
    readyUrl: 'http://127.0.0.1:4190/health/ready',
    healthBudgetSeconds: 5,
    pollIntervalMs: 1000,
    requestTimeoutMs: 1000,
    readinessAttempts: 30,
  }, {
    request: sequenceRequester([
      okHealth,
      { statusCode: 200, body: JSON.stringify({ executionCapabilities: { dsh: { status: 'unavailable' }, executionContainer: { status: 'unavailable' } } }) },
    ]),
    now: clock.now,
    sleep: clock.sleep,
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  })
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'readiness')
  assert.ok(stderr.some(line => line === 'release readiness check failed: required execution capabilities unavailable (http://127.0.0.1:4190/health/ready)'))
  assert.ok(stdout.some(line => line.startsWith('release health check passed after')))
})

test('runReleaseWait fails with the documented message when /health never answers', async () => {
  const clock = fakeClock()
  const stderr = []
  const result = await runReleaseWait({
    healthUrl: 'https://192.0.2.10:4174/health',
    readyUrl: 'http://127.0.0.1:4190/health/ready',
    healthBudgetSeconds: 5,
    pollIntervalMs: 1000,
    requestTimeoutMs: 1000,
    readinessAttempts: 30,
  }, {
    request: sequenceRequester([failedHealth]),
    now: clock.now,
    sleep: clock.sleep,
    stdout: () => {},
    stderr: line => stderr.push(line),
  })
  assert.equal(result.code, 1)
  assert.equal(result.phase, 'health')
  assert.ok(stderr.some(line => line === 'release health check failed: https://192.0.2.10:4174/health (waited 5s)'))
})

test('runReleaseWait succeeds and warns about missing python', async () => {
  const clock = fakeClock()
  const stderr = []
  const body = JSON.parse(readyBody)
  body.executionCapabilities.python = { status: 'not-configured' }
  const result = await runReleaseWait({
    healthUrl: 'https://192.0.2.10:4174/health',
    readyUrl: 'http://127.0.0.1:4190/health/ready',
    healthBudgetSeconds: 5,
    pollIntervalMs: 1000,
    requestTimeoutMs: 1000,
    readinessAttempts: 30,
  }, {
    request: sequenceRequester([okHealth, { statusCode: 200, body: JSON.stringify(body) }]),
    now: clock.now,
    sleep: clock.sleep,
    stdout: () => {},
    stderr: line => stderr.push(line),
  })
  assert.equal(result.code, 0)
  assert.ok(stderr.some(line => line.startsWith('python capability unavailable (not-configured)')))
})

test('parseOptions validates required flags and defaults', () => {
  const options = parseOptions(['--health-url', 'https://host/health', '--ready-url', 'http://127.0.0.1:4190/health/ready'])
  assert.equal(options.healthBudgetSeconds, RELEASE_HEALTH_BUDGET_SECONDS)
  assert.equal(options.pollIntervalMs, RELEASE_HEALTH_POLL_INTERVAL_MS)
  assert.equal(options.readinessAttempts, RELEASE_READINESS_ATTEMPTS)
  assert.throws(() => parseOptions(['--ready-url', 'http://127.0.0.1/health/ready']), /--health-url is required/)
  assert.throws(() => parseOptions(['--health-url', 'https://host/health']), /--ready-url is required/)
  assert.throws(() => parseOptions(['--health-url', 'https://host/health', '--ready-url', 'http://x', '--health-budget-seconds', '0']), /positive integer/)
  assert.throws(() => parseOptions(['--health-url', 'https://host/health', '--ready-url', 'http://x', '--unknown', '1']), /unknown option/)
})

test('detects the CLI entry point through symlink-resolved paths', () => {
  assert.equal(isMainModule('/definitely/not/this/module.mjs'), false)
  const modulePath = fileURLToPath(new URL('../deploy/release-wait.mjs', import.meta.url))
  assert.equal(isMainModule(modulePath), true)
  assert.equal(isMainModule(fileURLToPath(import.meta.url)), false)
  // Unexpected path forms still run the CLI instead of silently doing nothing.
  assert.equal(isMainModule('/unresolved/path/release-wait.mjs'), true)
})

test('createRequester talks HTTP and never rejects on a bad URL', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 503, { 'content-type': 'text/plain' })
    response.end('ok')
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const { port } = server.address()
    const request = createRequester({ requestTimeoutMs: 1000 })
    const response = await request(`http://127.0.0.1:${port}/health`)
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, 'ok')
    const missing = await request(`http://127.0.0.1:${port}/missing`)
    assert.equal(missing.statusCode, 503)
    const invalid = await request('not a url')
    assert.equal(invalid.statusCode, 0)
    assert.ok(invalid.error)
  } finally {
    await new Promise(resolve => { server.close(resolve) })
  }
})
