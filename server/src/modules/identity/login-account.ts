import { IdentityAccessError } from './request-security.ts'
import { classifyLoginAccount } from '../../domain/login-account-kind.ts'

/** New local accounts use a mainland mobile number or an ordinary email address. */
export function normalizeLoginAccount(value: unknown): string {
  if (typeof value !== 'string') throw new IdentityAccessError(422, 'invalid_username', '请输入手机号或邮箱')
  const classified = classifyLoginAccount(value)
  if (classified) return classified.value
  throw new IdentityAccessError(422, 'invalid_username', '请输入有效的手机号或邮箱（手机号为中国大陆 11 位，可带 +86）')
}

export function loginAccountCandidates(account: string) {
  return /^1[3-9]\d{9}$/.test(account) ? [account, `+86${account}`] : [account]
}
