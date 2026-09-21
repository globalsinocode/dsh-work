import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const MAX_BEARER_TOKEN_BYTES = 8192

interface EncryptedCredentialRow {
  algorithm: typeof ALGORITHM
  keyId: string
  ciphertext: Uint8Array
  nonce: Uint8Array
  authTag: Uint8Array
}

export interface EncryptedCredentialStoreConfiguration {
  masterKeyBase64: string
  keyId?: string
}

export class PostgresEncryptedCredentialStore {
  private readonly database: DatabaseClient
  private readonly masterKey: Buffer
  private readonly keyId: string

  constructor(database: DatabaseClient, configuration: EncryptedCredentialStoreConfiguration) {
    this.database = database
    this.masterKey = parseCredentialMasterKey(configuration.masterKeyBase64)
    this.keyId = parseKeyId(configuration.keyId ?? 'v1')
  }

  async create(
    transaction: DatabaseTransaction,
    input: { tenantId: string; credentialRefId: string; bearerToken: string; actorId: string },
  ): Promise<void> {
    const encrypted = this.encrypt(input.tenantId, input.credentialRefId, input.bearerToken)
    await transaction`
      insert into credential_secrets (
        tenant_id, credential_ref_id, algorithm, key_id, version,
        ciphertext, nonce, auth_tag, created_by, updated_by
      ) values (
        ${input.tenantId}, ${input.credentialRefId}, ${ALGORITHM}, ${this.keyId}, 1,
        ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.authTag}, ${input.actorId}, ${input.actorId}
      )
    `
  }

  async rotate(
    transaction: DatabaseTransaction,
    input: { tenantId: string; credentialRefId: string; bearerToken: string; actorId: string },
  ): Promise<void> {
    const encrypted = this.encrypt(input.tenantId, input.credentialRefId, input.bearerToken)
    const result = await transaction<{ credentialRefId: string }[]>`
      update credential_secrets
         set algorithm = ${ALGORITHM}, key_id = ${this.keyId}, version = version + 1,
             ciphertext = ${encrypted.ciphertext}, nonce = ${encrypted.nonce}, auth_tag = ${encrypted.authTag},
             updated_by = ${input.actorId}, rotated_at = now(), updated_at = now()
       where tenant_id = ${input.tenantId} and credential_ref_id = ${input.credentialRefId}
       returning credential_ref_id as "credentialRefId"
    `
    if (!result[0]) throw new Error('Bearer 凭据不存在，不能轮换')
  }

  async readBearerToken(tenantId: string, credentialRefId: string): Promise<string> {
    const [row] = await this.database<EncryptedCredentialRow[]>`
      select algorithm, key_id as "keyId", ciphertext, nonce, auth_tag as "authTag"
        from credential_secrets
       where tenant_id = ${tenantId} and credential_ref_id = ${credentialRefId}
    `
    if (!row) throw new Error('MCP Bearer 凭据未配置')
    if (row.algorithm !== ALGORITHM || row.keyId !== this.keyId) {
      throw new Error(`MCP Bearer 凭据使用了当前服务无法解密的密钥版本：${row.keyId}`)
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, Buffer.from(row.nonce), { authTagLength: AUTH_TAG_BYTES })
      decipher.setAAD(credentialAad(tenantId, credentialRefId))
      decipher.setAuthTag(Buffer.from(row.authTag))
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('MCP Bearer 凭据无法通过完整性校验')
    }
  }

  private encrypt(tenantId: string, credentialRefId: string, bearerToken: string) {
    const token = normalizeBearerToken(bearerToken)
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.masterKey, nonce, { authTagLength: AUTH_TAG_BYTES })
    cipher.setAAD(credentialAad(tenantId, credentialRefId))
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return { ciphertext, nonce, authTag: cipher.getAuthTag() }
  }
}

export function parseCredentialMasterKey(value: string | undefined): Buffer {
  if (!value?.trim()) {
    throw new Error('DSH_CREDENTIAL_MASTER_KEY 未配置；生产与开发环境均需要 32 字节 Base64 主密钥')
  }
  const normalized = value.trim()
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
    throw new Error('DSH_CREDENTIAL_MASTER_KEY 必须是规范的 32 字节 Base64 值')
  }
  const key = Buffer.from(normalized, 'base64')
  if (key.length !== 32 || key.toString('base64') !== normalized) {
    throw new Error('DSH_CREDENTIAL_MASTER_KEY 必须是规范的 32 字节 Base64 值')
  }
  return key
}

export function normalizeBearerToken(value: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_BEARER_TOKEN_BYTES || /\s/.test(value)) {
    throw new Error('Bearer Token 必须为 1-8192 字节且不能包含空白字符')
  }
  return value
}

function parseKeyId(value: string) {
  const keyId = value.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('凭据主密钥版本标识格式无效')
  return keyId
}

function credentialAad(tenantId: string, credentialRefId: string) {
  return Buffer.from(`dsh-work:mcp-bearer:v1:${tenantId}:${credentialRefId}`, 'utf8')
}
