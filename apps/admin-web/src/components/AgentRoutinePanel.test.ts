import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentRoutinePanel from './AgentRoutinePanel.vue'
import { adminApi } from '../api/client'
import type { AgentJoinedWorkspaceRecord } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

function joined(overrides: Partial<AgentJoinedWorkspaceRecord>): AgentJoinedWorkspaceRecord {
  return {
    workspaceId: 'ws-purchase', workspaceName: '采购项目', workspaceType: 'team',
    workspaceStatus: 'active', memberStatus: 'available', version: '1',
    addedBy: 'U00001', createdAt: '2026-10-20T00:00:00.000Z', ...overrides,
  }
}

describe('AgentRoutinePanel', () => {
  it('offers only project spaces the Agent has joined and can still work in', async () => {
    vi.spyOn(adminApi, 'getAgentRoutines').mockResolvedValue([])
    vi.spyOn(adminApi, 'getIdentityUsers').mockResolvedValue({ items: [] } as never)
    const allSpaces = vi.spyOn(adminApi, 'getWorkspaces')
    const joinedSpaces = vi.spyOn(adminApi, 'getAgentJoinedWorkspaces').mockResolvedValue({ items: [
      joined({}),
      joined({ workspaceId: 'ws-archived', workspaceName: '已归档项目', workspaceStatus: 'archived' }),
      joined({ workspaceId: 'ws-disabled', workspaceName: '已停用成员项目', memberStatus: 'disabled' }),
    ] })
    const wrapper = mount(AgentRoutinePanel, {
      props: { agentId: 'purchase-analyst', versions: [], canManage: true },
      global: { plugins: [ElementPlus], stubs: { teleport: true } },
    })
    wrappers.push(wrapper)
    await flushPromises()

    expect(joinedSpaces).toHaveBeenCalledWith('purchase-analyst')
    expect(allSpaces).not.toHaveBeenCalled()
    const state = (wrapper.vm.$ as unknown as { setupState: { workspaces: AgentJoinedWorkspaceRecord[] } }).setupState
    expect(state.workspaces.map(space => space.workspaceId)).toEqual(['ws-purchase'])
  })
})
