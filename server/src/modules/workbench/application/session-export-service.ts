import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied, canReadWorkspaceObject } from '../../../domain/authorization-errors.ts'
import type { PostgresConversationRepository, ExportableSessionMessage } from './postgres-conversation-repository.ts'

const exportMessageLimit = 100

export interface ConversationExport {
  filename: string
  contentType: 'text/plain; charset=utf-8'
  content: AsyncIterable<string>
}

/** 会话摘要读取端口；由 run 编排服务实现，workbench 只依赖结构以避免反向模块依赖。 */
export interface SessionThreadPort {
  getSessionThread(sessionId: string, userId: string): Promise<{ title: string }>
}

export class SessionExportService {
  private readonly conversations: PostgresConversationRepository
  private readonly orchestration: SessionThreadPort
  private readonly authorization: PostgresAuthorizationService

  constructor(deps: {
    conversations: PostgresConversationRepository
    orchestration: SessionThreadPort
    authorization: PostgresAuthorizationService
  }) {
    this.conversations = deps.conversations
    this.orchestration = deps.orchestration
    this.authorization = deps.authorization
  }

  async exportSession(input: { sessionId: string; userId: string }): Promise<ConversationExport> {
    const thread = await this.orchestration.getSessionThread(input.sessionId, input.userId)
    const { messages, truncated } = await this.loadExportMessages(input.sessionId)
    const filename = `${sanitizeFilename(thread.title)}-完整会话.txt`
    const header = buildHeader({
      scopeLabel: '完整会话',
      sessionId: input.sessionId,
      truncated,
    })
    return {
      filename,
      contentType: 'text/plain; charset=utf-8',
      content: streamTranscript(header, messages),
    }
  }

  async exportRun(input: { runId: string; userId: string }): Promise<ConversationExport> {
    const task = await this.conversations.getTask(input.runId, input.userId)
    if (!task || !(await canReadWorkspaceObject(this.authorization, task.workspaceId, input.userId))) {
      throw authorizationDenied('Run 不存在或不可访问')
    }
    const { messages, truncated } = await this.loadExportMessages(task.sessionId, input.runId)
    const filename = `${sanitizeFilename(task.title)}-本次Run.txt`
    const header = buildHeader({
      scopeLabel: '本次 Run',
      sessionId: task.sessionId,
      runId: input.runId,
      truncated,
    })
    return {
      filename,
      contentType: 'text/plain; charset=utf-8',
      content: streamTranscript(header, messages),
    }
  }

  private async loadExportMessages(sessionId: string, runId?: string) {
    const collected: ExportableSessionMessage[] = []
    let cursor: string | null = null
    let truncated = false
    while (collected.length < exportMessageLimit) {
      const remaining = exportMessageLimit - collected.length
      const page = await this.conversations.listSessionMessagePage({
        sessionId,
        runId,
        cursor,
        limit: Math.min(remaining, 50),
      })
      collected.push(...page.items)
      if (!page.nextCursor) break
      if (collected.length >= exportMessageLimit) {
        truncated = true
        break
      }
      cursor = page.nextCursor
    }
    return { messages: collected.slice(0, exportMessageLimit), truncated }
  }
}

function buildHeader(input: {
  scopeLabel: string
  sessionId: string
  runId?: string
  truncated: boolean
}) {
  const lines = [
    `范围：${input.scopeLabel}`,
    `生成时间：${new Date().toISOString()}`,
    `Session ID：${input.sessionId}`,
  ]
  if (input.runId) lines.push(`Run ID：${input.runId}`)
  lines.push(`截断：${input.truncated ? `是（仅导出最近 ${exportMessageLimit} 条消息）` : '否'}`, '')
  return lines.join('\n')
}

function formatMessage(message: ExportableSessionMessage) {
  const speaker = message.role === 'user'
    ? (message.senderName ? `${message.senderName}` : '用户')
    : '助手'
  return `[${speaker}] ${message.content}`
}

async function* streamTranscript(header: string, messages: ExportableSessionMessage[]) {
  yield header
  for (const message of messages) {
    yield `${formatMessage(message)}\n\n`
  }
}

function sanitizeFilename(title: string) {
  const trimmed = title.trim() || '对话'
  return trimmed.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
}
