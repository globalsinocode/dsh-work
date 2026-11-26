import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import type { ErrorRecordInput } from '../modules/observability/client-error-report.ts'
import { registerClientErrorRoutes } from './client-error-routes.ts'
import { Router } from './router.ts'

/** 浏览器错误上报接口（OBS-E2E-03）：来源、内容类型、结构、限流与未登录接收。 */
const allowedOrigin = 'http://work.test'
let server: Server
let base: string
let recorded: ErrorRecordInput[] = []

before(async () => {
  const router = new Router()
  registerClientErrorRoutes(router, {
    record: async input => { recorded.push(input) },
    authenticate: async request => {
      if (request.headers.cookie !== 'session=ok') throw new Error('not signed in')
      return { userId: 'U00001' } as RequestIdentity
    },
    validateOrigin: request => {
      if (request.headers.origin !== allowedOrigin) throw Object.assign(new Error('请求来源校验失败'), { status: 403, code: 'csrf_check_failed' })
    },
  })
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => new Promise<void>(resolve => server.close(() => resolve())))
beforeEach(() => { recorded = [] })

const report = (overrides: Record<string, unknown> = {}) => ({ kind: 'render', message: 'boom', route: 'conversation', ...overrides })

function send(body: unknown, options: { origin?: string; contentType?: string; cookie?: string; app?: string; realIp?: string } = {}) {
  return fetch(`${base}/auth/${options.app ?? 'workbench'}/client-errors`, {
    method: 'POST',
    headers: {
      'content-type': options.contentType ?? 'text/plain;charset=UTF-8',
      origin: options.origin ?? allowedOrigin,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.realIp ? { 'x-real-ip': options.realIp } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('signed-in reports are recorded with the employee and a client summary', async () => {
  const response = await send({ app: 'workbench', reports: [report(), report({ kind: 'promise', message: 'x' })] }, { cookie: 'session=ok' })
  assert.equal(response.status, 202)
  assert.deepEqual((await response.json()).data, { accepted: 2, dropped: 0 })
  assert.equal(recorded.length, 2)
  assert.equal(recorded[0]!.userId, 'U00001')
  assert.equal(recorded[0]!.source, 'workbench')
  assert.equal(recorded[0]!.client, 'Chrome 131 / macOS')
})

test('anonymous reports are accepted without identity and limited per address', async () => {
  const batch = { app: 'workbench', reports: Array.from({ length: 8 }, () => report()) }
  const first = await send(batch, { realIp: '10.9.9.1' })
  assert.equal(first.status, 202)
  assert.deepEqual((await first.json()).data, { accepted: 8, dropped: 0 })
  const second = await send(batch, { realIp: '10.9.9.1' })
  assert.deepEqual((await second.json()).data, { accepted: 2, dropped: 6 })
  assert.ok(recorded.every(item => item.userId === null))
  // 另一个来源地址有自己的额度（直连为回环地址时采用 X-Real-IP）。
  const other = await send({ app: 'workbench', reports: [report()] }, { realIp: '10.9.9.2' })
  assert.deepEqual((await other.json()).data, { accepted: 1, dropped: 0 })
})

test('anonymous global allowance is only charged for reports an address was allowed', async () => {
  // 一个地址每分钟最多 10 条；它反复发满批次也只占全局额度 10 条，其他地址的白屏上报仍能进来。
  const batch = { app: 'admin', reports: Array.from({ length: 20 }, () => report()) }
  for (let index = 0; index < 20; index += 1) await send(batch, { app: 'admin', realIp: '10.8.0.1' })
  // 同一文件前面的未登录用例已占 11 条全局额度：10 + 27×10 + 11 = 291 ≤ 300。
  for (let index = 2; index <= 28; index += 1) {
    const response = await send({ app: 'admin', reports: Array.from({ length: 10 }, () => report()) }, { app: 'admin', realIp: `10.8.0.${index}` })
    assert.equal((await response.json()).data.accepted, 10, `address ${index}`)
  }
})

test('cross-site, wrong content type, malformed and oversized reports are rejected', async () => {
  assert.equal((await send({ app: 'workbench', reports: [report()] }, { origin: 'http://evil.test' })).status, 403)
  assert.equal((await send({ app: 'workbench', reports: [report()] }, { contentType: 'multipart/form-data' })).status, 422)
  assert.equal((await send('not json')).status, 422)
  assert.equal((await send({ app: 'admin', reports: [report()] })).status, 422)
  assert.equal((await send({ app: 'workbench', reports: [report({ requestBody: 'x' })] })).status, 422)
  assert.equal((await send({ app: 'workbench', reports: [report()] }, { app: 'other' })).status, 404)
  assert.equal((await send({ app: 'workbench', reports: [report({ message: 'x'.repeat(40_000) })] })).status, 422)
  assert.equal(recorded.length, 0)
})
