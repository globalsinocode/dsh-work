import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'

import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { IdentityAccessError } from '../modules/identity/request-security.ts'
import { loadIdentityConfiguration } from '../modules/identity/config.ts'
import { LocalAuthService } from '../modules/identity/local-auth-service.ts'
import { registerLocalAuthRoutes } from './local-auth-routes.ts'
import { classifyHttpError, Router } from './router.ts'

/** Real origin validation, no credentials, database or network stub for the decision. */
function originRouter() {
  const configuration = loadIdentityConfiguration({
    NODE_ENV: 'development',
    DSH_WORK_SESSION_SECRET: 'origin-test-only-session-key-with-32-characters', DSH_WORK_COOKIE_SECURE: 'false',
    DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174',
    DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  })
  // Origin rejection must happen before any database call.
  const database = new Proxy(() => { throw new Error('unexpected database call') }, {
    get() { throw new Error('unexpected database access') },
  }) as unknown as DatabaseClient
  const router = new Router()
  registerLocalAuthRoutes(router, new LocalAuthService(configuration, database))
  return router
}

for (const audience of ['admin', 'workbench']) {
  test(`P2-1: direct backend origin returns 421/unknown_request_origin (${audience})`, async () => {
    const router = originRouter()
    const server = createServer((request, response) => void router.handle(request, response))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const { port } = server.address() as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}/auth/${audience}/login`, { redirect: 'manual' })
      const body = await response.json() as { error: { code: string; message: string; suggestion: string; traceId: string } }
      assert.equal(response.status, 421)
      assert.equal(body.error.code, 'unknown_request_origin')
      assert.match(body.error.suggestion, /入口|代理/)
      assert.match(body.error.traceId, /^trace-http-/)
      assert.equal(response.headers.get('location'), null, 'no redirect to an unapproved origin')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
}

test('P2-1: invalid forwarded origin preserves invalid_request_origin and status 421', async () => {
  const router = originRouter()
  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/auth/admin/login`, {
      headers: { 'x-forwarded-proto': 'ftp' }, redirect: 'manual',
    })
    assert.equal(response.status, 421)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'invalid_request_origin')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('P2-1: CSRF stays 403; adding 421 does not weaken origin/authentication decisions', () => {
  const failure = classifyHttpError(new IdentityAccessError(403, 'csrf_check_failed', '请求来源校验失败'), '/api/admin/v1/skills')
  assert.equal(failure.status, 403)
  assert.equal(failure.error.code, 'csrf_check_failed')
})
