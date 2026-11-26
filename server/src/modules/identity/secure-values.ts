import { createHash, randomBytes } from 'node:crypto'

export function randomOpaque(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function hashOpaque(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
