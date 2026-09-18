import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { IdentitySessionRepository } from '../../modules/identity/session-repository.ts'

let db: ThrowawayDatabase, repository: IdentitySessionRepository
before(async () => {
  db = await createThrowawayDatabase({ namePrefix: 'dsh_review_c10' })
  repository = new IdentitySessionRepository(db.client)
})
after(async () => { await db?.dispose() })
test('login purpose is persisted server-side, defaults to login, and is consumed once', async () => {
  for (const loginPurpose of [undefined, 'admin-bootstrap'] as const) {
    const id = randomUUID()
    await repository.createLoginTransaction({ transactionHash: id, audience: 'admin', stateHash: 'state',
      codeVerifierEncrypted: 'test-only', nonce: 'nonce', returnTo: '/', portalOrigin: 'http://localhost:4180',
      redirectUri: 'http://localhost:4180/auth/admin/callback', expiresAt: new Date(Date.now() + 60000), loginPurpose })
    assert.equal((await repository.consumeLoginTransaction(id, 'admin'))?.loginPurpose, loginPurpose ?? 'login')
    assert.equal(await repository.consumeLoginTransaction(id, 'admin'), null)
  }
})
test('workbench transactions cannot persist bootstrap intent', async () => {
  await assert.rejects(repository.createLoginTransaction({ transactionHash: randomUUID(), audience: 'workbench',
    stateHash: 'state', codeVerifierEncrypted: 'test-only', nonce: 'nonce', returnTo: '/',
    portalOrigin: 'http://localhost:4174', redirectUri: 'http://localhost:4174/auth/workbench/callback',
    expiresAt: new Date(Date.now() + 60000), loginPurpose: 'admin-bootstrap' }), /check constraint/)
})
test('claim consumption is concurrent/idempotent and a zero-admin state never reopens the ledger', async () => {
  const applicationId = `test-${randomUUID()}`
  assert.equal(await repository.hasConsumedAdminBootstrap(applicationId, 'local'), false)
  const claim = { applicationId, environment: 'local', externalUserId: 'external-fixture', userId: 'U00008', consumedAt: new Date() }
  const results = await Promise.all([repository.consumeAdminBootstrap(claim), repository.consumeAdminBootstrap(claim)])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await repository.hasConsumedAdminBootstrap(applicationId, 'local'), true)
  assert.equal(await repository.hasConsumedAdminBootstrap(applicationId, 'other-environment'), false)
  await db.client`delete from user_roles where tenant_id = 'tenant-dsh-work' and role_id = 'role-platform-admin'`
  assert.equal(await repository.hasConsumedAdminBootstrap(applicationId, 'local'), true)
  assert.equal(await repository.consumeAdminBootstrap(claim), false)
  const [grants] = await db.client<{ count: number }[]>`select count(*)::integer as count from user_roles where role_id = 'role-platform-admin'`
  assert.equal(grants?.count, 0)
  await assert.rejects(repository.consumeAdminBootstrap({ ...claim, userId: 'U00001', externalUserId: 'other' }), /其他账号/)
})
