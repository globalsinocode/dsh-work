import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { ExperienceIterationAgentSummary, ExperienceIterationApplication } from '@/types/domain'
import ExperienceIterationView from './ExperienceIterationView.vue'

const agent: ExperienceIterationAgentSummary = {
  agentId: 'agent-quality', agentName: '质量分析 Agent', agentVersion: '2.1.0', agentStatus: 'published',
  totalApplications: 1, pendingApplications: 1, approvedApplications: 0, rejectedApplications: 0,
  latestApplicationAt: '2026-09-22T00:00:00.000Z',
}

const application: ExperienceIterationApplication = {
  id: 'memory-proposal-1', agentId: agent.agentId, agentName: agent.agentName,
  sourceAgentVersionId: 'agent-version-quality-2', sourceAgentVersion: '2.0.0',
  sourceRunId: 'run-quality-1', sourceAttemptId: 'attempt-quality-1', proposedBy: 'principal-agent-quality',
  title: '异常分析核对方法', content: '分析异常时先核对当前数据版本、缺失字段和外部操作回执，再形成可复核的结论。',
  contentDigest: 'b'.repeat(64), status: 'pending', reviewedBy: null, reviewedAt: null,
  reviewComment: null, publishedVersionId: null, createdAt: '2026-09-22T00:00:00.000Z',
}

afterEach(() => vi.restoreAllMocks())

describe('experience iteration governance', () => {
  it('lists applications under their Agent and publishes a reviewed experience', async () => {
    vi.spyOn(adminApi, 'getExperienceIterationAgents').mockResolvedValue([agent])
    vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([application])
    const review = vi.spyOn(adminApi, 'reviewExperienceIterationApplication').mockResolvedValue({
      ...application, status: 'approved', publishedVersionId: 'memory-version-1',
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    const wrapper = mount(ExperienceIterationView, {
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('质量分析 Agent')
    expect(wrapper.text()).toContain('异常分析核对方法')
    expect(wrapper.text()).toContain('run-quality-1')
    expect(adminApi.getExperienceIterationApplications).toHaveBeenCalledWith(undefined, 'pending')
    expect(wrapper.find('aside').exists()).toBe(false)
    expect(wrapper.find('.filter-panel').exists()).toBe(true)
    expect(wrapper.find('.data-table').exists()).toBe(true)
    expect(wrapper.find('.table-footer--pager').exists()).toBe(true)
    expect(wrapper.text()).toContain('1 条申请')
    expect(wrapper.text()).not.toContain('经验迭代按稳定 Agent 归属')

    const publish = wrapper.findAll('button').find(button => button.text() === '批准发布')
    await publish!.trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('memory-proposal-1', {
      decision: 'approved',
      resolutionKey: 'admin:memory-proposal-1:approved',
      comment: '已核对来源 Run/Attempt、Agent 归属和非权威经验边界',
    })
    wrapper.unmount()
  })

  it('shows applications from different Agents in one table', async () => {
    const secondAgent = { ...agent, agentId: 'agent-finance', agentName: '财务 Agent' }
    vi.spyOn(adminApi, 'getExperienceIterationAgents').mockResolvedValue([agent, secondAgent])
    vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([
      application,
      { ...application, id: 'memory-proposal-2', agentId: secondAgent.agentId, agentName: secondAgent.agentName, title: '发票核对顺序' },
    ])
    const wrapper = mount(ExperienceIterationView, {
      global: {
        plugins: [createPinia(), ElementPlus],
        stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true },
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('质量分析 Agent')
    expect(wrapper.text()).toContain('财务 Agent')
    expect(wrapper.text()).toContain('发票核对顺序')
    expect(wrapper.find('aside').exists()).toBe(false)
    wrapper.unmount()
  })
})
