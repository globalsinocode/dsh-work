/**
 * D38：输入框里 @ 的对象分两类——Agent 成员（发起执行）与同事（只登记站内提醒）。同事的候选 id
 * 加 `user:` 前缀，与 Agent 成员关联 id 分开，提交时再按前缀拆回用户 id。
 */
export interface MentionOption {
  id: string
  name: string
  kind?: 'agent' | 'member'
}

const memberPrefix = 'user:'

/** 群内同事的 @ 候选：现任成员中除本人以外的人。 */
export function colleagueMentionOptions(
  members: Array<{ userId: string; displayName: string }>,
  selfUserId: string,
): MentionOption[] {
  return members
    .filter(member => member.userId !== selfUserId)
    .map(member => ({ id: `${memberPrefix}${member.userId}`, name: member.displayName, kind: 'member' as const }))
}

/** 把提交的提及拆成 Agent 成员 id（按出现顺序）与同事的用户 id。 */
export function splitMentions(mentions: string[] | undefined) {
  const agentMemberIds: string[] = []
  const userIds: string[] = []
  for (const id of mentions ?? []) {
    if (id.startsWith(memberPrefix)) userIds.push(id.slice(memberPrefix.length))
    else agentMemberIds.push(id)
  }
  return { agentMemberIds, userIds }
}

/** 消息是否 @ 了当前用户。 */
export function mentionsUser(message: { mentionedUserIds?: string[] | null }, userId: string) {
  return Boolean(userId && message.mentionedUserIds?.includes(userId))
}
