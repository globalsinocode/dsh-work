import { IdentityAccessError } from './auth-service.ts'

const mobilePattern = /^(?:\+86)?1[3-9]\d{9}$/
const emailLocalPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** New local accounts use a mainland mobile number or an ordinary email address. */
export function normalizeLoginAccount(value: unknown): string {
  if (typeof value !== 'string') throw new IdentityAccessError(422, 'invalid_username', '请输入手机号或邮箱')
  const account = value.trim().toLowerCase()
  if (mobilePattern.test(account)) return account.replace(/^\+86/, '')
  const parts = account.split('@')
  const local = parts[0] ?? ''
  const domain = parts[1] ?? ''
  if (parts.length === 2 && account.length <= 254 && local.length <= 64 && emailLocalPattern.test(local)
    && domain.includes('.') && domain.split('.').every(label => domainLabelPattern.test(label))) return account
  throw new IdentityAccessError(422, 'invalid_username', '请输入有效的手机号或邮箱（手机号为中国大陆 11 位，可带 +86）')
}

export function loginAccountCandidates(account: string) {
  return /^1[3-9]\d{9}$/.test(account) ? [account, `+86${account}`] : [account]
}
