import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentDraftDialog from './AgentDraftDialog.vue'
import { useContentStore } from '../stores/content'
import type { AgentDefinition } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
})

const importedAgent: AgentDefinition = {
  id: 'refund-risk-assistant',
  name: '退款预测助手',
  description: '基于历史退款记录预测高风险订单并给出处理建议。',
  owner: '平台管理员',
  department: '数字化中心',
  visibility: '全体试点员工',
  roleIds: ['role-employee'],
  allowWorkspaceJoin: true,
  status: 'draft',
  version: '0.1.0',
  welcomeMessage: '请提供需要分析的订单范围。',
  examplePrompts: ['分析本周退款风险'],
  systemPrompt: '你是退款风险分析助手，仅使用当前员工已授权的数据完成分析。',
  maxOutputBytes: 65536,
  maxToolCalls: 20,
  timeoutSeconds: 300,
  skills: ['refund-risk@0.1.0'],
  tools: [],
  updatedAt: '2026-09-16 14:00',
}

describe('AgentDraftDialog config completion', () => {
  it('only offers interface configuration and continues to trial after saving', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore()
    vi.spyOn(contentStore, 'updateAgentDraft').mockResolvedValue(importedAgent)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: true, agent: importedAgent },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: { teleport: true, ElSelect: { template: '<div class="el-select-stub"><slot /></div>' }, ElOption: true },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).not.toContain('ZIP 导入')
    const next = () => wrapper.findAll('button').find(button => button.text() === '下一步')!
    await next().trigger('click')
    await flushPromises()
    await next().trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '保存修改')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Agent 草稿已保存')
    expect(wrapper.emitted('saved')).toEqual([[importedAgent]])
    expect(wrapper.emitted('continue-release')).toBeUndefined()
    await wrapper.findAll('button').find(button => button.text() === '进入验证与发布')!.trigger('click')
    expect(wrapper.emitted('continue-release')).toEqual([[importedAgent]])
  })

  it('saves an edited draft with the revision read when the editor opened', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore()
    const editable = {
      ...importedAgent,
      revision: 'rev-editor-1',
      tools: ['tool-runtime-file-read@1.0.0'],
    }
    const update = vi.spyOn(contentStore, 'updateAgentDraft').mockResolvedValue(editable)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: false, agent: editable },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: true,
        },
      },
    })
    wrappers.push(wrapper)
    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    const next = () => wrapper.findAll('button').find(button => button.text() === '下一步')!
    await next().trigger('click')
    await flushPromises()
    await next().trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '保存修改')!.trigger('click')
    await flushPromises()

    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('delegationPolicy')
    // F-05：保存时回传打开编辑器时读取的修订，供服务端拒绝过期编辑。
    expect(update.mock.calls[0]?.[1]).toBe('rev-editor-1')
  })

  it('allows a Soul-only Agent draft without Skill or tool references', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore()
    const editable = { ...importedAgent, skills: [], tools: [] }
    const update = vi.spyOn(contentStore, 'updateAgentDraft').mockResolvedValue(editable)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: false, agent: editable },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: true,
        },
      },
    })
    wrappers.push(wrapper)
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    expect(wrapper.text()).toContain('SOUL.md（人格与工作原则）')
    const next = () => wrapper.findAll('button').find(button => button.text() === '下一步')!
    await next().trigger('click')
    await flushPromises()
    await next().trigger('click')
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '保存修改')!.trigger('click')
    await flushPromises()
    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0]?.[0].skills).toEqual([])
    expect(update.mock.calls[0]?.[0].tools).toEqual([])
  })

  it('shows Skill and MCP scope without exposing the DSH tool allow-list', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: true, agent: { ...importedAgent, skills: [], tools: [] } },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: { props: ['label'], template: '<span class="el-option-stub">{{ label }}</span>' },
        },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '下一步')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('不使用 MCP（默认）')
    expect(wrapper.text()).toContain('仅使用选定 MCP')
    expect(wrapper.text()).toContain('不使用 MCP')
    expect(wrapper.text()).not.toContain('工具允许列表')
  })
})
