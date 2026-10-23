import { notFound } from '../../domain/request-errors.ts'
import type { WorkspaceTimelineItem, WorkspaceTimelinePage } from '../../modules/workbench/application/postgres-workspace-timeline-service.ts'
import type { SmokeRepository } from './smoke-repository.ts'

/**
 * P0 冒烟用的群聊时间线（S5d）：由内存夹具中该空间的执行与消息推导讨论、执行记录与“创建群组”
 * 系统记录；任务卡片、成员动态与读取权限由 PostgreSQL 实现与集成测试保证，这里不模拟。
 */
export class MemoryWorkspaceTimeline {
  private readonly repository: SmokeRepository

  constructor(repository: SmokeRepository) {
    this.repository = repository
  }

  async getTimeline(input: { workspaceId: string; before?: string; limit?: number }): Promise<WorkspaceTimelinePage> {
    const workspace = (await this.repository.read('workspaces')).find(item => item.id === input.workspaceId)
    if (!workspace || workspace.type !== 'team') throw notFound('工作空间不存在或你没有访问权限')
    const tasks = (await this.repository.read('tasks')).filter(task => task.workspaceId === workspace.id)
    const items: WorkspaceTimelineItem[] = []
    // 夹具时间是展示文本：按夹具顺序（最近在前）给出确定性时间，越靠后越早。
    tasks.forEach((task, index) => {
      const base = Date.UTC(2026, 7, 28, 10, 0, 0) - index * 3_600_000
      task.messages.forEach((message, offset) => {
        items.push({
          kind: 'message', id: `m:${message.id}`, at: new Date(base + offset * 60_000).toISOString(),
          sessionId: task.sessionId, sessionTitle: task.title, role: message.role === 'user' ? 'user' : 'assistant',
          content: message.content, senderId: message.role === 'user' ? task.requestedBy : null,
          senderName: message.role === 'user' ? task.owner : null, agentName: message.role === 'user' ? null : 'dsh-work Assistant',
          runId: task.id, runRequesterName: task.owner,
        })
      })
      items.push({
        kind: 'run', id: `r:${task.id}`, at: new Date(base + 30_000).toISOString(), sessionId: task.sessionId,
        sessionTitle: task.title, runId: task.id, status: task.status, requesterName: task.owner,
        agentName: 'dsh-work Assistant', stoppedByName: null,
      })
    })
    items.push({
      kind: 'system', id: `w:${workspace.id}`, at: new Date(Date.UTC(2026, 7, 1)).toISOString(),
      activityKind: 'workspace_created', actorName: workspace.owner, safeMetadata: {},
    })
    items.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
    return { workspaceId: workspace.id, items: items.slice(0, input.limit ?? 40), nextCursor: null }
  }
}
