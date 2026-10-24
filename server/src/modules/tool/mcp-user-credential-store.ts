import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { invalidRequest } from '../../domain/request-errors.ts'
import { parseCredentialMasterKey } from './postgres-encrypted-credential-store.ts'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

export interface McpUserTokenPair {
  accessToken: string
  refreshToken: string | null
  accessExpiresAt: string | null
}

export class McpUserCredentialStore {
  private readonly masterKey: Buffer
  private readonly keyId: string

  constructor(masterKeyBase64: string, keyId = 'v1') {
    this.masterKey = parseCredentialMasterKey(masterKeyBase64)
    this.keyId = parseKeyId(keyId)
  }

  currentKeyId() {
    return this.keyId
  }

  seal(input: { tenantId: string; credentialRefId: string; userId: string; tokens: McpUserTokenPair }): {
    ciphertext: Buffer
    nonce: Buffer
    authTag: Buffer
    keyId: string
  } {
    const plaintext = Buffer.from(JSON.stringify(input.tokens), 'utf8')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.masterKey, nonce, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(mcpUserGrantAad(input.tenantId, input.credentialRefId, input.userId))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyId: this.keyId }
  }

  open(input: {
    tenantId: string
    credentialRefId: string
    userId: string
    ciphertext: Buffer
    nonce: Buffer
    authTag: Buffer
    keyId: string
  }): McpUserTokenPair {
    if (input.keyId !== this.keyId) {
      throw new Error(`MCP 用户凭据使用了当前服务无法解密的密钥版本：${input.keyId}`)
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, input.nonce, { authTagLength: AUTH_TAG_BYTES })
      decipher.setAAD(mcpUserGrantAad(input.tenantId, input.credentialRefId, input.userId))
      decipher.setAuthTag(input.authTag)
      const plaintext = Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8')
      return JSON.parse(plaintext) as McpUserTokenPair
    } catch {
      throw new Error('MCP 用户凭据无法通过完整性校验')
    }
  }
}

function parseKeyId(value: string) {
  const keyId = value.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw invalidRequest('凭据主密钥版本标识格式无效')
  return keyId
}

function mcpUserGrantAad(tenantId: string, credentialRefId: string, userId: string) {
  return Buffer.from(`dsh-work:mcp-user-grant:v1:${tenantId}:${credentialRefId}:${userId}`, 'utf8')
}
