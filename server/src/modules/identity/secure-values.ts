import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { invalidRequest } from '../../domain/request-errors.ts'

export function randomOpaque(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function hashOpaque(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function equalOpaqueHash(value: string, expectedHash: string) {
  const actual = Buffer.from(hashOpaque(value), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class SecretBox {
  private readonly key: Buffer

  constructor(secret: string) {
    this.key = createHash('sha256').update(secret, 'utf8').digest()
  }

  seal(value: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  open(value: string) {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split('.')
    if (version !== 'v1' || !encodedIv || !encodedTag || encodedCiphertext === undefined || extra !== undefined) {
      throw invalidRequest('加密会话值格式无效')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'))
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }
}
