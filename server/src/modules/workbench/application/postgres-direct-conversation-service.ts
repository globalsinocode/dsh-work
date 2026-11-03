import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import { invalidRequest, notFound } from '../../../domain/request-errors.ts'
import { parseTargetLimit } from './conversation-targets.ts'
import { directPair, directPreview, requireDirectContent } from './direct-conversations.ts'
import { getWebPushDispatch } from './web-push-dispatch.ts'
import { workbenchAccessPredicate } from './postgres-workspace-member-service.ts'

const tenantId = 'tenant-dsh-work'
const unreadCap = 100

export interface DirectPeer {
  id: string
  displayName: string
}

export interface DirectConversationLookup {
  peer: DirectPeer
  conversationId: string | null
  canSend: boolean
}

export interface DirectMessage {
  id: string
  conversationId: string
  senderUserId: string
  senderName: string
  content: string
  createdAt: string
}

export interface DirectMessagePage {
  items: DirectMessage[]
  nextCursor: string | null
}

export interface DirectConversationListItem {
  type: 'peer'
  id: string
  conversationId: string
  name: string
  lastMessage: { authorName: string; text: string; sentAt: string }
  lastActiveAt: string
  canSend: boolean
  unreadCount: number
}

export interface DirectConversationPage {
  items: DirectConversationListItem[]
  nextCursor: string | null
}

export interface DirectReadState {
  userId: string
  lastReadAt: string
}

interface ColleagueRow {
  id: string
  displayName: string
  status: string
  canSend: boolean
}

/**
 * 同事一对一私聊。消息不进入 sessions，发送不创建 Run。
 * 列表与 `GET /me/conversation-targets` 分开，避免 PC 员工端把对方当成群组。
 */
export class PostgresDirectConversationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async list(input: { userId: string; cursor?: string; limit?: number }): Promise<DirectConversationPage> {
    const limit = input.limit ?? 30
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    const rows = await this.database<ListRow[]>`
      select c.id as "conversationId",
             c.last_message_at as "lastActiveAt",
             peer.id as "peerId",
             peer.display_name as "peerName",
             (peer.status = 'active' and peer.business_user and exists (${this.database.unsafe(workbenchAccessPredicate.replaceAll('u.', 'peer.'))})) as "canSend",
             m.content as "content",
             m.created_at as "sentAt",
             author.display_name as "authorName",
             least((
               select count(*)::int
                 from direct_messages unread
                where unread.tenant_id = c.tenant_id
                  and unread.conversation_id = c.id
                  and unread.sender_user_id <> ${input.userId}
                  and (read_state.last_read_at is null or unread.created_at > read_state.last_read_at)
             ), ${unreadCap}) as "unreadCount"
        from direct_conversations c
        join direct_conversation_participants self
          on self.tenant_id = c.tenant_id
         and self.conversation_id = c.id
         and self.user_id = ${input.userId}
        join users peer
          on peer.tenant_id = c.tenant_id
         and peer.id = case when c.user_low = ${input.userId} then c.user_high else c.user_low end
        join lateral (
          select content, created_at, sender_user_id
            from direct_messages
           where tenant_id = c.tenant_id and conversation_id = c.id
           order by created_at desc, id desc
           limit 1
        ) m on true
        join users author on author.tenant_id = c.tenant_id and author.id = m.sender_user_id
        left join conversation_read_states read_state
          on read_state.tenant_id = c.tenant_id
         and read_state.user_id = ${input.userId}
         and read_state.target_type = 'peer'
         and read_state.target_id = peer.id
       where c.tenant_id = ${tenantId}
         and (
           self.hidden_at is null
           or exists (
             select 1 from direct_messages incoming
              where incoming.tenant_id = c.tenant_id
                and incoming.conversation_id = c.id
                and incoming.sender_user_id <> ${input.userId}
                and incoming.created_at > self.hidden_at
           )
         )
         and ${cursor === null
           ? this.database`true`
           : this.database`(c.last_message_at < ${cursor.at} or (c.last_message_at = ${cursor.at} and c.id < ${cursor.id}))`}
       order by c.last_message_at desc, c.id desc
       limit ${limit + 1}
    `
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      items: page.map(row => ({
        type: 'peer',
        id: row.peerId,
        conversationId: row.conversationId,
        name: row.peerName,
        lastMessage: {
          authorName: row.authorName,
          text: directPreview(row.content),
          sentAt: row.sentAt.toISOString(),
        },
        lastActiveAt: row.lastActiveAt.toISOString(),
        canSend: row.canSend,
        unreadCount: row.unreadCount,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.lastActiveAt, last.conversationId) : null,
    }
  }

  async lookup(input: { userId: string; peerUserId: string }): Promise<DirectConversationLookup> {
    const peer = await this.requirePeer(input.userId, input.peerUserId, { allowExisting: true })
    const pair = directPair(input.userId, peer.id)
    const [row] = await this.database<{ id: string }[]>`
      select id from direct_conversations
       where tenant_id = ${tenantId} and user_low = ${pair.userLow} and user_high = ${pair.userHigh}
    `
    return {
      peer: { id: peer.id, displayName: peer.displayName },
      conversationId: row?.id ?? null,
      canSend: peer.canSend,
    }
  }

  async listMessages(input: { userId: string; conversationId: string; cursor?: string; limit?: number }): Promise<DirectMessagePage> {
    await this.requireParticipant(input.conversationId, input.userId)
    const limit = input.limit ?? 30
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    const rows = await this.database<MessageRow[]>`
      select m.id, m.conversation_id as "conversationId", m.sender_user_id as "senderUserId",
             u.display_name as "senderName", m.content, m.created_at as "createdAt"
        from direct_messages m
        join users u on u.tenant_id = m.tenant_id and u.id = m.sender_user_id
       where m.tenant_id = ${tenantId}
         and m.conversation_id = ${input.conversationId}
         and ${cursor === null
           ? this.database`true`
           : this.database`(m.created_at < ${cursor.at} or (m.created_at = ${cursor.at} and m.id < ${cursor.id}))`}
       order by m.created_at desc, m.id desc
       limit ${limit + 1}
    `
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).reverse()
    const oldest = page[0]
    return {
      items: page.map(toMessage),
      nextCursor: hasMore && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
    }
  }

  async send(input: { userId: string; peerUserId: string; content: unknown }): Promise<DirectMessage> {
    const content = requireDirectContent(input.content)
    const peer = await this.requirePeer(input.userId, input.peerUserId, { allowExisting: false })
    if (!peer.canSend) throw invalidRequest('对方账号已停用')
    const pair = directPair(input.userId, peer.id)
    const message = await this.database.begin(async (transaction) => {
      const conversationId = await ensureConversation(transaction, pair, input.userId)
      const [created] = await transaction<MessageRow[]>`
        insert into direct_messages (id, tenant_id, conversation_id, sender_user_id, content)
        values (${`dmsg-${randomUUID()}`}, ${tenantId}, ${conversationId}, ${input.userId}, ${content})
        returning id, conversation_id as "conversationId", sender_user_id as "senderUserId",
                  content, created_at as "createdAt"
      `
      if (!created) throw new Error('direct message was not inserted')
      const [sender] = await transaction<{ displayName: string }[]>`
        select display_name as "displayName" from users where tenant_id = ${tenantId} and id = ${input.userId}
      `
      created.senderName = sender?.displayName ?? ''
      await transaction`
        update direct_conversations
           set last_message_at = ${created.createdAt}
         where tenant_id = ${tenantId} and id = ${conversationId}
      `
      await transaction`
        update direct_conversation_participants
           set hidden_at = null
         where tenant_id = ${tenantId}
           and conversation_id = ${conversationId}
           and user_id = ${peer.id}
           and hidden_at is not null
           and hidden_at < ${created.createdAt}
      `
      return created
    })
    getWebPushDispatch()?.enqueueDirectMessagePush(message.id)
    return toMessage(message)
  }

  async markRead(input: { userId: string; peerUserId: string; upTo?: Date }): Promise<DirectReadState> {
    const peer = await this.requirePeer(input.userId, input.peerUserId, { allowExisting: true })
    const lookup = await this.lookup({ userId: input.userId, peerUserId: peer.id })
    if (!lookup.conversationId) throw notFound('还没有和这位同事的私聊')
    const requested = input.upTo && input.upTo.getTime() < Date.now() ? input.upTo : new Date()
    const [row] = await this.database<{ lastReadAt: Date }[]>`
      insert into conversation_read_states (tenant_id, user_id, target_type, target_id, last_read_at)
      values (${tenantId}, ${input.userId}, 'peer', ${peer.id}, ${requested})
      on conflict (tenant_id, user_id, target_type, target_id) do update
        set last_read_at = greatest(conversation_read_states.last_read_at, excluded.last_read_at),
            updated_at = now()
      returning last_read_at as "lastReadAt"
    `
    if (!row) throw new Error('direct read state was not saved')
    return { userId: peer.id, lastReadAt: row.lastReadAt.toISOString() }
  }

  async hide(input: { userId: string; conversationId: string }): Promise<{ id: string; hidden: true }> {
    const [row] = await this.database<{ id: string }[]>`
      update direct_conversation_participants
         set hidden_at = now()
       where tenant_id = ${tenantId}
         and conversation_id = ${input.conversationId}
         and user_id = ${input.userId}
      returning conversation_id as id
    `
    if (!row) throw notFound('私聊不存在')
    return { id: row.id, hidden: true }
  }

  private async requireParticipant(conversationId: string, userId: string) {
    const [row] = await this.database<{ id: string }[]>`
      select conversation_id as id
        from direct_conversation_participants
       where tenant_id = ${tenantId} and conversation_id = ${conversationId} and user_id = ${userId}
    `
    if (!row) throw notFound('私聊不存在')
  }

  private async requirePeer(actorUserId: string, peerUserId: string, options: { allowExisting: boolean }): Promise<ColleagueRow> {
    directPair(actorUserId, peerUserId)
    const pair = directPair(actorUserId, peerUserId)
    const [row] = await this.database<ColleagueRow[]>`
      select u.id, u.display_name as "displayName", u.status,
             (u.status = 'active' and u.business_user and exists (${this.database.unsafe(workbenchAccessPredicate)})) as "canSend"
        from users u
       where u.tenant_id = ${tenantId} and u.id = ${peerUserId}
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
    `
    if (!row) throw notFound('找不到这位同事')
    if (row.canSend) return row
    const existing = await this.database<{ id: string }[]>`
      select id from direct_conversations
       where tenant_id = ${tenantId} and user_low = ${pair.userLow} and user_high = ${pair.userHigh}
    `
    if (existing.length === 0) throw notFound('找不到这位同事')
    if (!options.allowExisting) throw invalidRequest(row.status === 'disabled' ? '对方账号已停用' : '不能给这位同事发私聊')
    return row
  }
}

async function ensureConversation(transaction: DatabaseTransaction, pair: { userLow: string; userHigh: string }, createdBy: string) {
  const id = `dconv-${randomUUID()}`
  const inserted = await transaction<{ id: string }[]>`
    insert into direct_conversations (id, tenant_id, user_low, user_high, created_by, last_message_at)
    values (${id}, ${tenantId}, ${pair.userLow}, ${pair.userHigh}, ${createdBy}, now())
    on conflict (tenant_id, user_low, user_high) do nothing
    returning id
  `
  const conversationId = inserted[0]?.id ?? (await transaction<{ id: string }[]>`
    select id from direct_conversations
     where tenant_id = ${tenantId} and user_low = ${pair.userLow} and user_high = ${pair.userHigh}
  `)[0]?.id
  if (!conversationId) throw new Error('direct conversation was not created')
  await transaction`
    insert into direct_conversation_participants (tenant_id, conversation_id, user_id)
    values (${tenantId}, ${conversationId}, ${pair.userLow}),
           (${tenantId}, ${conversationId}, ${pair.userHigh})
    on conflict do nothing
  `
  return conversationId
}

function toMessage(row: MessageRow): DirectMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    senderName: row.senderName,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  }
}

interface ListRow {
  conversationId: string
  lastActiveAt: Date
  peerId: string
  peerName: string
  canSend: boolean
  content: string
  sentAt: Date
  authorName: string
  unreadCount: number
}

interface MessageRow {
  id: string
  conversationId: string
  senderUserId: string
  senderName: string
  content: string
  createdAt: Date
}

function encodeCursor(at: Date, id: string) {
  return Buffer.from(JSON.stringify([at.toISOString(), id]), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') {
      const at = new Date(value[0])
      if (!Number.isNaN(at.getTime()) && value[1]) return { at, id: value[1] }
    }
  } catch {
    // fall through
  }
  throw invalidRequest('cursor 无效，请从第一页重新加载')
}

export function parseDirectLimit(raw: string | null) {
  return parseTargetLimit(raw, 30)
}
