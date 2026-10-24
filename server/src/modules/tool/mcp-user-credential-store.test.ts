import assert from 'node:assert/strict'
import { test } from 'node:test'

import { McpUserCredentialStore } from './mcp-user-credential-store.ts'

/** 32 字节全零主密钥的规范 Base64，仅用于单测 */
const TEST_MASTER_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('seal 后换 userId 打开会完整性失败，同一 userId 可读回 accessToken', () => {
  const store = new McpUserCredentialStore(TEST_MASTER_KEY_BASE64)
  const tenantId = 'tenant-a'
  const credentialRefId = 'cred-ref-1'
  const userId = 'user-alice'
  const tokens = {
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    accessExpiresAt: '2026-10-24T12:00:00.000Z',
  }

  const sealed = store.seal({ tenantId, credentialRefId, userId, tokens })

  assert.throws(
    () =>
      store.open({
        tenantId,
        credentialRefId,
        userId: 'user-bob',
        ...sealed,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'MCP 用户凭据无法通过完整性校验')
      return true
    },
  )

  const opened = store.open({ tenantId, credentialRefId, userId, ...sealed })
  assert.equal(opened.accessToken, tokens.accessToken)
  assert.equal(opened.refreshToken, tokens.refreshToken)
  assert.equal(opened.accessExpiresAt, tokens.accessExpiresAt)
})

test('seal 后换 credentialRefId 打开会完整性失败', () => {
  const store = new McpUserCredentialStore(TEST_MASTER_KEY_BASE64)
  const sealed = store.seal({
    tenantId: 'tenant-a',
    credentialRefId: 'cred-ref-1',
    userId: 'user-alice',
    tokens: { accessToken: 'tok', refreshToken: null, accessExpiresAt: null },
  })

  assert.throws(
    () =>
      store.open({
        tenantId: 'tenant-a',
        credentialRefId: 'cred-ref-other',
        userId: 'user-alice',
        ...sealed,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'MCP 用户凭据无法通过完整性校验')
      return true
    },
  )
})
