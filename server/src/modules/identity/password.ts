import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

import { IdentityAccessError } from './auth-service.ts'

// OWASP scrypt baseline. Fixed parameters also bound work when reading a stored hash.
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }
let activeHashes = 0

export function normalizeUsername(value: unknown) {
  if (typeof value !== 'string') throw new IdentityAccessError(422, 'invalid_username', '请输入登录账号')
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) {
    throw new IdentityAccessError(422, 'invalid_username', '账号需为 3–80 位字母、数字或 . _ @ -，并以字母或数字开头')
  }
  return username
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || Buffer.byteLength(value) > 512) {
    throw new IdentityAccessError(422, 'invalid_password', '密码需为 15–128 个字符，可使用长句作为密码')
  }
}

export async function hashPassword(password: unknown) {
  validatePassword(password)
  const salt = randomBytes(16).toString('hex')
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`
}

export async function verifyPassword(password: unknown, stored: string | null) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 512) return false
  const match = stored?.match(/^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/)
  // Unknown/disabled accounts incur the same expensive derivation as known accounts.
  const actual = await derive(password, match?.[1] ?? '00000000000000000000000000000000')
  const expected = Buffer.from(match?.[2] ?? '0'.repeat(64), 'hex')
  return timingSafeEqual(actual, expected) && Boolean(match)
}

async function derive(password: string, salt: string): Promise<Buffer> {
  // Avoid an unbounded memory/CPU queue under concurrent unauthenticated requests.
  if (activeHashes >= 2) throw new IdentityAccessError(429, 'login_busy', '登录请求较多，请稍后重试')
  activeHashes++
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, 'hex'), 32, options, (error, key) => error ? reject(error) : resolve(key))
    })
  } finally {
    activeHashes--
  }
}
