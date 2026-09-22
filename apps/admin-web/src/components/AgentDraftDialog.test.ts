import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentDraftDialog from './AgentDraftDialog.vue'
import type { ZipInspection } from '../stores/agentGovernance'
import { useContentStore } from '../stores/content'
import type { AgentDefinition, AgentVersionRecord } from '../types/domain'

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
  dataScopes: ['workspace:authorized'],
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
  delegationPolicy: { allowedAgentVersionIds: [], maxDepth: 1, maxParallel: 1, timeoutSeconds: 120 },
  updatedAt: '2026-09-16 14:00',
}

const inspection: ZipInspection = {
  fileName: 'refund-risk-agent.zip',
  manifest: {
    id: importedAgent.id,
    name: importedAgent.name,
    version: importedAgent.version,
    description: importedAgent.description,
  },
  files: ['agent.yaml', 'prompts/system.md'],
  systemPrompt: importedAgent.systemPrompt,
  resolved: { skills: [], tools: [] },
  missing: { skills: [], tools: ['refund.lookup@1.0.0'] },
  packageRefs: { skills: [], tools: [] },
  cases: [],
  warnings: [],
}

const ZipImportStub = defineComponent({
  name: 'AgentZipImportPanel',
  emits: ['saved'],
  setup(_, { emit, expose }) {
    const parsed = ref(true)
    const importing = ref(false)
    function importAsDraft() {
      emit('saved', importedAgent, inspection)
    }
    expose({ parsed, importing, importAsDraft })
    return () => h('div', { 'data-testid': 'zip-import-stub' }, 'ZIP 解析预览')
  },
})

describe('AgentDraftDialog import completion', () => {
  it('keeps the result in the dialog and only continues after an explicit action', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: true },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          AgentZipImportPanel: ZipImportStub,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: true,
        },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()

    const creationModes = wrapper.findAll('input[type="radio"]')
    expect(creationModes).toHaveLength(2)
    await creationModes[1]!.setValue(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="zip-import-stub"]').exists()).toBe(true)

    await wrapper.get('[data-action="confirm-zip-import"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已导入为 Agent 草稿')
    expect(wrapper.text()).toContain('草稿已保存在 Agent 管理中')
    expect(wrapper.text()).toContain('草稿仍有 1 个依赖待处理')
    expect(wrapper.emitted('saved')).toEqual([[importedAgent, 'zip']])
    expect(wrapper.emitted('continue-release')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    const continueButton = wrapper.findAll('button').find(button => button.text() === '进入定义与依赖')
    expect(continueButton).toBeDefined()
    await continueButton!.trigger('click')

    expect(wrapper.emitted('continue-release')).toEqual([[importedAgent]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('preserves an exact published-version delegation policy when saving a draft', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore()
    const targetVersion = {
      id: 'agent-version-specialist-1', agentId: 'specialist', version: '1.2.0', status: 'published',
    } as AgentVersionRecord
    contentStore.agentVersions = [targetVersion]
    contentStore.agents = [{ ...importedAgent, id: 'specialist', name: '专项分析 Agent', status: 'published', version: '1.2.0' }]
    const editable = {
      ...importedAgent,
      tools: ['tool-runtime-file-read@1.0.0'],
      delegationPolicy: {
        allowedAgentVersionIds: [targetVersion.id], maxDepth: 2, maxParallel: 3, timeoutSeconds: 90,
      },
    }
    const update = vi.spyOn(contentStore, 'updateAgentDraft').mockResolvedValue(editable)
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: false, agent: editable },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          AgentZipImportPanel: ZipImportStub,
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
    expect(wrapper.text()).toContain('1 个目标')
    expect(wrapper.text()).toContain('深度 2 · 并行 3')
    await wrapper.findAll('button').find(button => button.text() === '保存修改')!.trigger('click')
    await flushPromises()

    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0]?.[0].delegationPolicy).toEqual(editable.delegationPolicy)
  })
})
