import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadIdentityConfiguration } from './config.ts'
import { hashPassword, normalizeUsername, validatePassword, verifyPassword } from './password.ts'

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
  const password = 'a long test passphrase  '
  const first = await hashPassword(password)
  const second = await hashPassword(password)
  assert.notEqual(first, second)
  assert.equal(first.includes(password), false)
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword(password.trim(), first), false)
  assert.equal(await verifyPassword(password, null), false)
  assert.equal(await verifyPassword(password, first.replace('131072', '999999999')), false)
  assert.throws(() => validatePassword('short'))
  assert.throws(() => validatePassword('x'.repeat(129)))
  assert.equal(normalizeUsername('  Alice.Example  '), 'alice.example')
  assert.throws(() => normalizeUsername({ username: 'alice' }))
})
