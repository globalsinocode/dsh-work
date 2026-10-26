import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ProjectBrief } from '@/types/domain'
import ProjectBriefCard from './ProjectBriefCard.vue'

const brief: ProjectBrief = {
  versionId: 'wbrief-2',
  versionNo: 2,
  content: '目标：本季度华东缺货率降到 3%',
  dueDate: '2026-12-31',
  updatedBy: { userId: 'u-owner', displayName: '林岚' },
  updatedAt: '2026-10-17T08:00:00.000Z',
}

function mountCard(props: Record<string, unknown> = {}) {
  return mount(ProjectBriefCard, {
    props: { workspaceId: 'ws-team', workspaceName: '供应链项目', canEdit: true, ...props },
    global: { plugins: [ElementPlus] },
  })
}

describe('ProjectBriefCard（项目空间 S1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the latest brief with due date and version info', async () => {
    vi.spyOn(workbenchApi, 'getProjectBrief').mockResolvedValue(brief)
    const wrapper = mountCard({ canEdit: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="project-brief-content"]').text()).toBe(brief.content)
    expect(wrapper.get('[data-testid="project-brief-due"]').text()).toContain('2026-12-31')
    expect(wrapper.text()).toContain('第 2 版 · 林岚 更新于')
    expect(wrapper.find('[data-testid="project-brief-edit"]').exists()).toBe(false)
  })

  it('collapses the brief body and hides the edit entry while collapsed (项目空间 S2)', async () => {
    vi.spyOn(workbenchApi, 'getProjectBrief').mockResolvedValue(brief)
    const wrapper = mountCard()
    await flushPromises()
    const toggle = wrapper.get('[data-testid="project-brief-toggle"]')
    const bodyId = toggle.attributes('aria-controls')!
    expect(toggle.attributes('aria-expanded')).toBe('true')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get(`#${bodyId}`).attributes('style')).toContain('display: none')
    expect(wrapper.find('[data-testid="project-brief-edit"]').exists()).toBe(false)
    await toggle.trigger('click')
    expect(wrapper.get(`#${bodyId}`).attributes('style') ?? '').not.toContain('display: none')
    expect(wrapper.find('[data-testid="project-brief-edit"]').exists()).toBe(true)
  })

  it('invites editors to write the first brief and tells others who can', async () => {
    vi.spyOn(workbenchApi, 'getProjectBrief').mockResolvedValue(null)
    const editor = mountCard()
    await flushPromises()
    expect(editor.find('[data-testid="project-brief-create"]').exists()).toBe(true)

    const reader = mountCard({ canEdit: false })
    await flushPromises()
    expect(reader.find('[data-testid="project-brief-create"]').exists()).toBe(false)
    expect(reader.text()).toContain('负责人或管理员可以填写简报')
  })

  it('saves a new version, clears the due date, and keeps input when saving fails', async () => {
    vi.spyOn(workbenchApi, 'getProjectBrief').mockResolvedValue(brief)
    const save = vi.spyOn(workbenchApi, 'saveProjectBrief')
      .mockRejectedValueOnce(new Error('服务暂不可用'))
      .mockResolvedValueOnce({ ...brief, versionId: 'wbrief-3', versionNo: 3, content: '目标：缺货率降到 2%', dueDate: null })
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.get('[data-testid="project-brief-edit"]').trigger('click')
    await flushPromises()
    await wrapper.get('textarea[data-testid="project-brief-input"]').setValue('目标：缺货率降到 2%')
    const vm = wrapper.vm as unknown as { draftDueDate: string | null }
    vm.draftDueDate = null

    await wrapper.get('[data-testid="project-brief-save"]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenLastCalledWith('ws-team', { content: '目标：缺货率降到 2%', dueDate: null })
    expect((wrapper.get('textarea[data-testid="project-brief-input"]').element as HTMLTextAreaElement).value).toBe('目标：缺货率降到 2%')

    await wrapper.get('[data-testid="project-brief-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="project-brief-content"]').text()).toBe('目标：缺货率降到 2%')
    expect(wrapper.find('[data-testid="project-brief-due"]').exists()).toBe(false)
  })
})
