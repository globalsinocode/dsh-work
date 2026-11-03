import { invalidRequest } from '../../../domain/request-errors.ts'
import { previewText } from './conversation-targets.ts'

/** 私聊正文与员工发给 Agent 的消息上限相同。 */
export const directMessageMaxLength = 20_000

export interface DirectPair {
  userLow: string
  userHigh: string
}

/**
 * 两人的稳定配对键。用户 id 按字符串升序放入，保证同一对同事只有一条私聊。
 */
export function directPair(actorUserId: string, peerUserId: string): DirectPair {
  const actor = actorUserId.trim()
  const peer = peerUserId.trim()
  if (!actor || !peer) throw invalidRequest('用户标识无效')
  if (actor === peer) throw invalidRequest('不能和自己私聊')
  return actor < peer ? { userLow: actor, userHigh: peer } : { userLow: peer, userHigh: actor }
}

/** 去首尾空白后的纯文本。空白或超长拒绝。 */
export function requireDirectContent(raw: unknown): string {
  if (typeof raw !== 'string') throw invalidRequest('消息内容必须是文本')
  const content = raw.trim()
  if (!content) throw invalidRequest('消息内容不能为空')
  if (content.length > directMessageMaxLength) throw invalidRequest(`消息长度必须为 1～${directMessageMaxLength} 个字符`)
  return content
}

export function directPreview(content: string) {
  return previewText(content)
}
