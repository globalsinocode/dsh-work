import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentAccess, AgentDefinition, AgentVersionRecord } from '@/types/domain'
import AgentDraftView from './AgentDraftView.vue'

afterEach(() => vi.restoreAllMocks())

const draftAgent: AgentDefinition = {
  id: 'agent-draft-ui', name: '草稿流程 Agent', description: '用于验证草稿编辑流程的步骤与发布跳转。', owner: '陈默',
  department: 'platform', visibility: '未设置', roleIds: [], allowWorkspaceJoin: false,
  status: 'draft', version: '0.1.0', activeVersion: null,
  welcomeMessage: '', examplePrompts: ['请介绍你能提供哪些帮助'], systemPrompt: '你是测试 Agent，只处理当前输入并说明依据。',
  workInstructions: '', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  skills: [], tools: [], mcpScope: { mode: 'none', connectorIds: [] }, updatedAt: '2026-10-16 08:00', revision: 'rev-1',
}

function versionRecord(agent: AgentDefinition, version: string, status: AgentVersionRecord['status']): AgentVersionRecord {
  return {
    id: `agent-version-${version}`, agentId: agent.id, version, status, createdAt: '2026-10-16 08:00', createdBy: '陈默',
    summary: '', welcomeMessage: '', examplePrompts: [], systemPrompt: agent.systemPrompt,
    maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [], tools: [],
  }
}

const Empty = defineComponent({ render: () => h('div') })
// 验证与发布的交互由 AgentReleasePanel 自身的测试覆盖；这里只关心流程如何响应它的事件。
const ReleasePanelStub = defineComponent({
  name: 'AgentReleasePanel',
  props: { agentId: String, active: Boolean },
  emits: ['published', 'open-access', 'edit'],
  setup(_props, { emit, expose }) {
    expose({ reload: () => undefined })
    return () => h('div', { class: 'release-stub' }, [
      h('button', { 'data-test': 'publish', onClick: () => emit('published', '0.1.0') }, 'publish'),
      h('button', { 'data-test': 'open-access', onClick: () => emit('open-access') }, 'access'),
    ])
  },
})

// 角色与权限一步由流程在离开时检查必填并调用 save；测试控制结果。
const accessSave = vi.fn<(options?: { confirm?: boolean }) => Promise<boolean>>(async () => true)
const accessValidate = vi.fn<() => boolean>(() => true)
const AccessPanelStub = defineComponent({
  name: 'AgentAccessPanel',
  props: { agentId: String, canManage: Boolean, embedded: Boolean },
  setup(props, { expose }) {
    expose({ save: accessSave, validateRequired: accessValidate, dirty: true })
    return () => h('div', { class: 'access-stub', 'data-embedded': String(props.embedded) })
  },
})

function accessFixture(overrides: Partial<AgentAccess> = {}): AgentAccess {
  return {
    agentId: draftAgent.id, revision: 2, principalId: `principal-agent-${draftAgent.id}`, principalStatus: 'active',
    visibleRoleIds: ['role-employee'], roleIds: ['role-employee'], dataScopes: [],
    roleOptions: [{ id: 'role-employee', name: '普通员工', status: 'active' }], scopeOptions: [],
    capabilities: [], routines: [],
    ...overrides,
  }
}

async function mountDraft(options: {
  agent?: AgentDefinition; versions?: AgentVersionRecord[]; step?: string; permissions?: string[]
} = {}) {
  const agent = options.agent ?? draftAgent
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: options.permissions ?? ['admin:write'] })
  const content = useContentStore()
  content.$patch({ agents: [agent], agentVersions: options.versions ?? [versionRecord(agent, agent.version, 'draft')] })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessFixture())
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:agentId/draft', name: 'agent-draft', component: AgentDraftView },
    { path: '/agents/:agentId', name: 'agent-detail', component: Empty },
    { path: '/agents', component: Empty },
  ] })
  await router.push({ name: 'agent-draft', params: { agentId: agent.id }, query: options.step ? { step: options.step } : {} })
  await router.isReady()
  const wrapper = mount(AgentDraftView, { global: { plugins: [pinia, router, ElementPlus], stubs: {
    teleport: true,
    ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
    ElOption: true,
    ElDrawer: { props: ['modelValue'], template: '<div v-if="modelValue" class="drawer-stub"><slot /></div>' },
    AgentAccessPanel: AccessPanelStub,
    AgentReleasePanel: ReleasePanelStub,
  } } })
  await flushPromises()
  return { wrapper, router }
}

function stepLabels(wrapper: Awaited<ReturnType<typeof mountDraft>>['wrapper']) {
  return wrapper.findAll('nav[aria-label="编辑步骤"] .draft-step strong').map(item => item.text())
}

it('从未发布的 Agent 按四步编辑：职责与人格、能力、角色与权限、验证与发布', async () => {
  const { wrapper } = await mountDraft()
  try {
    expect(stepLabels(wrapper)).toEqual(['职责与人格', '能力', '角色与权限', '验证与发布'])
    expect(wrapper.get('[aria-current="step"]').text()).toContain('职责与人格')
    expect(wrapper.get('[data-testid="draft-version-label"]').text()).toBe('草稿 v0.1.0 · 尚未发布')
    expect(wrapper.get('[data-testid="draft-save-status"]').text()).toBe('草稿与服务端一致')
    // 已选择可见角色与岗位角色时步骤显示已完成。
    expect(wrapper.get('[aria-label^="3. 角色与权限"]').attributes('aria-label')).toBe('3. 角色与权限，已完成')
  } finally {
    wrapper.unmount()
  }
})

it('已发布的 Agent 不显示角色与权限步骤，岗位权限留在详情页', async () => {
  const published: AgentDefinition = { ...draftAgent, status: 'published', version: '0.2.0', activeVersion: '0.1.0', roleIds: ['role-employee'] }
  const { wrapper } = await mountDraft({
    agent: published, versions: [versionRecord(published, '0.2.0', 'draft'), versionRecord(published, '0.1.0', 'published')],
  })
  try {
    expect(stepLabels(wrapper)).toEqual(['职责与人格', '能力', '验证与发布'])
    expect(wrapper.get('[data-testid="draft-version-label"]').text()).toBe('草稿 v0.2.0 · 基于 v0.1.0')
  } finally {
    wrapper.unmount()
  }
})

it('下一步写入地址；验证与发布中调整岗位权限在抽屉中完成，不离开流程', async () => {
  const { wrapper, router } = await mountDraft()
  try {
    await wrapper.get('[data-action="next-step"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.step).toBe('capabilities')
    expect(wrapper.get('[aria-current="step"]').text()).toContain('能力')

    await wrapper.findAll('.draft-step').find(item => item.text().includes('验证与发布'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.step).toBe('release')
    expect(wrapper.find('[data-action="next-step"]').exists()).toBe(false)
    await wrapper.get('[data-test="open-access"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.drawer-stub .access-stub').exists()).toBe(true)
    expect(router.currentRoute.value.name).toBe('agent-draft')
  } finally {
    wrapper.unmount()
  }
})

it('发布成功后回到详情页的版本历史；退出编辑回到概览', async () => {
  const published = await mountDraft({ step: 'release' })
  try {
    await published.wrapper.get('[data-test="publish"]').trigger('click')
    await flushPromises()
    expect(published.router.currentRoute.value.name).toBe('agent-detail')
    expect(published.router.currentRoute.value.query.section).toBe('versions')
  } finally {
    published.wrapper.unmount()
  }
  const exiting = await mountDraft()
  try {
    await exiting.wrapper.get('[data-action="exit-draft"]').trigger('click')
    await flushPromises()
    expect(exiting.router.currentRoute.value.name).toBe('agent-detail')
    expect(exiting.router.currentRoute.value.query.section).toBeUndefined()
  } finally {
    exiting.wrapper.unmount()
  }
})

it('安全审计员以只读方式查看待发布版本：没有保存状态，字段只读', async () => {
  const { wrapper } = await mountDraft({ permissions: ['admin:read'] })
  try {
    expect(wrapper.text()).toContain('查看待发布版本')
    expect(wrapper.find('[data-testid="draft-save-status"]').exists()).toBe(false)
    expect(wrapper.find('input[readonly]').exists()).toBe(true)
    expect(wrapper.get('[data-action="exit-draft"]').text()).toBe('返回详情')
  } finally {
    wrapper.unmount()
  }
})

it('角色与权限没有单独的保存按钮：必填未完成或保存失败时停留在本步，返回上一步不拦截', async () => {
  const { wrapper, router } = await mountDraft({ step: 'audience' })
  try {
    expect(wrapper.get('.access-stub').attributes('data-embedded')).toBe('true')
    accessValidate.mockReturnValueOnce(false)
    accessSave.mockClear()
    await wrapper.get('[data-action="next-step"]').trigger('click')
    await flushPromises()
    expect(accessSave).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query.step).toBe('audience')

    accessSave.mockResolvedValueOnce(false)
    await wrapper.get('[data-action="next-step"]').trigger('click')
    await flushPromises()
    expect(accessSave).toHaveBeenLastCalledWith({ confirm: false })
    expect(router.currentRoute.value.query.step).toBe('audience')

    accessValidate.mockReturnValueOnce(false)
    await wrapper.get('[data-action="previous-step"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.step).toBe('capabilities')
  } finally {
    wrapper.unmount()
  }
})

it('从未发布的 Agent 未选岗位角色时不能直接进入验证与发布，也不自动授予', async () => {
  const { wrapper, router } = await mountDraft({ step: 'capabilities' })
  vi.mocked(adminApi.getAgentAccess).mockResolvedValue(accessFixture({ roleIds: [] }))
  const update = vi.spyOn(adminApi, 'updateAgentAccess')
  try {
    await wrapper.findAll('.draft-step').find(item => item.text().includes('验证与发布'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.step).toBe('audience')
    expect(wrapper.get('[aria-label^="3. 角色与权限"]').attributes('aria-label')).toBe('3. 角色与权限，待设置')
    expect(update).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})
