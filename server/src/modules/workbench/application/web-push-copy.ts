import type { ConversationTargetType } from './conversation-targets.ts'

const bodyMaxLength = 120

export type PushPayloadType = 'collab_unread' | 'run_finished'

export type RunFinishedStatus = 'succeeded' | 'failed' | 'awaiting_approval'

export interface CollabUnreadPushPayload {
  eventId: string
  type: 'collab_unread'
  tag: string
  title: string
  body: string
  url: string
  sessionId: string
  targetType: ConversationTargetType
  targetId: string
}

export interface RunFinishedPushPayload {
  eventId: string
  type: 'run_finished'
  tag: string
  title: string
  body: string
  url: string
  sessionId: string
  targetType: ConversationTargetType
  targetId: string
  runId: string
  runStatus: RunFinishedStatus
}

export interface BuildCollabUnreadInput {
  eventId: string
  targetType: ConversationTargetType
  targetId: string
  sessionId: string
  workspaceId?: string
  title: string
  previewText: string
  senderName: string
  agentName?: string
  role: 'user' | 'assistant'
}

export interface BuildRunFinishedInput {
  eventId: string
  runId: string
  runStatus: RunFinishedStatus
  sessionId: string
  sessionTitle?: string
  targetType: ConversationTargetType
  targetId: string
  workspaceId?: string
}

export interface CollabUnreadRecipientInput {
  role: 'user' | 'assistant'
  authorUserId: string | null
  requestedBy: string | null
  participantUserIds: string[]
  muted: boolean
}

export function truncatePushBody(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= bodyMaxLength) return trimmed
  return `${trimmed.slice(0, bodyMaxLength)}…`
}

function conversationUrl(input: {
  targetType: ConversationTargetType
  sessionId: string
  workspaceId?: string
}): string {
  if (input.targetType === 'group') {
    if (!input.workspaceId) throw new Error('group push requires workspaceId')
    return `/workspaces/${input.workspaceId}?session=${input.sessionId}`
  }
  return `/chat/${input.sessionId}`
}

export function buildCollabUnreadPayload(input: BuildCollabUnreadInput): CollabUnreadPushPayload {
  const tag = `collab:${input.targetType}:${input.targetId}`
  const url = input.targetType === 'group'
    ? `/workspaces/${input.workspaceId}?session=${input.sessionId}`
    : `/chat/${input.sessionId}`

  let body: string
  if (input.targetType === 'agent') {
    const preview = input.previewText.trim()
    body = preview.length > 0 ? preview : '发来一条新消息'
  } else {
    const sender = input.role === 'assistant'
      ? (input.agentName?.trim() || input.senderName.trim() || 'AI 同事')
      : input.senderName.trim()
    const preview = input.previewText.trim()
    body = preview.length > 0 ? `${sender}：${preview}` : `${sender}：发来一条新消息`
  }

  return {
    eventId: input.eventId,
    type: 'collab_unread',
    tag,
    title: input.title.trim(),
    body: truncatePushBody(body),
    url,
    sessionId: input.sessionId,
    targetType: input.targetType,
    targetId: input.targetId,
  }
}

export function buildRunFinishedPayload(input: BuildRunFinishedInput): RunFinishedPushPayload {
  const tag = `run:${input.runId}`
  const url = conversationUrl({
    targetType: input.targetType,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  })
  const sessionTitle = input.sessionTitle?.trim() ?? ''

  let title: string
  let body: string
  if (input.runStatus === 'succeeded') {
    title = '任务已完成'
    body = sessionTitle.length > 0 ? sessionTitle : '可以回到对话查看结果'
  } else if (input.runStatus === 'failed') {
    title = '任务未完成'
    body = sessionTitle.length > 0 ? sessionTitle : '可以回到对话查看原因'
  } else {
    title = '有待确认的操作'
    body = sessionTitle.length > 0 ? sessionTitle : '打开对话后可以允许或拒绝'
  }

  return {
    eventId: input.eventId,
    type: 'run_finished',
    tag,
    title,
    body: truncatePushBody(body),
    url,
    sessionId: input.sessionId,
    targetType: input.targetType,
    targetId: input.targetId,
    runId: input.runId,
    runStatus: input.runStatus,
  }
}

export function collabUnreadRecipientIds(input: CollabUnreadRecipientInput): string[] {
  if (input.muted) return []
  const excluded = input.role === 'assistant' ? input.requestedBy : input.authorUserId
  return input.participantUserIds.filter((userId) => userId !== excluded)
}

export function runFinishedRecipientIds(input: {
  requestedBy: string
  runStatus: RunFinishedStatus | 'cancelled'
}): string[] {
  if (input.runStatus === 'cancelled') return []
  return [input.requestedBy]
}
