import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { SkillSubmissionReviewDetail, SkillSubmissionReviewItem } from '@/types/domain'
import SkillSubmissionReviewPanel from './SkillSubmissionReviewPanel.vue'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

function item(overrides: Partial<SkillSubmissionReviewItem> = {}): SkillSubmissionReviewItem {
  return {
    id: 'skill-submission-1', name: '周报汇总', description: '每周把销售日报汇总成周报。',
    submitter: { id: 'U00001', displayName: '张三' }, source: 'conversation', sessionId: 'session-1', status: 'pending',
    versionId: 'skill-submission-version-1', versionNumber: 2, scriptCount: 1,
    trial: { status: 'passed', runId: 'run-1', testedAt: '2026-10-30T08:00:00.000Z' }, submittedAt: '2026-10-30T07:00:00.000Z',
    ...overrides,
  }
}

function detail(overrides: Partial<SkillSubmissionReviewDetail> = {}): SkillSubmissionReviewDetail {
  return {
    ...item(),
    files: [{ path: 'SKILL.md', size: 120, script: false }, { path: 'scripts/report.py', size: 40, script: true }],
    compatibility: { status: 'compatible', issues: [] },
    trial: { status: 'passed', runId: 'run-1', skillId: 'skill-1', resultSummary: 'DSH 试运行完成' },
    ...overrides,
  }
}

async function render(canManage = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: canManage ? ['admin:write'] : ['admin:read'] })
  const wrapper = mount(SkillSubmissionReviewPanel, { global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find(candidate => candidate.text().includes(label))
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

describe('Skill 提交审核', () => {
  it('列出提交人、来源、脚本数量与试运行状态，并报告数量', async () => {
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item(), item({ id: 'skill-submission-2', name: '会议纪要', scriptCount: 0, trial: { status: 'not_started' } })])
    const wrapper = await render()
    const text = wrapper.text()
    expect(text).toContain('张三')
    expect(text).toContain('对话创建')
    expect(text).toContain('含 1 个脚本')
    expect(text).toContain('纯指令')
    expect(text).toContain('未试运行')
    expect(wrapper.emitted('count')?.[0]).toEqual([2])
  })

  it('试运行未通过时不能发布并说明原因；拒绝须填写原因', async () => {
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item({ trial: { status: 'not_started' } })])
    vi.spyOn(adminApi, 'getSkillSubmission').mockResolvedValue(detail({ trial: { status: 'not_started' } }))
    vi.spyOn(adminApi, 'getSkillSubmissionFile').mockResolvedValue({ path: 'SKILL.md', size: 120, content: '---\nname: 周报汇总\n---' })
    const reject = vi.spyOn(adminApi, 'rejectSkillSubmission').mockResolvedValue(detail({ status: 'rejected' }))
    const wrapper = await render()
    await button(wrapper, '审核').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('name: 周报汇总')
    expect(button(wrapper, '通过并发布').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('先完成一次严格试运行')
    expect(button(wrapper, '开始试运行').exists()).toBe(true)

    await button(wrapper, '拒绝').trigger('click')
    await flushPromises()
    expect(button(wrapper, '确认拒绝').attributes('disabled')).toBeDefined()
    await wrapper.get('textarea[aria-label="拒绝原因"]').setValue('请写清数据来源。')
    await button(wrapper, '确认拒绝').trigger('click')
    await flushPromises()
    expect(reject).toHaveBeenCalledWith('skill-submission-1', { versionId: 'skill-submission-version-1', note: '请写清数据来源。' })
  })

  it('通过时选择指定角色须至少勾选一个', async () => {
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item()])
    vi.spyOn(adminApi, 'getSkillSubmission').mockResolvedValue(detail())
    vi.spyOn(adminApi, 'getSkillSubmissionFile').mockResolvedValue({ path: 'SKILL.md', size: 120, content: 'x' })
    vi.spyOn(adminApi, 'getIdentityRoles').mockResolvedValue([
      { id: 'role-sales', code: 'sales', name: '销售部', description: '', status: 'active', permissions: [], dataScopes: [], userCount: 3, system: false, updatedAt: '' },
    ])
    const approve = vi.spyOn(adminApi, 'approveSkillSubmission').mockResolvedValue({ ...detail({ status: 'approved' }), skill: {} as never })
    const wrapper = await render()
    await button(wrapper, '审核').trigger('click')
    await flushPromises()
    await button(wrapper, '通过并发布').trigger('click')
    await flushPromises()
    await wrapper.findAll('input[type="radio"]').find(input => (input.element as HTMLInputElement).value === 'roles')!.setValue(true)
    await flushPromises()
    expect(button(wrapper, '确认发布').attributes('disabled')).toBeDefined()
    await wrapper.findAll('input[type="checkbox"]').find(input => (input.element as HTMLInputElement).value === 'role-sales')!.setValue(true)
    await button(wrapper, '确认发布').trigger('click')
    await flushPromises()
    expect(approve).toHaveBeenCalledWith('skill-submission-1', { versionId: 'skill-submission-version-1', visibleRoleIds: ['role-sales'] })
    expect(wrapper.emitted('published')).toHaveLength(1)
  })

  it('审核已发布 Skill 的修订时默认沿用当前可见范围', async () => {
    const revision = detail({ publishedSkillId: 'skill-1', publishedVisibleRoleIds: ['role-sales'] })
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item({ publishedSkillId: 'skill-1', publishedVisibleRoleIds: ['role-sales'] })])
    vi.spyOn(adminApi, 'getSkillSubmission').mockResolvedValue(revision)
    vi.spyOn(adminApi, 'getSkillSubmissionFile').mockResolvedValue({ path: 'SKILL.md', size: 120, content: 'x' })
    vi.spyOn(adminApi, 'getIdentityRoles').mockResolvedValue([
      { id: 'role-sales', code: 'sales', name: '销售部', description: '', status: 'active', permissions: [], dataScopes: [], userCount: 3, system: false, updatedAt: '' },
    ])
    const approve = vi.spyOn(adminApi, 'approveSkillSubmission').mockResolvedValue({ ...revision, status: 'approved', skill: {} as never })
    const wrapper = await render()
    await button(wrapper, '审核').trigger('click')
    await flushPromises()
    await button(wrapper, '通过并发布').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('当前可见范围：销售部')
    await button(wrapper, '确认发布').trigger('click')
    await flushPromises()
    expect(approve).toHaveBeenCalledWith('skill-submission-1', { versionId: 'skill-submission-version-1', visibleRoleIds: ['role-sales'] })
  })

  it('其他管理员发起、已结束待查看的试运行：说明原因并可重新试运行', async () => {
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item({ trial: { status: 'unconfirmed', runId: 'run-other' } })])
    vi.spyOn(adminApi, 'getSkillSubmission').mockResolvedValue(detail({ trial: { status: 'unconfirmed', runId: 'run-other' } }))
    vi.spyOn(adminApi, 'getSkillSubmissionFile').mockResolvedValue({ path: 'SKILL.md', size: 120, content: 'x' })
    vi.spyOn(adminApi, 'getSkillSubmissionTestRun').mockRejectedValue(new Error('试运行启动快照不存在'))
    const wrapper = await render()
    await button(wrapper, '审核').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('结果待发起的管理员查看')
    expect(button(wrapper, '通过并发布').attributes('disabled')).toBeDefined()
    expect(button(wrapper, '重新试运行').exists()).toBe(true)
  })

  it('只读管理员看不到审核操作', async () => {
    vi.spyOn(adminApi, 'getSkillSubmissions').mockResolvedValue([item()])
    vi.spyOn(adminApi, 'getSkillSubmission').mockResolvedValue(detail())
    vi.spyOn(adminApi, 'getSkillSubmissionFile').mockResolvedValue({ path: 'SKILL.md', size: 120, content: 'x' })
    const wrapper = await render(false)
    await button(wrapper, '审核').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('button').some(candidate => candidate.text().includes('通过并发布'))).toBe(false)
    expect(wrapper.findAll('button').some(candidate => candidate.text().includes('试运行'))).toBe(false)
  })
})
