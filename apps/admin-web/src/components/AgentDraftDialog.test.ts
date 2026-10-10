import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentDraftDialog from './AgentDraftDialog.vue'
import { adminApi } from '../api/client'
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
  files: ['agent.yaml', 'SOUL.md'],
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

    const creationModes = wrapper.find('[aria-label="选择 Agent 创建方式"]').findAll('input[type="radio"]')
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
          AgentZipImportPanel: ZipImportStub,
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
          AgentZipImportPanel: ZipImportStub,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: { props: ['label'], template: '<span class="el-option-stub">{{ label }}</span>' },
        },
      },
    })
    wrappers.push(wrapper)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '下一步')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('全部可用 MCP（默认）')
    expect(wrapper.text()).toContain('仅使用选定 MCP')
    expect(wrapper.text()).toContain('不使用 MCP')
    expect(wrapper.text()).not.toContain('工具允许列表')
  })
})

describe('AgentDraftDialog 角色目录与执行授权', () => {
  function mountCreateDialog() {
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.spyOn(adminApi, 'getAgentPrincipalRoleOptions').mockResolvedValue([
      { id: 'role-employee', name: '普通员工', status: 'active' },
      { id: 'role-department-manager', name: '部门负责人', status: 'active' },
      { id: 'role-platform-admin', name: '平台管理员', status: 'active' },
      { id: 'role-retired', name: '已停用角色', status: 'disabled' },
    ])
    const wrapper = mount(AgentDraftDialog, {
      props: { modelValue: true },
      global: {
        plugins: [pinia, ElementPlus],
        stubs: {
          teleport: true,
          AgentZipImportPanel: ZipImportStub,
          ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
          ElOption: { props: ['label'], template: '<span class="el-option-stub">{{ label }}</span>' },
        },
      },
    })
    wrappers.push(wrapper)
    return wrapper
  }

  it('可见角色选项来自服务端角色目录，不再用本地映射伪造不存在的角色', async () => {
    const wrapper = mountCreateDialog()
    await flushPromises()

    const labels = wrapper.findAll('.el-option-stub').map(option => option.text())
    // 真实角色目录中的「部门负责人」此前无法表达；不存在的死 id 此前会被显示成
    // 「部门负责人」「供应链分析人员」，让创建者以为已经选中了真实角色。
    expect(labels).toContain('部门负责人')
    expect(labels).not.toContain('供应链分析人员')
    // 角色目录只提供启用中的角色，停用角色不作为可选范围。
    expect(labels).not.toContain('已停用角色')
  })

  it('执行授权留空时给出警告与确认项，一键「与可见范围相同」后消失', async () => {
    const wrapper = mountCreateDialog()
    await flushPromises()

    // 新建时默认不授予执行身份（AE-02），但后果必须显式告知而不是留给试运行阶段暴露。
    expect(wrapper.text()).toContain('执行授权留空：该 Agent 无法试运行，因而无法发布')
    expect(wrapper.text()).toContain('我确认暂不授予执行身份')

    const copyButton = wrapper.findAll('button').find(button => button.text() === '与可见范围相同')
    expect(copyButton).toBeDefined()
    await copyButton!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('执行授权留空：该 Agent 无法试运行，因而无法发布')
    expect(wrapper.text()).not.toContain('我确认暂不授予执行身份')
  })
})
