import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import CreateProjectSpaceDialog from './CreateProjectSpaceDialog.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getAgents: vi.fn(),
    createWorkspace: vi.fn(),
    listNewSpaceMemberCandidates: vi.fn(),
    previewNewSpaceDisclosureImpact: vi.fn(),
  },
}))
const confirm = vi.hoisted(() => vi.fn())
vi.mock('element-plus', async importOriginal => {
  const actual = await importOriginal<typeof import('element-plus')>()
  return { ...actual, ElMessageBox: { ...actual.ElMessageBox, confirm } }
})
const notifyActionFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure }))

function agent(id: string, name: string) {
  return { id, name, description: `${name}岗位`, welcomeMessage: '', version: '1', examplePrompts: [] }
}

function mountDialog(mode: 'work' | 'collab' = 'collab') {
  setActivePinia(createPinia())
  return mount(CreateProjectSpaceDialog, {
    props: { modelValue: true, mode },
    global: {
      plugins: [ElementPlus],
      stubs: { ElDialog: { props: ['modelValue', 'title'], template: '<div v-if="modelValue"><h2>{{ title }}</h2><slot /><slot name="footer" /></div>' } },
    },
  })
}

const submitButton = (wrapper: ReturnType<typeof mountDialog>) =>
  wrapper.findAll('button').find(button => /创建/.test(button.text()))!

/** 按行文字找到成员选择器里的勾选框（栏标题用 aria-label，例如“全选同事”）。 */
function checkbox(wrapper: ReturnType<typeof mountDialog>, text: string) {
  const label = wrapper.findAll('label.el-checkbox').find(item => item.attributes('aria-label') === text || item.text().includes(text))
  if (!label) throw new Error(`没有找到勾选框：${text}`)
  return label.get('input[type="checkbox"]')
}
const isChecked = (wrapper: ReturnType<typeof mountDialog>, text: string) =>
  (checkbox(wrapper, text).element as HTMLInputElement).checked

beforeEach(() => {
  vi.mocked(workbenchApi.getAgents).mockResolvedValue([agent('a1', '库存助手'), agent('a2', '报表助手')] as never)
  vi.mocked(workbenchApi.listNewSpaceMemberCandidates).mockResolvedValue({
    items: [{ id: 'u2', displayName: '周衡', department: '计划部' }, { id: 'u3', displayName: '赵宁', department: '采购部' }],
    nextCursor: null,
  })
  vi.mocked(workbenchApi.previewNewSpaceDisclosureImpact).mockResolvedValue([])
})
afterEach(() => vi.clearAllMocks())

describe('CreateProjectSpaceDialog', () => {
  it('没有选择 AI 同事时不能提交并提示', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('至少选择一位 AI 同事')
    expect(wrapper.text()).toContain('新建群组')
    // 只选同事仍不能提交。
    await checkbox(wrapper, '周衡').setValue(true)
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('只有一位 AI 同事时默认选中', async () => {
    vi.mocked(workbenchApi.getAgents).mockResolvedValue([agent('a1', '库存助手')] as never)
    const wrapper = mountDialog('work')
    await flushPromises()
    expect(isChecked(wrapper, '库存助手')).toBe(true)
    expect(wrapper.text()).toContain('创建项目空间')
    await wrapper.get('input[aria-label="项目空间名称"]').setValue('九月交付')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('两栏列出 AI 同事与同事，“已选”汇总并可移除', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(workbenchApi.listNewSpaceMemberCandidates).toHaveBeenCalledWith({ query: undefined, cursor: undefined, limit: 30 })
    await checkbox(wrapper, '报表助手').setValue(true)
    await checkbox(wrapper, '赵宁').setValue(true)
    const selected = wrapper.get('aside[aria-label="已选成员"]')
    expect(selected.text()).toContain('已选 2')
    expect(selected.text()).toContain('报表助手')
    expect(selected.text()).toContain('赵宁')
    await selected.get('button[aria-label="移除 赵宁"]').trigger('click')
    expect(isChecked(wrapper, '赵宁')).toBe(false)
    expect(selected.text()).toContain('已选 1')
  })

  it('栏标题全选只作用于当前显示的行', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await checkbox(wrapper, '全选同事').setValue(true)
    expect(isChecked(wrapper, '周衡')).toBe(true)
    expect(isChecked(wrapper, '赵宁')).toBe(true)
    expect(isChecked(wrapper, '库存助手')).toBe(false)

    await wrapper.get('input[aria-label="搜索 AI 同事或同事"]').setValue('报表')
    await checkbox(wrapper, '全选 AI 同事').setValue(true)
    await wrapper.get('input[aria-label="搜索 AI 同事或同事"]').setValue('')
    expect(isChecked(wrapper, '报表助手')).toBe(true)
    expect(isChecked(wrapper, '库存助手')).toBe(false)
  })

  it('搜索按关键词检索同事', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountDialog()
      await flushPromises()
      await wrapper.get('input[aria-label="搜索 AI 同事或同事"]').setValue('赵')
      await vi.advanceTimersByTimeAsync(300)
      expect(workbenchApi.listNewSpaceMemberCandidates).toHaveBeenLastCalledWith({ query: '赵', cursor: undefined, limit: 30 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('提交 name、description、agentIds 并通知上层', async () => {
    const created = { id: 'w9', name: '采购协同' }
    vi.mocked(workbenchApi.createWorkspace).mockResolvedValue(created as never)
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue(' 采购协同 ')
    await wrapper.get('textarea').setValue('跟进采购')
    await checkbox(wrapper, '报表助手').setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(workbenchApi.previewNewSpaceDisclosureImpact).not.toHaveBeenCalled()
    expect(workbenchApi.createWorkspace).toHaveBeenCalledWith({ name: '采购协同', description: '跟进采购', agentIds: ['a2'] })
    expect(wrapper.emitted('created')?.[0]).toEqual([created])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('选了同事时一并提交，先预览数据范围影响', async () => {
    vi.mocked(workbenchApi.createWorkspace).mockResolvedValue({ id: 'w9', name: '采购协同' } as never)
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    await checkbox(wrapper, '库存助手').setValue(true)
    await checkbox(wrapper, '周衡').setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(workbenchApi.previewNewSpaceDisclosureImpact).toHaveBeenCalledWith({ agentIds: ['a1'], memberUserIds: ['u2'] })
    expect(confirm).not.toHaveBeenCalled()
    expect(workbenchApi.createWorkspace).toHaveBeenCalledWith({ name: '采购协同', description: '团队共享的对话、文件与成果协作空间。', agentIds: ['a1'], memberUserIds: ['u2'] })
  })

  it('数据范围会缩小时需确认，取消则不创建', async () => {
    vi.mocked(workbenchApi.previewNewSpaceDisclosureImpact).mockResolvedValue([{ agentId: 'a1', name: '库存助手', lostDataScopes: ['华东库存'] }])
    confirm.mockRejectedValue('cancel')
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    await checkbox(wrapper, '库存助手').setValue(true)
    await checkbox(wrapper, '赵宁').setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('“库存助手”将不能再使用：华东库存'), expect.any(String), expect.any(Object))
    expect(workbenchApi.createWorkspace).not.toHaveBeenCalled()
    expect(isChecked(wrapper, '赵宁')).toBe(true)

    confirm.mockResolvedValue('confirm')
    vi.mocked(workbenchApi.createWorkspace).mockResolvedValue({ id: 'w9', name: '采购协同' } as never)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(workbenchApi.createWorkspace).toHaveBeenCalledTimes(1)
  })

  it('同事加载失败不影响只选 AI 同事创建', async () => {
    vi.mocked(workbenchApi.listNewSpaceMemberCandidates).mockRejectedValue(new Error('同事目录暂不可用'))
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.text()).toContain('同事目录暂不可用')
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    await checkbox(wrapper, '库存助手').setValue(true)
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('创建失败时保留输入并提示原因', async () => {
    vi.mocked(workbenchApi.createWorkspace).mockRejectedValue(new Error('AI 同事已下线'))
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    await checkbox(wrapper, '库存助手').setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(notifyActionFailure).toHaveBeenCalledWith('创建', expect.any(String), expect.any(Error), '检查所选 AI 同事与同事是否仍可加入后重试。')
    expect((wrapper.get('input[aria-label="群组名称"]').element as HTMLInputElement).value).toBe('采购协同')
    expect(wrapper.emitted('created')).toBeUndefined()
  })
})
