import type { DingTalkBindingStatus } from '@/types/domain'

/** 绑定失效原因（服务端 revoke_reason）的说明。 */
const revokeReasons: Record<string, string> = {
  admin_unbind: '管理员已解除绑定',
  self_unbind: '本人已解除绑定',
  rebound_to_other: '已改绑到其他员工',
  departed: '钉钉中已不是企业成员',
  account_disabled: '账号已停用',
  admin_password_reset: '管理员重置了密码',
  corp_changed: '钉钉应用换到了其他企业',
}

export function dingtalkRevokeReason(reason: string | null | undefined) {
  return reason ? revokeReasons[reason] ?? '绑定已失效' : '绑定已失效'
}

export const dingtalkStatusLabel: Record<DingTalkBindingStatus, string> = { bound: '已绑定', unbound: '未绑定', invalid: '已失效' }
export const dingtalkStatusTag: Record<DingTalkBindingStatus, 'success' | 'info' | 'danger'> = { bound: 'success', unbound: 'info', invalid: 'danger' }

export function dingtalkBoundBy(boundBy: 'self' | 'admin' | null | undefined, adminName?: string | null) {
  if (boundBy === 'self') return '本人在钉钉内登录'
  if (boundBy === 'admin') return adminName ? `管理员${adminName}代绑` : '管理员代绑'
  return ''
}
