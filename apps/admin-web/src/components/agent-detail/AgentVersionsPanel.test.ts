import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentVersionHistoryItem } from '@/types/domain'
import AgentVersionsPanel from './AgentVersionsPanel.vue'

afterEach(() => vi.restoreAllMocks())

const agentId = 'agent-versions-ui'

const history: AgentVersionHistoryItem[] = [
  { id: 'agent-version-3', version: '0.3.0', status: 'draft', summary: '第三版草稿', createdAt: '2026-10-16T02:00:00.000Z',
    createdBy: '管理员', publishedAt: null, publishedBy: null, active: false },
  { id: 'agent-version-2', version: '0.2.0', status: 'published', summary: '第二版', createdAt: '2026-10-16T01:00:00.000Z',
    createdBy: '管理员', publishedAt: '2026-10-16T01:10:00.000Z', publishedBy: '管理员', active: true },
  { id: 'agent-version-1', version: '0.1.0', status: 'published', summary: '第一版', createdAt: '2026-10-15T01:00:00.000Z',
    createdBy: '管理员', publishedAt: '2026-10-15T01:10:00.000Z', publishedBy: '管理员', active: false },
]

async function mountPanel(canManage = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const load = vi.spyOn(adminApi, 'getAgentVersionHistory').mockResolvedValue({ items: history })
  const wrapper = mount(AgentVersionsPanel, {
    props: { agentId, canManage },
    global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
  })
  await flushPromises()
  return { wrapper, load }
}

it('只有曾发布且非当前的版本可以回滚，回滚后重新读取', async () => {
  const { wrapper, load } = await mountPanel()
  const rollback = vi.spyOn(useContentStore(), 'rollbackAgent').mockResolvedValue({ id: agentId } as AgentDefinition)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
  try {
    expect(wrapper.text()).toContain('第三版草稿')
    expect(wrapper.text()).toContain('当前')
    const buttons = wrapper.findAll('[data-action="rollback-agent"]')
    expect(buttons).toHaveLength(1)
    await buttons[0]!.trigger('click')
    await flushPromises()
    expect(rollback).toHaveBeenCalledWith(agentId, '0.1.0')
    expect(load).toHaveBeenCalledTimes(2)
  } finally {
    wrapper.unmount()
  }
})

it('只读用户看不到回滚操作；读取失败时可以重试', async () => {
  const { wrapper } = await mountPanel(false)
  try {
    expect(wrapper.find('[data-action="rollback-agent"]').exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
  const pinia = createPinia()
  setActivePinia(pinia)
  const load = vi.spyOn(adminApi, 'getAgentVersionHistory').mockRejectedValueOnce(new Error('版本历史暂不可用'))
    .mockResolvedValue({ items: history })
  const failing = mount(AgentVersionsPanel, { props: { agentId, canManage: true }, global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  try {
    expect(failing.text()).toContain('版本历史暂不可用')
    await failing.findAll('button').find(item => item.text() === '重新读取')!.trigger('click')
    await flushPromises()
    expect(load).toHaveBeenCalled()
    expect(failing.text()).not.toContain('版本历史暂不可用')
    expect(failing.text()).toContain('第二版')
  } finally {
    failing.unmount()
  }
})
