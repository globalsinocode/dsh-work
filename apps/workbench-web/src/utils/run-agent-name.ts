import type { TaskRun } from '@/types/domain'

/**
 * 一次执行对应的 AI 同事名称，标题栏与执行中卡片共用，保证两处一致：
 * agentVersion 为“名称@版本”（无版本时为空串）→ 本轮回复的 agentName →
 * 个人对话中最近一条回复的 agentName（团队对话可能有多位同事，不跨轮借用）→ dsh-work。
 */
export function runAgentName(task: Pick<TaskRun, 'id' | 'agentVersion' | 'messages' | 'workspaceType'>) {
  const replies = task.messages.filter(message => message.role === 'assistant' && message.agentName)
  return task.agentVersion.split('@')[0]
    || replies.find(message => message.runId === task.id)?.agentName
    || (task.workspaceType === 'team' ? undefined : replies.at(-1)?.agentName)
    || 'dsh-work'
}
