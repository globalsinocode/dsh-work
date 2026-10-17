import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import type { AgentExperience, ExperienceIterationApplication } from '@/types/domain'
import AgentExperiencePanel from './AgentExperiencePanel.vue'

beforeEach(() => { vi.spyOn(adminApi, 'getAgentExperiences').mockResolvedValue([]) })
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

const experience: AgentExperience = {
  entryId: 'memory-entry-1', agentId: 'agent-quality', title: '异常分析核对方法', currentVersionId: 'memory-version-2',
  updatedAt: '2026-10-17T00:00:00.000Z',
  versions: [
    { id: 'memory-version-2', version: 2, title: '异常分析核对方法', content: '先核对数据版本、缺失字段和外部回执。', contentDigest: 'b'.repeat(64), publishedAt: '2026-10-17T00:00:00.000Z', publishedBy: '陈默', usable: true },
    { id: 'memory-version-1', version: 1, title: '异常分析核对方法', content: '先核对数据版本和缺失字段。', contentDigest: 'a'.repeat(64), publishedAt: '2026-10-16T00:00:00.000Z', publishedBy: '陈默', usable: true },
  ],
}

it('停用、回滚与启用经验都只移动当前版本，并要求填写原因（AE-04）', async () => {
  vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([])
  vi.spyOn(adminApi, 'getAgentExperiences').mockResolvedValue([experience])
  const prompt = vi.spyOn(ElMessageBox, 'prompt')
    .mockResolvedValueOnce({ value: '内容待核实', action: 'confirm' } as never)
    .mockResolvedValueOnce({ value: '核实无误', action: 'confirm' } as never)
    .mockResolvedValueOnce({ value: '新版本有误', action: 'confirm' } as never)
  const set = vi.spyOn(adminApi, 'setAgentExperienceVersion')
    .mockResolvedValueOnce({ ...experience, currentVersionId: null })
    .mockResolvedValueOnce(experience)
    .mockResolvedValueOnce({ ...experience, currentVersionId: 'memory-version-1' })
  const wrapper = mountPanel()
  try {
    await flushPromises()
    expect(wrapper.text()).toContain('正在使用的经验')
    expect(wrapper.text()).toContain('v2')

    await wrapper.get('[data-action="disable-experience"]').trigger('click')
    await flushPromises()
    expect(set).toHaveBeenLastCalledWith('agent-quality', 'memory-entry-1', { versionId: null, expectedVersionId: 'memory-version-2', reason: '内容待核实' })
    expect(wrapper.text()).toContain('已停用，不再被检索')

    await wrapper.get('[data-action="enable-experience"]').trigger('click')
    await flushPromises()
    expect(set).toHaveBeenLastCalledWith('agent-quality', 'memory-entry-1', { versionId: 'memory-version-2', expectedVersionId: null, reason: '核实无误' })

    await wrapper.get('[data-action="experience-versions"]').trigger('click')
    await flushPromises()
    const rollback = wrapper.findAll('[data-action="use-experience-version"]')
    expect(rollback.map(item => item.text())).toEqual(['回滚至此'])
    await rollback[0]!.trigger('click')
    await flushPromises()
    expect(set).toHaveBeenLastCalledWith('agent-quality', 'memory-entry-1', { versionId: 'memory-version-1', expectedVersionId: 'memory-version-2', reason: '新版本有误' })
    expect(prompt).toHaveBeenCalledTimes(3)
  } finally {
    wrapper.unmount()
  }
})

it('取消填写原因时不修改经验；只读时没有停用入口', async () => {
  vi.spyOn(adminApi, 'getExperienceIterationApplications').mockResolvedValue([])
  vi.spyOn(adminApi, 'getAgentExperiences').mockResolvedValue([experience])
  vi.spyOn(ElMessageBox, 'prompt').mockRejectedValue('cancel')
  const set = vi.spyOn(adminApi, 'setAgentExperienceVersion')
  const wrapper = mountPanel()
  try {
    await flushPromises()
    await wrapper.get('[data-action="disable-experience"]').trigger('click')
    await flushPromises()
    expect(set).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
  const readonly = mountPanel(false)
  try {
    await flushPromises()
    expect(readonly.find('[data-action="disable-experience"]').exists()).toBe(false)
    expect(readonly.find('[data-action="experience-versions"]').exists()).toBe(true)
  } finally {
    readonly.unmount()
  }
})
