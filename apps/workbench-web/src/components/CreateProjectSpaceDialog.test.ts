import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import CreateProjectSpaceDialog from './CreateProjectSpaceDialog.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: { getAgents: vi.fn(), createWorkspace: vi.fn() },
}))
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

beforeEach(() => {
  vi.mocked(workbenchApi.getAgents).mockResolvedValue([agent('a1', '库存助手'), agent('a2', '报表助手')] as never)
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
  })

  it('只有一位 AI 同事时默认选中', async () => {
    vi.mocked(workbenchApi.getAgents).mockResolvedValue([agent('a1', '库存助手')] as never)
    const wrapper = mountDialog('work')
    await flushPromises()
    expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('创建项目空间')
    await wrapper.get('input[aria-label="项目空间名称"]').setValue('九月交付')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('提交 name、description、agentIds 并通知上层', async () => {
    const created = { id: 'w9', name: '采购协同' }
    vi.mocked(workbenchApi.createWorkspace).mockResolvedValue(created as never)
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue(' 采购协同 ')
    await wrapper.get('textarea').setValue('跟进采购')
    await wrapper.findAll('input[type="checkbox"]')[1]!.setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(workbenchApi.createWorkspace).toHaveBeenCalledWith({ name: '采购协同', description: '跟进采购', agentIds: ['a2'] })
    expect(wrapper.emitted('created')?.[0]).toEqual([created])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('创建失败时保留输入并提示原因', async () => {
    vi.mocked(workbenchApi.createWorkspace).mockRejectedValue(new Error('AI 同事已下线'))
    const wrapper = mountDialog()
    await flushPromises()
    await wrapper.get('input[aria-label="群组名称"]').setValue('采购协同')
    await wrapper.findAll('input[type="checkbox"]')[0]!.setValue(true)
    await submitButton(wrapper).trigger('click')
    await flushPromises()
    expect(notifyActionFailure).toHaveBeenCalledWith('创建', expect.any(String), expect.any(Error), '检查所选 AI 同事是否仍可用后重试。')
    expect((wrapper.get('input[aria-label="群组名称"]').element as HTMLInputElement).value).toBe('采购协同')
    expect(wrapper.emitted('created')).toBeUndefined()
  })
})
