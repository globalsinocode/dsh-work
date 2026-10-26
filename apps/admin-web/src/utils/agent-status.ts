import type { AgentDefinition, AgentVersionRecord } from '@/types/domain'

/** 当前版本指针；从未发布时为 null。有草稿时 `version` 是草稿版本，所以优先用 activeVersion。 */
export function activeVersionOf(agent: AgentDefinition | undefined): string | null {
  if (!agent) return null
  return agent.activeVersion ?? (agent.status !== 'draft' ? agent.version : null)
}

/**
 * 尚未发布的工作版本：可编辑草稿，或验证时冻结的待发布版本。以 Agent 的工作版本指针为准，
 * 被取代的旧候选版本仍是 candidate 状态但已不在指针上，不算待发布。
 */
export function pendingVersionOf(agent: AgentDefinition | undefined, versions: AgentVersionRecord[]) {
  if (!agent) return undefined
  return versions.find(version => version.agentId === agent.id && version.version === agent.version
    && (version.status === 'draft' || version.status === 'candidate'))
}

export function availabilityOf(agent: AgentDefinition | undefined): { status: string; label: string } {
  if (agent?.status === 'disabled') return { status: 'disabled', label: '已停用' }
  if (activeVersionOf(agent)) return { status: 'published', label: '已启用' }
  return { status: 'draft', label: '未发布' }
}

export type AgentDraftStep = 'profile' | 'capabilities' | 'audience' | 'release'

/** 进入草稿编辑流程时的默认步骤：已冻结待发布时直接到验证与发布，否则从职责与人格开始。 */
export function draftEntryStep(pending: AgentVersionRecord | undefined): AgentDraftStep {
  return pending?.status === 'candidate' ? 'release' : 'profile'
}
