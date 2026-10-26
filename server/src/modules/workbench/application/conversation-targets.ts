import { invalidRequest } from '../../../domain/request-errors.ts'

/**
 * 协作模式的对话对象（项目空间方案 12.6，D24～D26）：列表的一行是一个对话对象——与某个
 * AI 同事的单聊（本人的个人会话按 Agent 聚合）或一个群组（本人所在的项目空间）——而不是
 * 一个 Session。只读取本人可读的内容；续写与开启会话仍走既有 createSession / startRun。
 */

export type ConversationTargetType = 'agent' | 'group'

export interface ConversationMessagePreview {
  role: 'user' | 'assistant'
  /** 人员消息为发送者姓名，Agent 回复为 Agent 名称。 */
  authorName: string
  /** 截断后的纯文本，最长 120 字。 */
  text: string
  sentAt: string
}

export interface ConversationTarget {
  type: ConversationTargetType
  /** 单聊为 Agent ID，群组为项目空间 ID。 */
  id: string
  name: string
  /** 单聊：AI 同事的岗位说明；群组：空间说明。 */
  description: string
  /** 头像拼图用的名称（群组为最多 4 位员工），单聊为 AI 同事名称。 */
  avatarNames: string[]
  lastMessage: ConversationMessagePreview | null
  lastActiveAt: string
  /** 单聊：AI 同事当前是否可用（不可用时历史仍可读）；群组恒为 true。 */
  available: boolean
  /** 已读位置之后他人发送的消息数（本人发送的不计），最多计到 `unreadCountCap`（S5e）。 */
  unreadCount: number
  /** 群组已按空间静音（3.7）：未读照常计数，列表以弱化样式显示；单聊恒为 false。 */
  muted: boolean
}

export const unreadCountCap = 100

export interface ConversationReadState {
  type: ConversationTargetType
  id: string
  lastReadAt: string
}

export interface ConversationTargetPage {
  items: ConversationTarget[]
  nextCursor: string | null
}

export interface AgentConversationSegment {
  sessionId: string
  title: string
  createdAt: string
  lastActiveAt: string
  /** 会话固定的 Agent 版本号（一个 Session 固定一个 Agent 版本）。 */
  agentVersion: string
  runCount: number
  latestRun: { id: string; status: string } | null
}

export interface AgentConversation {
  agent: {
    id: string
    name: string
    description: string
    /** 当前发布版本号；AI 同事已不可用时为最近一次对话使用的版本。 */
    version: string
    available: boolean
  }
  items: AgentConversationSegment[]
  nextCursor: string | null
  /**
   * 发送消息时续写的会话：只有最近一段会话且其 Agent 版本等于当前版本时给出；
   * null 表示发送时由平台开启新会话（首次对话、版本已变化），AI 同事不可用时不能发送。
   */
  continueSessionId: string | null
}

export type ConversationLocation =
  | { type: 'agent'; agentId: string; sessionId: string }
  | { type: 'group'; workspaceId: string; sessionId: string }

export interface ConversationTargetStore {
  listTargets(input: { userId: string; roleIds: string[]; query?: string; cursor?: string; limit?: number }): Promise<ConversationTargetPage>
  getAgentConversation(input: { userId: string; roleIds: string[]; agentId: string; cursor?: string; limit?: number }): Promise<AgentConversation>
  resolveConversation(input: { userId: string; conversationId: string }): Promise<ConversationLocation>
  /** 把本人在该对话对象的已读位置前进到 `upTo`（缺省或晚于当前时间按当前时间），只进不退。 */
  markRead(input: { userId: string; type: ConversationTargetType; id: string; upTo?: Date }): Promise<ConversationReadState>
}

export const previewLength = 120

export function previewText(content: string) {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length > previewLength ? `${text.slice(0, previewLength - 1)}…` : text
}

export function parseTargetLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback
  if (!/^[0-9]{1,3}$/.test(raw)) throw invalidRequest('limit 必须是 1 到 100 之间的整数')
  const value = Number(raw)
  if (value < 1 || value > 100) throw invalidRequest('limit 必须是 1 到 100 之间的整数')
  return value
}

export function parseTargetQuery(raw: string | null): string | undefined {
  const query = raw?.trim() ?? ''
  if (query.length > 100) throw invalidRequest('搜索关键词不能超过 100 个字符')
  return query || undefined
}

/** 游标：最近活动时间（微秒精度的 UTC 文本）+ 对象类型 + ID，按 (时间 desc, 类型, ID) 排序。 */
export function encodeTargetCursor(lastActiveAt: string, type: string, id: string) {
  return Buffer.from(JSON.stringify([lastActiveAt, type, id]), 'utf8').toString('base64url')
}

export function decodeTargetCursor(cursor: string): { lastActiveAt: string; type: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'string')
      && !Number.isNaN(Date.parse(value[0] as string))) {
      return { lastActiveAt: value[0] as string, type: value[1] as string, id: value[2] as string }
    }
  } catch {
    // fall through
  }
  throw invalidRequest('cursor 无效，请从第一页重新加载')
}
