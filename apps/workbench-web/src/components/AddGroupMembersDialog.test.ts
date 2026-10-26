import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import AddGroupMembersDialog from './AddGroupMembersDialog.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    listWorkspaceAgentCandidates: vi.fn(),
    listMemberCandidates: vi.fn(),
    previewMemberDisclosureImpact: vi.fn(),
    addWorkspaceAgentMember: vi.fn(),
    addWorkspaceMember: vi.fn(),
  },
}))
const confirm = vi.hoisted(() => vi.fn())
vi.mock('element-plus', async importOriginal => {
  const actual = await importOriginal<typeof import('element-plus')>()
  return { ...actual, ElMessageBox: { ...actual.ElMessageBox, confirm } }
})
const notifyActionFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure }))

function mountDialog(canAddAgents = true) {
  return mount(AddGroupMembersDialog, {
    props: { open: true, workspaceId: 'ws-1', workspaceName: '采购协同', canAddAgents },
    global: {
      plugins: [ElementPlus],
      stubs: { ElDialog: { props: ['modelValue', 'title'], template: '<div v-if="modelValue"><h2>{{ title }}</h2><slot /><slot name="footer" /></div>' } },
    },
  })
}

function checkbox(wrapper: ReturnType<typeof mountDialog>, text: string) {
  const label = wrapper.findAll('label.el-checkbox').find(item => item.attributes('aria-label') === text || item.text().includes(text))
  if (!label) throw new Error(`没有找到勾选框：${text}`)
  return label.get('input[type="checkbox"]')
}
const addButton = (wrapper: ReturnType<typeof mountDialog>) => wrapper.findAll('button').find(button => button.text().startsWith('添加'))!

beforeEach(() => {
  vi.mocked(workbenchApi.listWorkspaceAgentCandidates).mockResolvedValue({
    items: [{ agentId: 'a1', name: '库存助手', description: '库存', activeVersionId: 'v1', activeVersion: '1', status: 'published' }],
    nextCursor: null,
  } as never)
  vi.mocked(workbenchApi.listMemberCandidates).mockResolvedValue({
    items: [{ id: 'u2', displayName: '周衡', department: '计划部' }, { id: 'u3', displayName: '赵宁', department: '采购部' }],
    nextCursor: null,
  })
  vi.mocked(workbenchApi.previewMemberDisclosureImpact).mockResolvedValue([])
  vi.mocked(workbenchApi.addWorkspaceAgentMember).mockResolvedValue({} as never)
  vi.mocked(workbenchApi.addWorkspaceMember).mockResolvedValue({} as never)
})
afterEach(() => vi.clearAllMocks())

describe('AddGroupMembersDialog', () => {
  it('列出本空间的 AI 同事与同事候选，选中后逐个加入', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(workbenchApi.listWorkspaceAgentCandidates).toHaveBeenCalledWith('ws-1', { query: undefined, cursor: undefined, limit: 30 })
    expect(workbenchApi.listMemberCandidates).toHaveBeenCalledWith('ws-1', { query: undefined, cursor: undefined, limit: 30 })
    expect(addButton(wrapper).attributes('disabled')).toBeDefined()

    await checkbox(wrapper, '库存助手').setValue(true)
    await checkbox(wrapper, '赵宁').setValue(true)
    expect(addButton(wrapper).text()).toBe('添加 2 位')
    await addButton(wrapper).trigger('click')
    await flushPromises()

    expect(workbenchApi.addWorkspaceAgentMember).toHaveBeenCalledWith('ws-1', { agentId: 'a1' })
    expect(workbenchApi.addWorkspaceMember).toHaveBeenCalledWith('ws-1', { userId: 'u3', role: 'member' })
    expect(wrapper.emitted('added')).toHaveLength(1)
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('非负责人只显示同事一栏，不读取 AI 同事候选', async () => {
    const wrapper = mountDialog(false)
    await flushPromises()
    expect(workbenchApi.listWorkspaceAgentCandidates).not.toHaveBeenCalled()
    expect(wrapper.find('section[aria-label="AI 同事"]').exists()).toBe(false)
    expect(wrapper.find('section[aria-label="同事"]').exists()).toBe(true)
  })

  it('多位同事的数据范围影响合并后确认，取消则不添加', async () => {
    vi.mocked(workbenchApi.previewMemberDisclosureImpact).mockImplementation(async (_workspaceId, userId) => (
      userId === 'u2'
        ? [{ agentMemberId: 'wam-1', name: '库存助手', lostDataScopes: ['华东库存'] }]
        : [{ agentMemberId: 'wam-1', name: '库存助手', lostDataScopes: ['华南库存'] }]
    ))
    confirm.mockRejectedValue('cancel')
    const wrapper = mountDialog()
    await flushPromises()
    await checkbox(wrapper, '全选同事').setValue(true)
    await addButton(wrapper).trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('“库存助手”将不能再使用：华东库存、华南库存'), expect.any(String), expect.any(Object))
    expect(workbenchApi.addWorkspaceMember).not.toHaveBeenCalled()
    expect(wrapper.emitted('added')).toBeUndefined()
  })

  it('部分失败时列出未加入的成员并保留其选择', async () => {
    vi.mocked(workbenchApi.addWorkspaceMember).mockImplementation(async (_workspaceId, input) => {
      if (input.userId === 'u3') throw new Error('该员工已停用，不能添加为成员')
      return {} as never
    })
    const wrapper = mountDialog()
    await flushPromises()
    await checkbox(wrapper, '全选同事').setValue(true)
    await addButton(wrapper).trigger('click')
    await flushPromises()

    expect(notifyActionFailure).toHaveBeenCalledWith('添加成员', '“赵宁”', expect.any(Error), expect.stringContaining('其余 1 位已加入'))
    expect(wrapper.emitted('added')).toHaveLength(1)
    expect(wrapper.emitted('update:open')).toBeUndefined()
    expect(wrapper.get('aside[aria-label="已选成员"]').text()).toContain('已选 1')
    expect(wrapper.get('aside[aria-label="已选成员"]').text()).toContain('赵宁')
  })
})
