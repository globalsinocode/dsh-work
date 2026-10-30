import { notFound } from '../../domain/request-errors.ts'
import {
  decodeTargetCursor,
  encodeTargetCursor,
  previewText,
  type AgentConversation,
  type ConversationLocation,
  type ConversationReadState,
  type ConversationTarget,
  type ConversationTargetPage,
  type ConversationTargetStore,
  type ConversationTargetType,
  type MentionSummary,
} from '../../modules/workbench/application/conversation-targets.ts'
import type { SmokeRepository } from './smoke-repository.ts'

/**
 * P0 冒烟用的对话对象（S5c）：从内存夹具的 Run、空间与 Agent 推导，只用于页面冒烟。
 * 夹具时间是展示文本，这里按夹具顺序（已是最近在前）给出确定性的时间，单一测试身份不做
 * 成员过滤；真实的读取范围与续写判断由 PostgreSQL 实现与 MODE-API-02 集成测试保证。
 */
export class MemoryConversationTargetStore implements ConversationTargetStore {
  private readonly repository: SmokeRepository
  /** 已读的对话对象（进程内，S5e）：未读数为夹具中该对象的 Agent 回复数，标记已读后为 0。 */
  private readonly readTargets = new Set<string>()

  /**
   * D38：预置一条 @ 测试身份的未读提醒（`ws-supply` 的一段讨论），供冒烟验证“[有人@我]”与打开即已读；
   * 登记与成员校验由 PostgreSQL 实现与 MODE-API-04 集成测试保证。
   */
  private readonly mentions: Array<MentionSummary & { read: boolean }> = [
    { workspaceId: 'ws-supply', sessionId: 'session-1002', count: 1, latestAt: syntheticTime(0), read: false },
  ]

  constructor(repository: SmokeRepository) {
    this.repository = repository
  }

  async listMentions(): Promise<{ items: MentionSummary[] }> {
    return { items: this.mentions.filter(item => !item.read).map(({ read: _read, ...item }) => item) }
  }

  async markMentionsRead(input: { workspaceId: string; sessionId?: string }) {
    const workspace = (await this.repository.read('workspaces')).find(item => item.id === input.workspaceId && item.type === 'team')
    if (!workspace) throw notFound('项目空间不存在或无权访问')
    let read = 0
    for (const item of this.mentions) {
      if (item.read || item.workspaceId !== input.workspaceId || (input.sessionId && item.sessionId !== input.sessionId)) continue
      item.read = true
      read += item.count
    }
    return { workspaceId: input.workspaceId, sessionId: input.sessionId ?? null, read }
  }

  async markRead(input: { type: ConversationTargetType; id: string; upTo?: Date }): Promise<ConversationReadState> {
    const workspaces = await this.repository.read('workspaces')
    const agents = await this.repository.read('agents')
    const exists = input.type === 'group'
      ? workspaces.some(item => item.id === input.id && item.type === 'team')
      : agents.some(item => item.id === input.id) || (await this.allTargets()).some(item => item.type === 'agent' && item.id === input.id)
    if (!exists) throw notFound(input.type === 'group' ? '群组不存在或无权访问' : 'AI 同事不存在')
    this.readTargets.add(`${input.type}:${input.id}`)
    if (input.type === 'group') await this.markMentionsRead({ workspaceId: input.id })
    const now = new Date()
    const at = input.upTo && input.upTo < now ? input.upTo : now
    return { type: input.type, id: input.id, lastReadAt: at.toISOString() }
  }

  async listTargets(input: { query?: string; cursor?: string; limit?: number }): Promise<ConversationTargetPage> {
    const all = await this.allTargets()
    const query = input.query?.toLowerCase()
    const filtered = query ? all.filter(item => item.name.toLowerCase().includes(query)) : all
    const start = input.cursor ? filtered.findIndex(item => item.id === decodeTargetCursor(input.cursor!).id) + 1 : 0
    const limit = input.limit ?? 30
    const items = filtered.slice(start, start + limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor: start + limit < filtered.length && last ? encodeTargetCursor(last.lastActiveAt, last.type, last.id) : null,
    }
  }

  async getAgentConversation(input: { agentId: string; cursor?: string; limit?: number }): Promise<AgentConversation> {
    const agent = (await this.repository.read('agents')).find(item => item.id === input.agentId && item.status === 'published')
    const sessions = await this.personalSessions(input.agentId)
    if (!agent && !sessions.length) throw notFound('AI 同事不存在或当前不可用')
    const start = input.cursor ? sessions.findIndex(item => item.sessionId === decodeTargetCursor(input.cursor!).id) + 1 : 0
    const limit = input.limit ?? 5
    const items = sessions.slice(start, start + limit)
    const last = items.at(-1)
    const newest = sessions[0]
    const version = agent?.version ?? newest?.agentVersion ?? ''
    return {
      agent: {
        id: input.agentId,
        name: agent?.name ?? input.agentId,
        description: agent?.description ?? '',
        version,
        available: Boolean(agent),
      },
      items,
      nextCursor: start + limit < sessions.length && last ? encodeTargetCursor(last.lastActiveAt, 'session', last.sessionId) : null,
      continueSessionId: agent && newest && newest.agentVersion === agent.version ? newest.sessionId : null,
    }
  }

  async resolveConversation(input: { conversationId: string }): Promise<ConversationLocation> {
    const tasks = await this.repository.read('tasks')
    const task = tasks.find(item => item.id === input.conversationId || item.sessionId === input.conversationId)
    if (!task) throw notFound('对话不存在或无权访问')
    const workspace = (await this.repository.read('workspaces')).find(item => item.id === task.workspaceId)
    if (workspace?.type === 'team') return { type: 'group', workspaceId: workspace.id, sessionId: task.sessionId }
    return { type: 'agent', agentId: agentIdOf(task.agentVersion), sessionId: task.sessionId }
  }

  private async personalSessions(agentId: string) {
    const tasks = await this.repository.read('tasks')
    const workspaces = await this.repository.read('workspaces')
    const personal = new Set(workspaces.filter(item => item.type === 'personal').map(item => item.id))
    const bySession = new Map<string, AgentConversation['items'][number]>()
    for (const [index, task] of tasks.entries()) {
      if (!personal.has(task.workspaceId) || agentIdOf(task.agentVersion) !== agentId) continue
      const at = syntheticTime(index)
      const segment = bySession.get(task.sessionId)
      if (segment) { segment.runCount += 1; continue }
      bySession.set(task.sessionId, {
        sessionId: task.sessionId,
        title: task.title,
        createdAt: at,
        lastActiveAt: at,
        agentVersion: task.agentVersion.split('@')[1] ?? '',
        runCount: 1,
        latestRun: { id: task.id, status: task.status },
      })
    }
    return [...bySession.values()]
  }

  private async allTargets(): Promise<ConversationTarget[]> {
    const tasks = await this.repository.read('tasks')
    const workspaces = await this.repository.read('workspaces')
    const agents = await this.repository.read('agents')
    const targets = new Map<string, ConversationTarget & { order: number }>()
    const replies = new Map<string, number>()
    for (const task of tasks) {
      const workspace = workspaces.find(item => item.id === task.workspaceId)
      if (!workspace) continue
      const key = workspace.type === 'team' ? `group:${workspace.id}` : `agent:${agentIdOf(task.agentVersion)}`
      replies.set(key, (replies.get(key) ?? 0) + task.messages.filter(message => message.role !== 'user').length)
    }
    const unread = (key: string) => this.readTargets.has(key) ? 0 : replies.get(key) ?? 0
    const mentioned = (workspaceId: string) => this.mentions.some(item => !item.read && item.workspaceId === workspaceId)
    for (const [index, task] of tasks.entries()) {
      const workspace = workspaces.find(item => item.id === task.workspaceId)
      if (!workspace) continue
      const isGroup = workspace.type === 'team'
      const id = isGroup ? workspace.id : agentIdOf(task.agentVersion)
      const key = `${isGroup ? 'group' : 'agent'}:${id}`
      if (targets.has(key)) continue
      const agent = agents.find(item => item.id === id)
      const message = task.messages.at(-1)
      const name = isGroup ? workspace.name : agent?.name ?? id
      targets.set(key, {
        type: isGroup ? 'group' : 'agent',
        id,
        name,
        description: isGroup ? workspace.description : agent?.description ?? '',
        avatarNames: isGroup ? workspace.members.slice(0, 4) : [name],
        lastMessage: message ? {
          role: message.role === 'user' ? 'user' : 'assistant',
          authorName: message.role === 'user' ? task.owner : agent?.name ?? 'dsh-work',
          text: previewText(message.content),
          sentAt: syntheticTime(index),
        } : null,
        lastActiveAt: syntheticTime(index),
        available: isGroup || agent?.status === 'published',
        unreadCount: unread(key),
        muted: false,
        mentioned: isGroup && mentioned(workspace.id),
        order: index,
      })
    }
    for (const workspace of workspaces) {
      if (workspace.type !== 'team' || workspace.status === 'archived' || targets.has(`group:${workspace.id}`)) continue
      targets.set(`group:${workspace.id}`, {
        type: 'group', id: workspace.id, name: workspace.name, description: workspace.description,
        avatarNames: workspace.members.slice(0, 4), lastMessage: null,
        lastActiveAt: syntheticTime(tasks.length + targets.size), available: true, unreadCount: 0, muted: false,
        mentioned: mentioned(workspace.id),
        order: tasks.length + targets.size,
      })
    }
    return [...targets.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...item }) => item)
  }
}

function agentIdOf(agentVersion: string) {
  return agentVersion.split('@')[0] ?? agentVersion
}

/** 夹具顺序 → 确定性时间：第 n 条比最新一条早 n 小时。 */
function syntheticTime(index: number) {
  return new Date(Date.UTC(2026, 7, 28, 10, 0, 0) - index * 3_600_000).toISOString()
}
