/**
 * 本地登录账号的种类判定（手机号或邮箱）。登录（`normalizeLoginAccount`）与外部应用调用上下文
 * （`mcpCallContextHeaders`）共用这一规则，避免两处判定不一致。
 */
const mobilePattern = /^(?:\+86)?(1[3-9]\d{9})$/
const emailLocalPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type LoginAccountKind = { kind: 'mobile'; value: string } | { kind: 'email'; value: string }

/** 手机号返回去掉 `+86` 的 11 位号码，邮箱返回小写地址；都不是（如旧账号名）返回 null。 */
export function classifyLoginAccount(value: string): LoginAccountKind | null {
  const account = value.trim().toLowerCase()
  const mobile = account.match(mobilePattern)?.[1]
  if (mobile) return { kind: 'mobile', value: mobile }
  const parts = account.split('@')
  const local = parts[0] ?? ''
  const domain = parts[1] ?? ''
  if (parts.length === 2 && account.length <= 254 && local.length <= 64 && emailLocalPattern.test(local)
    && domain.includes('.') && domain.split('.').every(label => domainLabelPattern.test(label))) return { kind: 'email', value: account }
  return null
}
