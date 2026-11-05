import { describe, expect, it } from 'vitest'

import { runAgentName } from './run-agent-name'

const reply = (runId: string, agentName: string) => ({ id: `m-${runId}`, role: 'assistant' as const, content: '', createdAt: '10:00', runId, agentName })

describe('runAgentName（标题栏与执行中卡片共用）', () => {
  it('prefers the name in agentVersion', () => {
    expect(runAgentName({ id: 'r2', agentVersion: '库存助手@1.2.0', messages: [reply('r1', '采购助手')], workspaceType: 'personal' })).toBe('库存助手')
  })

  it('falls back to this round, then to an earlier round only in a personal conversation', () => {
    expect(runAgentName({ id: 'r2', agentVersion: '', messages: [reply('r1', '采购助手'), reply('r2', '库存助手')], workspaceType: 'personal' })).toBe('库存助手')
    expect(runAgentName({ id: 'r2', agentVersion: '', messages: [reply('r1', '采购助手')], workspaceType: 'personal' })).toBe('采购助手')
    expect(runAgentName({ id: 'r2', agentVersion: '', messages: [reply('r1', '采购助手')], workspaceType: 'team' })).toBe('dsh-work')
    expect(runAgentName({ id: 'r1', agentVersion: '', messages: [], workspaceType: 'personal' })).toBe('dsh-work')
  })
})
