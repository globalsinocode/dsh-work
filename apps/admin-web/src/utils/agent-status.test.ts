import { describe, expect, it } from 'vitest'

import type { AgentDefinition, AgentVersionRecord } from '../types/domain'
import { activeVersionOf, availabilityOf, pendingVersionOf } from './agent-status'

function agent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'agent-knowledge',
    name: 'WebKora-知识库智能体',
    description: '',
    owner: '',
    department: '',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    allowWorkspaceJoin: true,
    status: 'published',
    version: '0.1.0',
    welcomeMessage: '',
    examplePrompts: [],
    systemPrompt: '',
    maxOutputBytes: 0,
    maxToolCalls: 0,
    timeoutSeconds: 0,
    ...overrides,
  } as AgentDefinition
}

function version(overrides: Partial<AgentVersionRecord>): AgentVersionRecord {
  return { agentId: 'agent-knowledge', version: '0.2.0', status: 'draft', ...overrides } as AgentVersionRecord
}

describe('agent availability', () => {
  it('reports a published agent as 已启用 while an unpublished draft only shows as pending', () => {
    // 后台：活动版本 0.1.0 已发布，同时存在未发布草稿 0.2.0。
    const definition = agent({ status: 'draft', version: '0.2.0', activeVersion: '0.1.0' })
    expect(activeVersionOf(definition)).toBe('0.1.0')
    expect(availabilityOf(definition)).toEqual({ status: 'published', label: '已启用' })
    expect(pendingVersionOf(definition, [version({})])?.version).toBe('0.2.0')
  })

  it('reports 未发布 only when the agent never had a published version', () => {
    const definition = agent({ status: 'draft', version: '0.1.0', activeVersion: null })
    expect(activeVersionOf(definition)).toBeNull()
    expect(availabilityOf(definition)).toEqual({ status: 'draft', label: '未发布' })
  })

  it('keeps a disabled agent 已停用 even with an unpublished draft', () => {
    const definition = agent({ status: 'disabled', version: '0.2.0', activeVersion: '0.1.0' })
    expect(availabilityOf(definition)).toEqual({ status: 'disabled', label: '已停用' })
  })
})
