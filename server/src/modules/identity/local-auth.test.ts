import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadIdentityConfiguration, loadStartupIdentityConfiguration, localIdentityConfiguration } from './config.ts'
import { createConcurrencyLimiter, hashPassword, normalizeUsername, validatePassword, verifyPassword } from './password.ts'
import { normalizeLoginAccount } from './login-account.ts'

test('new login accounts require phone or email and normalize equivalent spellings', () => {
  assert.equal(normalizeLoginAccount(' 13800138000 '), '13800138000')
  assert.equal(normalizeLoginAccount('+8613800138000'), '13800138000')
  assert.equal(normalizeUsername('+8613800138000'), '13800138000')
  assert.equal(normalizeLoginAccount(' Alice+Work@Example.COM '), 'alice+work@example.com')
  assert.equal(normalizeUsername('Alice+Work@Example.COM'), 'alice+work@example.com')
  const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
  assert.equal(longEmail.length, 254)
  assert.equal(normalizeLoginAccount(longEmail), longEmail)
  for (const account of ['', 'alice', '1380013800', '12800138000', 'a@b', '.alice@example.com', 'alice..test@example.com', 'a@-example.com', 'alice @example.com', longEmail + 'x', null]) {
    assert.throws(() => normalizeLoginAccount(account), /手机号或邮箱/)
  }
  assert.equal(normalizeUsername('Legacy.Admin'), 'legacy.admin')
})

test('local production authentication needs no AI Hub configuration but requires TLS and a session secret', () => {
  const environment = {
    NODE_ENV: 'production', DSH_WORK_AUTH_MODE: 'local',
    DSH_WORK_SESSION_SECRET: '7b5f1e8cab732da68d345daffd5eb76acb12dc23',
    DSH_WORK_WORKBENCH_ORIGINS: 'https://work.corp.internal',
    DSH_WORK_ADMIN_ORIGINS: 'https://admin.corp.internal',
  }
  const config = loadIdentityConfiguration(environment)
  assert.equal(config.mode, 'local')
  assert.equal(config.cookieSecure, true)
  assert.match(config.audiences.admin.sessionCookieName, /^__Host-/)
  assert.notEqual(config.audiences.admin.sessionCookieName, config.audiences.workbench.sessionCookieName)
  assert.throws(() => loadIdentityConfiguration({ ...environment, DSH_WORK_SESSION_SECRET: '' }))
  assert.throws(() => loadIdentityConfiguration({ ...environment, DSH_WORK_COOKIE_SECURE: 'false' }))
  assert.throws(() => loadIdentityConfiguration({ ...environment, DSH_WORK_ADMIN_ORIGINS: 'http://admin.corp.internal' }))
  assert.throws(() => loadIdentityConfiguration({ ...environment, DSH_WORK_AUTH_MODE: 'prototype' }))
  assert.throws(() => loadIdentityConfiguration({ ...environment, DSH_WORK_AUTH_MODE: 'unknown' }))
})

test('passwords are salted and verified without accepting malformed records or normalizing secrets', async () => {
  const password = ' Unit1  '
  const first = await hashPassword(password)
  const second = await hashPassword(password)
  assert.notEqual(first, second)
  assert.equal(first.includes(password), false)
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword(password.trim(), first), false)
  assert.equal(await verifyPassword(password, null), false)
  assert.equal(await verifyPassword(password, first.replace('131072', '999999999')), false)
  assert.throws(() => validatePassword('x'.repeat(7)), /8–64/)
  assert.doesNotThrow(() => validatePassword('x'.repeat(8)))
  assert.doesNotThrow(() => validatePassword('x'.repeat(64)))
  assert.doesNotThrow(() => validatePassword('密'.repeat(64)), 'the limit counts characters, not bytes')
  assert.throws(() => validatePassword('x'.repeat(65)), /8–64/)
  assert.throws(() => validatePassword(null), /8–64/)
  assert.equal(normalizeUsername('  Alice.Example  '), 'alice.example')
  assert.throws(() => normalizeUsername({ username: 'alice' }))
})

test('password derivation queues a bounded burst instead of failing beyond the concurrency limit', async () => {
  const limit = createConcurrencyLimiter(2, 3)
  let active = 0, peak = 0
  const releases: Array<() => void> = []
  const task = (value: number) => limit(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>(resolve => releases.push(resolve))
    active--
    return value
  })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const accepted = [1, 2, 3, 4, 5].map(task)
  await settle()
  assert.equal(releases.length, 2, 'only the concurrency limit runs at once')
  await assert.rejects(task(6), (error: Error & { status?: number; code?: string }) => error.status === 429 && error.code === 'login_busy')
  while (releases.length) {
    releases.shift()!()
    await settle()
  }
  assert.deepEqual(await Promise.all(accepted), [1, 2, 3, 4, 5])
  assert.equal(peak, 2)
  assert.equal(await limit(async () => 'slot released'), 'slot released')
  await assert.rejects(limit(async () => { throw new Error('task failure') }), /task failure/)
  assert.equal(await limit(async () => 'released after failure'), 'released after failure')
})

test('more concurrent password checks than the derivation limit all complete', async () => {
  const stored = await hashPassword('Burst1234')
  const results = await Promise.all(Array.from({ length: 6 }, () => verifyPassword('Burst1234', stored)))
  assert.deepEqual(results, Array(6).fill(true))
})

const startupEnvironment = {
  DSH_WORK_SESSION_SECRET: 'test-startup-session-secret-at-least-32',
  DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180', DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174',
}
const startupHub = {
  AI_HUB_PLATFORM_URL: 'http://localhost:9', AI_HUB_OIDC_ISSUER: 'http://localhost:9/fixture',
  AI_HUB_APPLICATION_ID: 'fixture', AI_HUB_CLIENT_ID: 'fixture', AI_HUB_CLIENT_SECRET: 'fixture-secret',
}
test('startup selects available providers automatically and ignores legacy local/oidc selection', () => {
  for (const DSH_WORK_AUTH_MODE of [undefined, 'local', 'oidc']) {
    assert.equal(loadStartupIdentityConfiguration({ ...startupEnvironment, DSH_WORK_AUTH_MODE }).mode, 'local')
    assert.equal(loadStartupIdentityConfiguration({ ...startupEnvironment, ...startupHub, DSH_WORK_AUTH_MODE }).mode, 'oidc')
  }
})
const legacyStartupEnvironment = {
  ...startupHub, DSH_WORK_SESSION_SECRET: startupEnvironment.DSH_WORK_SESSION_SECRET,
  AI_HUB_WORKBENCH_PORTAL_URL: 'http://localhost:4174', AI_HUB_ADMIN_PORTAL_URL: 'http://localhost:4180',
  AI_HUB_WORKBENCH_REDIRECT_URI: 'http://localhost:4190/auth/workbench/callback',
  AI_HUB_ADMIN_REDIRECT_URI: 'http://localhost:4190/auth/admin/callback',
}
test('startup retains legacy backend callbacks without treating inferred local origins as explicit OIDC origins', () => {
  for (const DSH_WORK_AUTH_MODE of [undefined, 'local', 'oidc']) {
    const config = loadStartupIdentityConfiguration({ ...legacyStartupEnvironment, DSH_WORK_AUTH_MODE })
    assert.equal(config.mode, 'oidc')
    assert.equal(config.audiences.workbench.redirectUriByOrigin['http://localhost:4174'], 'http://localhost:4190/auth/workbench/callback')
    assert.equal(config.audiences.admin.redirectUriByOrigin['http://localhost:4180'], 'http://localhost:4190/auth/admin/callback')
    const local = localIdentityConfiguration(config)
    // 非生产环境会并入 dsh-work-mobile 的开发 origin（:4175），这一步只放宽密码登录入口，
    // 真正的安全约束是下面的后端回调 origin（:4190）不得进入白名单。
    assert.deepEqual(local.audiences.workbench.allowedOrigins, [
      'http://localhost:4174',
      'http://localhost:4175',
      'http://127.0.0.1:4175',
    ])
    assert.deepEqual(local.audiences.admin.allowedOrigins, ['http://localhost:4180'])
    assert.ok(!local.audiences.workbench.allowedOrigins.includes('http://localhost:4190'))
  }
})
test('explicitly conflicting new and legacy origins still disable AI Hub without disabling local login', () => {
  for (const origins of [{ DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174' }, { DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180' }]) {
    const config = loadStartupIdentityConfiguration({ ...legacyStartupEnvironment, ...origins })
    assert.equal(config.mode, 'local')
    assert.match(config.aiHubConfigurationIssue!, /含义不一致/)
    assert.equal(config.audiences.workbench.defaultOrigin, 'http://localhost:4174')
    assert.equal(config.audiences.admin.defaultOrigin, 'http://localhost:4180')
  }
})
test('invalid optional AI Hub configuration preserves password authentication with an actionable issue', () => {
  for (const extra of [{ AI_HUB_CLIENT_SECRET: '' }, { AI_HUB_OIDC_ISSUER: 'not-a-url' }]) {
    const config = loadStartupIdentityConfiguration({ ...startupEnvironment, ...startupHub, ...extra })
    assert.equal(config.mode, 'local')
    assert.ok(config.aiHubConfigurationIssue)
  }
  assert.throws(() => loadStartupIdentityConfiguration({ ...startupEnvironment, DSH_WORK_SESSION_SECRET: '' }))
  assert.throws(() => loadStartupIdentityConfiguration({ ...startupEnvironment, DSH_WORK_ADMIN_ORIGINS: 'not-a-url' }))
})
test('the removed prototype mode is rejected with a migration hint and legacy portal origins remain compatible', () => {
  for (const NODE_ENV of ['development', 'production']) {
    assert.throws(() => loadStartupIdentityConfiguration({ NODE_ENV, DSH_WORK_AUTH_MODE: 'prototype' }), /原型模式已移除/)
    assert.throws(() => loadIdentityConfiguration({ NODE_ENV, DSH_WORK_AUTH_MODE: 'prototype' }), /原型模式已移除/)
  }
  assert.throws(() => loadIdentityConfiguration({}), /未配置/, 'an empty environment no longer falls back to an unauthenticated mode')
  assert.throws(() => loadStartupIdentityConfiguration({ ...startupEnvironment, DSH_WORK_AUTH_MODE: 'unknown' }))
  const config = loadStartupIdentityConfiguration({ ...startupHub, DSH_WORK_SESSION_SECRET: startupEnvironment.DSH_WORK_SESSION_SECRET,
    AI_HUB_ADMIN_PORTAL_URL: 'http://localhost:4180', AI_HUB_WORKBENCH_PORTAL_URL: 'http://localhost:4174',
    AI_HUB_ADMIN_REDIRECT_URI: 'http://localhost:4180/auth/admin/callback', AI_HUB_WORKBENCH_REDIRECT_URI: 'http://localhost:4174/auth/workbench/callback' })
  assert.equal(config.mode, 'oidc')
  assert.equal(config.audiences.admin.defaultOrigin, 'http://localhost:4180')
})
