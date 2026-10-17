import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentVersionRecord } from '@/types/domain'
import AgentDetailView from './AgentDetailView.vue'

afterEach(() => vi.restoreAllMocks())

const agent: AgentDefinition = {
  id: 'agent-detail-ui', name: '详情页 Agent', description: '用于验证详情页分区与运行记录。', owner: '陈默',
  department: 'platform', visibility: '全体试点员工', roleIds: ['role-employee'], allowWorkspaceJoin: true,
  status: 'draft', version: '0.2.0', activeVersion: '0.1.0',
  welcomeMessage: '', examplePrompts: ['请介绍你能提供哪些帮助'], systemPrompt: '你是测试 Agent，只处理当前输入并说明依据。',
  workInstructions: '', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  skills: [], tools: [], mcpScope: { mode: 'none', connectorIds: [] }, updatedAt: '2026-10-16 08:00', revision: 'rev-1',
}

function versionRecord(version: string, status: AgentVersionRecord['status']): AgentVersionRecord {
  return {
    id: `agent-version-${version}`, agentId: agent.id, version, status, createdAt: '2026-10-16 08:00', createdBy: '陈默',
    summary: '', welcomeMessage: '', examplePrompts: [], systemPrompt: agent.systemPrompt,
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [], tools: [],
  }
}

async function mountDetail(section?: string, permissions = ['admin:write'], options: {
  agent?: AgentDefinition; versions?: AgentVersionRecord[]
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions })
  const content = useContentStore()
  content.$patch({ agents: [options.agent ?? agent], agentVersions: options.versions ?? [] })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:agentId', name: 'agent-detail', component: AgentDetailView },
    { path: '/agents', component: defineComponent({ render: () => h('div') }) },
  ] })
  await router.push({ path: `/agents/${agent.id}`, query: section ? { section } : {} })
  await router.isReady()
  const wrapper = mount(AgentDetailView, { global: { plugins: [pinia, router, ElementPlus], stubs: {
    teleport: true,
    // jsdom 没有布局，真实 ElSelect 的标签宽度测量会反复触发更新；本测试只关心分区与运行记录。
    ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
    ElOption: true,
  } } })
  await flushPromises()
  return { wrapper, router }
}

it('详情页默认打开职责与人格，页头显示当前版本与可用性', async () => {
  const { wrapper } = await mountDetail()
  try {
    expect(wrapper.get('.detail-hero h2').text()).toBe('详情页 Agent')
    expect(wrapper.text()).toContain('当前版本 v0.1.0')
    expect(wrapper.text()).toContain('已启用')
    const tabs = wrapper.findAll('[role="tab"]').map(tab => tab.text())
    expect(tabs).toEqual(['职责与人格', '能力', '岗位权限', '主动任务', '经验', '验证与发布', '运行记录'])
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('职责与人格')
    expect(wrapper.find('textarea[maxlength="20000"]').exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it('通过地址打开运行记录分区并读取以该 Agent 身份运行的 Run', async () => {
  const runs = vi.spyOn(adminApi, 'getAgentRuns').mockResolvedValue({ items: [{
    runId: 'run-detail-1', status: 'succeeded', source: 'validation', version: '0.2.0', requestedBy: '陈默',
    sessionTitle: '验证 agent-detail-ui v0.2.0', errorCode: null,
    createdAt: '2026-10-16T00:00:00.000Z', startedAt: '2026-10-16T00:00:01.000Z', endedAt: '2026-10-16T00:00:04.000Z',
  }] })
  const { wrapper } = await mountDetail('runs')
  try {
    expect(runs).toHaveBeenCalledWith(agent.id)
    expect(wrapper.text()).toContain('run-detail-1')
    expect(wrapper.text()).toContain('验证')
    expect(wrapper.text()).toContain('3.0 秒')
  } finally {
    wrapper.unmount()
  }
})

it('切换分区写入地址，刷新后停留在同一分区', async () => {
  vi.spyOn(adminApi, 'getAgentRuns').mockResolvedValue({ items: [] })
  const { wrapper, router } = await mountDetail()
  try {
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === '运行记录')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.section).toBe('runs')
    expect(wrapper.text()).toContain('还没有运行记录')
  } finally {
    wrapper.unmount()
  }
})

it('安全审计员只读：没有启停按钮，草稿字段只读', async () => {
  const { wrapper } = await mountDetail(undefined, ['admin:read'])
  try {
    expect(wrapper.find('[data-action="disable-agent"]').exists()).toBe(false)
    expect(wrapper.find('input[readonly]').exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it('页头只把工作版本指针上的版本当作待发布，被取代的旧候选版本不显示', async () => {
  const published: AgentDefinition = { ...agent, status: 'published', version: '0.3.0', activeVersion: '0.3.0' }
  const stale = await mountDetail(undefined, ['admin:write'], {
    agent: published, versions: [versionRecord('0.3.0', 'published'), versionRecord('0.2.0', 'candidate')],
  })
  try {
    expect(stale.wrapper.get('.detail-hero').text()).not.toContain('待发布')
  } finally {
    stale.wrapper.unmount()
  }
  const frozen = await mountDetail(undefined, ['admin:write'], {
    agent: { ...published, version: '0.4.0' },
    versions: [versionRecord('0.4.0', 'candidate'), versionRecord('0.3.0', 'published'), versionRecord('0.2.0', 'candidate')],
  })
  try {
    expect(frozen.wrapper.get('.detail-hero').text()).toContain('待发布 v0.4.0（已冻结）')
  } finally {
    frozen.wrapper.unmount()
  }
})
