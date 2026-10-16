import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import type { ExperienceIterationApplication } from '@/types/domain'
import AgentExperiencePanel from './AgentExperiencePanel.vue'

afterEach(() => vi.restoreAllMocks())

const base: ExperienceIterationApplication = {
  id: 'memory-proposal-1', agentId: 'agent-quality', agentName: '质量分析 Agent',
  sourceAgentVersionId: 'agent-version-quality-2', sourceAgentVersion: '2.0.0',
  sourceRunId: 'run-quality-1', sourceAttemptId: 'attempt-quality-1', proposedBy: 'principal-agent-quality',
  title: '异常分析核对方法', content: '分析异常时先核对当前数据版本、缺失字段和外部操作回执。',
  contentDigest: 'a'.repeat(64), status: 'pending', reviewedBy: null, reviewedAt: null,
  reviewComment: null, publishedVersionId: null, createdAt: '2026-10-16T00:00:00.000Z',
}

function mountPanel(canManage = true) {
  return mount(AgentExperiencePanel, {
    props: { agentId: 'agent-quality', canManage },
    global: { plugins: [ElementPlus], stubs: { teleport: true, RouterLink: { template: '<a><slot /></a>' } } },
  })
}

function button(wrapper: ReturnType<typeof mountPanel>, text: string) {
  const found = wrapper.findAll('button').find(item => item.text() === text)
  if (!found) throw new Error(`未找到按钮：${text}`)
  return found
}

it('只读取该 Agent 的申请，按状态分组并批准发布', async () => {
  const list = vi.spyOn(adminApi, 'getExperienceIterationApplications')
    .mockResolvedValueOnce([base, { ...base, id: 'memory-proposal-2', status: 'approved', title: '已发布的核对顺序', publishedVersionId: 'memory-version-1' }])
    .mockResolvedValueOnce([{ ...base, status: 'approved', publishedVersionId: 'memory-version-2' }])
  const review = vi.spyOn(adminApi, 'reviewExperienceIterationApplication').mockResolvedValue({ ...base, status: 'approved' })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    expect(list).toHaveBeenCalledWith('agent-quality')
    expect(wrapper.text()).toContain('待审核 1')
    expect(wrapper.text()).toContain('已发布 1')
    expect(wrapper.text()).toContain('异常分析核对方法')
    expect(wrapper.text()).not.toContain('已发布的核对顺序')
    await wrapper.get('[data-action="open-experience"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('run-quality-1 / attempt-quality-1')
    await button(wrapper, '批准并发布').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('memory-proposal-1', expect.objectContaining({ decision: 'approved' }))
    expect(list).toHaveBeenCalledTimes(2)
  } finally {
    wrapper.unmount()
  }
})

it('拒绝必须填写原因，原因随审核提交', async () => {
  vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([base])
  const review = vi.spyOn(adminApi, 'reviewExperienceIterationApplication').mockResolvedValue({ ...base, status: 'rejected' })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    await wrapper.get('[data-action="open-experience"]').trigger('click')
    await flushPromises()
    await button(wrapper, '拒绝').trigger('click')
    await flushPromises()
    expect(review).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('拒绝时必须填写原因')
    await wrapper.get('textarea[aria-label="审核说明"]').setValue('只适用于单次数据，不具备复用价值')
    await button(wrapper, '拒绝').trigger('click')
    await flushPromises()
    expect(review).toHaveBeenCalledWith('memory-proposal-1', expect.objectContaining({
      decision: 'rejected', comment: '只适用于单次数据，不具备复用价值',
    }))
  } finally {
    wrapper.unmount()
  }
})

it('只读时只能查看，没有审核操作', async () => {
  vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([base])
  const wrapper = mountPanel(false)
  try {
    await flushPromises()
    expect(wrapper.get('[data-action="open-experience"]').text()).toBe('查看')
    await wrapper.get('[data-action="open-experience"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('button').some(item => item.text() === '批准并发布')).toBe(false)
  } finally {
    wrapper.unmount()
  }
})
