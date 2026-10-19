import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { test, type TestContext } from 'node:test'

import { IdentityAccessError } from '../modules/identity/auth-service.ts'
import { skillConflict } from '../modules/skill/skill-errors.ts'
import { httpResult, readJsonBody, Router } from './router.ts'

interface LogRecord {
  event: string
  timestamp: string
  requestId: string
  traceId: string
  method: string
  path: string
  status: number
  code: string
  message: string
  responseStarted: boolean
}
const failureLogKeys = ['event', 'timestamp', 'requestId', 'traceId', 'method', 'path', 'status', 'code', 'message', 'responseStarted']
function capture(t: TestContext) {
  const lines: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args) })
  return () => lines.map(args => {
    assert.equal(args.length, 1, 'log must be a single serialized record, not an Error object')
    assert.equal(typeof args[0], 'string')
    const record = JSON.parse(args[0] as string) as LogRecord
    assert.equal(record.event, 'http.request.failed')
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.match(record.requestId, /^[a-f0-9]{32}$/)
    assert.match(record.traceId, /^trace-http-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert.notEqual(record.requestId, record.traceId)
    assert.equal(record.traceId.includes(record.requestId), false)
    assert.equal(typeof record.method, 'string')
    assert.equal(typeof record.path, 'string')
    assert.equal(typeof record.status, 'number')
    assert.equal(typeof record.code, 'string')
    assert.equal(typeof record.message, 'string')
    assert.equal(typeof record.responseStarted, 'boolean')
    assert.deepEqual(Object.keys(record).sort(), [...failureLogKeys].sort())
    return { raw: args[0] as string, record }
  })
}
async function withServer(router: Router, run: (url: string) => Promise<void>) {
  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('P2-3 RED: thrown 5xx logs correlation and original sanitized message, not body/header/query/stack', async t => {
  const logs = capture(t), router = new Router()
  router.post('/api/admin/v1/skills/:skillId/test', () => {
    const error = Object.assign(new Error('synthetic service broke password=message-secret'), { body: 'error-body-secret', headers: 'error-headers-secret' })
    error.stack = 'INTERNAL_STACK_SECRET'; error.cause = { token: 'CAUSE_SECRET' }
    throw error
  })
  await withServer(router, async url => {
    const response = await fetch(`${url}/api/admin/v1/skills/path-secret/test?access_token=query-secret`, {
      method: 'POST', headers: { authorization: 'Bearer header-secret', cookie: 'session=cookie-secret' }, body: 'REQUEST_BODY_SECRET',
    })
    const { error } = await response.json() as { error: { traceId: string } }
    assert.equal(response.status, 500)
    assert.equal(logs().length, 1)
    const { raw, record } = logs()[0]!
    assert.equal(record.event, 'http.request.failed')
    assert.equal(record.traceId, error.traceId)
    assert.equal(record.method, 'POST'); assert.equal(record.status, 500)
    assert.equal(record.path, '/api/admin/v1/skills/:skillId/test')
    assert.equal(record.code, 'operation_failed'); assert.match(record.message, /synthetic service broke/)
    assert.match(response.headers.get('x-request-id') ?? '', /^[a-f0-9]{32}$/)
    assert.equal(record.requestId, response.headers.get('x-request-id'))
    assert.doesNotMatch(raw, /message-secret|path-secret|query-secret|header-secret|cookie-secret|REQUEST_BODY_SECRET|INTERNAL_STACK_SECRET|CAUSE_SECRET|error-body-secret|error-headers-secret/)
    assert.deepEqual(Object.keys(record).sort(), [...failureLogKeys].sort())
  })
})
for (const [error, status] of [[skillConflict('已有草稿未完成'), 409], [new IdentityAccessError(421, 'unknown_request_origin', '请求入口不在允许列表中'), 421]] as const) {
  test(`P2-3 RED: typed ${status} response is logged once with the same traceId`, async t => {
    const logs = capture(t), router = new Router()
    router.get('/failure', () => { throw error })
    await withServer(router, async url => {
      // Use node:http: fetch/undici can automatically repeat 421 on a fresh connection.
      // This assertion is about one request producing one record, not client retry behavior.
      const response = await new Promise<{ status: number; body: { error: { traceId: string } } }>((resolve, reject) => {
        const request = httpRequest(url + '/failure', incoming => {
          let text = ''
          incoming.setEncoding('utf8'); incoming.on('data', chunk => { text += chunk })
          incoming.on('error', reject)
          incoming.on('end', () => {
            try { resolve({ status: incoming.statusCode!, body: JSON.parse(text) }) } catch (error) { reject(error) }
          })
        })
        request.on('error', reject); request.end()
      })
      const body = response.body
      assert.equal(response.status, status); assert.equal(logs().length, 1)
      assert.equal(logs()[0]!.record.status, status); assert.equal(logs()[0]!.record.traceId, body.error.traceId)
    })
  })
}

test('P2-3 RED: invalid JSON logs the safe validation message, never the parser input excerpt', async t => {
  const logs = capture(t), router = new Router()
  router.post('/parse/:id', request => readJsonBody(request))
  await withServer(router, async url => {
    const response = await fetch(url + '/parse/SECRET_PARSE_PATH', { method: 'POST', body: '{"private":"BODY_EXCERPT_SECRET", broken}' })
    assert.equal(response.status, 422); assert.equal(logs().length, 1)
    assert.doesNotMatch(logs()[0]!.raw, /BODY_EXCERPT_SECRET|SECRET_PARSE_PATH|private/)
    assert.match(logs()[0]!.record.message, /有效 JSON/)
  })
})

test('P2-3 RED: JSON/cookie/auth/token/URL fragments in messages are omitted or redacted', async t => {
  const logs = capture(t), router = new Router()
  const messages = [
    'failed id_token=ID_TOKEN_SECRET client_secret=CLIENT_SECRET access_token="TOKEN WITH SPACE"',
    'failed Cookie: session=COOKIE_MESSAGE_SECRET; other=SECOND_COOKIE_SECRET',
    'failed Authorization: Basic BASIC_MESSAGE_SECRET',
    'failed postgres://user:PG_PASS_SECRET@127.0.0.1/db?sslpassword=QUERY_MESSAGE_SECRET',
    'failed {"request":"JSON_BODY_SECRET","password":"JSON_PASSWORD_SECRET"}',
    'failed payload=BODY_PAYLOAD_SECRET',
    'failed ["ARRAY_BODY_SECRET"]',
    'failed\nINTERNAL_STACK_LINE password=SECOND_LINE_SECRET',
  ]
  let index = 0
  router.get('/message', () => { throw new Error(messages[index++]!) })
  await withServer(router, async url => {
    for (const _message of messages) { void _message; await (await fetch(url + '/message')).text() }
    assert.equal(logs().length, messages.length)
    for (const log of logs()) {
      assert.doesNotMatch(log.raw, /ID_TOKEN_SECRET|CLIENT_SECRET|TOKEN WITH SPACE|COOKIE_MESSAGE_SECRET|SECOND_COOKIE_SECRET|BASIC_MESSAGE_SECRET|PG_PASS_SECRET|QUERY_MESSAGE_SECRET|JSON_BODY_SECRET|JSON_PASSWORD_SECRET|BODY_PAYLOAD_SECRET|ARRAY_BODY_SECRET|INTERNAL_STACK_LINE|SECOND_LINE_SECRET/)
      assert.equal(log.raw.includes('\n'), false)
    }
  })
})

test('P2-3 RED: errors after headers are logged, but no JSON envelope is appended to an existing stream', async t => {
  const logs = capture(t), router = new Router()
  router.get('/stream', (_request, _context, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(':started\n\n')
    throw new Error('synthetic stream failure')
  })
  await withServer(router, async url => {
    const response = await fetch(url + '/stream')
    assert.equal(await response.text(), ':started\n\n')
    assert.equal(logs().length, 1)
    assert.equal(logs()[0]!.record.responseStarted, true)
    assert.equal(logs()[0]!.record.status, 500, 'classified failure, not the already-sent 200')
  })
})

test('P2-3 RED: unknown route and explicit error response are logged without serializing payloads', async t => {
  const logs = capture(t), router = new Router()
  router.get('/explicit', () => httpResult(409, { error: { code: 'state_conflict', message: 'synthetic conflict' }, private: 'PRIVATE_RESULT_SECRET' }))
  await withServer(router, async url => {
    const unknown = await fetch(url + '/SECRET_UNKNOWN_PATH?token=SECRET_UNKNOWN_QUERY')
    const body = await unknown.json() as { error: { traceId: string } }
    assert.equal(unknown.status, 404)
    await (await fetch(url + '/explicit')).text()
    assert.equal(logs().length, 2)
    assert.equal(logs()[0]!.record.traceId, body.error.traceId)
    assert.equal(logs()[0]!.record.path, '[unmatched]')
    assert.equal(logs()[1]!.record.status, 409)
    for (const log of logs()) assert.doesNotMatch(log.raw, /PRIVATE_RESULT_SECRET|SECRET_UNKNOWN_PATH|SECRET_UNKNOWN_QUERY/)
  })
})

test('P2-3: successful responses are not error-logged; non-Error throws never serialize arbitrary objects', async t => {
  const logs = capture(t), router = new Router()
  router.get('/ok', () => ({ data: 'ok' }))
  router.get('/object', () => { throw { message: 'ARBITRARY_SECRET', payload: 'OBJECT_BODY_SECRET' } })
  await withServer(router, async url => {
    const ok = await fetch(url + '/ok')
    assert.equal(ok.status, 200); assert.match(ok.headers.get('x-request-id') ?? '', /^[a-f0-9]{32}$/)
    assert.equal(logs().length, 0)
    const response = await fetch(url + '/object'); await response.text()
    assert.equal(logs().length, 1); assert.doesNotMatch(logs()[0]!.raw, /ARBITRARY_SECRET|OBJECT_BODY_SECRET/)
  })
})

test('P2-3: logging failure cannot change HTTP error classification or strand the response', async t => {
  t.mock.method(console, 'error', () => { throw new Error('synthetic unavailable log sink') })
  const router = new Router(); router.get('/failure', () => { throw skillConflict('synthetic conflict') })
  await withServer(router, async url => {
    const response = await fetch(url + '/failure'), body = await response.json() as { error: { code: string; traceId: string } }
    assert.equal(response.status, 409); assert.equal(body.error.code, 'skill_state_conflict')
    assert.match(response.headers.get('x-request-id') ?? '', /^[a-f0-9]{32}$/)
    assert.match(body.error.traceId, /^trace-http-/)
    assert.notEqual(response.headers.get('x-request-id'), body.error.traceId)
  })
})

test('P2-3: valid X-Request-Id is kept; missing or invalid values become a new 16-byte hex id', async t => {
  const logs = capture(t), router = new Router()
  router.get('/failure', () => { throw new Error('synthetic request id failure') })
  const valid = 'ab'.repeat(16)
  const invalidValues = [
    'AB'.repeat(16),
    'a'.repeat(31),
    'a'.repeat(33),
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    'token=REQUEST_ID_SECRET',
    'trace-http-00000000-0000-4000-8000-000000000000',
  ]
  await withServer(router, async url => {
    const accepted = await fetch(url + '/failure', { headers: { 'x-request-id': valid } })
    assert.equal(accepted.status, 500)
    assert.equal(accepted.headers.get('x-request-id'), valid)
    assert.equal(logs()[0]!.record.requestId, valid)
    const missing = await fetch(url + '/failure')
    const missingId = missing.headers.get('x-request-id') ?? ''
    assert.match(missingId, /^[a-f0-9]{32}$/)
    assert.notEqual(missingId, valid)
    assert.equal(logs()[1]!.record.requestId, missingId)
    for (const invalid of invalidValues) {
      const response = await fetch(url + '/failure', { headers: { 'x-request-id': invalid } })
      const requestId = response.headers.get('x-request-id') ?? ''
      assert.match(requestId, /^[a-f0-9]{32}$/)
      assert.notEqual(requestId, invalid)
      assert.notEqual(requestId, invalid.toLowerCase())
      const log = logs().at(-1)!
      assert.equal(log.record.requestId, requestId)
      assert.equal(log.raw.includes(invalid), false)
      assert.doesNotMatch(log.raw, /REQUEST_ID_SECRET/)
    }
  })
})


test('P2-3: message length is bounded and control sequences cannot create extra records', async t => {
  const logs = capture(t), router = new Router()
  const escape = String.fromCharCode(27)
  router.get('/long', () => { throw new Error(`fault ${escape}[31mpassword=CONTROL_SECRET${escape}[0m ` + 'x'.repeat(20000)) })
  await withServer(router, async url => {
    await (await fetch(url + '/long')).text()
    assert.equal(logs().length, 1)
    const { record, raw } = logs()[0]!
    assert.ok(record.message.length <= 1024)
    assert.doesNotMatch(raw, /CONTROL_SECRET/)
    assert.equal(raw.includes(escape), false)
  })
})
