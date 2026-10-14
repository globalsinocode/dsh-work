import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { availableParallelism } from 'node:os'

import { IdentityAccessError } from './auth-service.ts'
import { normalizeLoginAccount } from './login-account.ts'

// OWASP scrypt baseline. Fixed parameters also bound work when reading a stored hash.
const options = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }

/**
 * Each derivation needs about 128 MiB (128 * N * r), so concurrency stays bounded for memory.
 * A short burst (for example the morning login peak) waits in a bounded queue instead of failing;
 * only a sustained flood beyond the queue is rejected, never an unbounded backlog.
 */
export function createConcurrencyLimiter(concurrency: number, queueLimit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < concurrency) active++
    else {
      if (waiting.length >= queueLimit) throw new IdentityAccessError(429, 'login_busy', '登录请求较多，请稍后重试')
      // The releasing task hands its slot over directly, so `active` stays unchanged.
      await new Promise<void>(resolve => waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

const limitDerivation = createConcurrencyLimiter(
  boundedInteger(process.env.DSH_WORK_PASSWORD_HASH_CONCURRENCY, Math.min(4, Math.max(2, availableParallelism())), 1, 16),
  64,
)

export function normalizeUsername(value: unknown) {
  if (typeof value !== 'string') throw new IdentityAccessError(422, 'invalid_username', '请输入登录账号')
  const username = value.trim().toLowerCase()
  try { return normalizeLoginAccount(username) } catch { /* Keep existing legacy usernames usable. */ }
  if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username)) {
    throw new IdentityAccessError(422, 'invalid_username', '请输入有效的登录账号')
  }
  return username
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 8 || [...value].length > 12) {
    throw new IdentityAccessError(422, 'invalid_password', '密码需为 8–12 个字符')
  }
}

export async function hashPassword(password: unknown) {
  validatePassword(password)
  const salt = randomBytes(16).toString('hex')
  return `scrypt$131072$8$1$${salt}$${(await derive(password, salt)).toString('hex')}`
}

export async function verifyPassword(password: unknown, stored: string | null) {
  // Existing passwords remain usable; length policy applies when setting a password.
  if (typeof password !== 'string' || Buffer.byteLength(password) > 512) return false
  const match = stored?.match(/^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/)
  // Unknown/disabled accounts incur the same expensive derivation as known accounts.
  const actual = await derive(password, match?.[1] ?? '00000000000000000000000000000000')
  const expected = Buffer.from(match?.[2] ?? '0'.repeat(64), 'hex')
  return timingSafeEqual(actual, expected) && Boolean(match)
}

async function derive(password: string, salt: string): Promise<Buffer> {
  return limitDerivation(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 32, options, (error, key) => error ? reject(error) : resolve(key))
  }))
}
