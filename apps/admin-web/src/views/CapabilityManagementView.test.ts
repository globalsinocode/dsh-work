import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CapabilityManagementView from './CapabilityManagementView.vue'
import { useAuthStore } from '../stores/auth'
import { useContentStore } from '../stores/content'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function render(canManage = true, initial = '/capabilities') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: canManage ? ['admin:write'] : ['admin:read'] })
  const content = useContentStore()
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/capabilities', component: CapabilityManagementView }] })
  await router.push(initial)
  await router.isReady()
  const wrapper = mount(CapabilityManagementView, { global: { plugins: [pinia, router, ElementPlus], stubs: { teleport: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, auth: useAuthStore(), content }
}

function strictDraftSkill(): import('../types/domain').SkillDefinition {
  return {
    packageSha256: 'sha256-package',
    id: 'skill-strict-test',
    name: '严格试运行 Skill',
    version: '0.1.0',
    category: '测试',
    owner: '平台管理员',
    status: 'draft',
    description: '用于验证严格试运行交互反馈。',
    instructions: '先激活 Skill，然后按照测试输入完成验证并返回结果。',
    toolIds: [],
    testPrompt: '验证当前 Skill',
    updatedAt: '2026-09-13 15:00',
  }
}

describe('Skill installation sibling tab', () => {
  it('opens the dedicated tab, removes the old create dialog, and preserves inputs across tabs', async () => {
    const { wrapper, router } = await render()
    expect(wrapper.findAll('[role="tablist"][aria-label="能力类型"] [role="tab"]').map(tab => tab.text())).toEqual(['Skill 中心 0', '新增 Skill', '工具目录 0', '连接器状态 0'])
    expect(wrapper.find('[data-action="create-skills"]').exists()).toBe(false)
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('install')
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    expect(wrapper.find('.capability-toolbar').exists()).toBe(false)
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File(['demo'], 'sample.zip')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises()
    await wrapper.get('#capability-tab-skills').trigger('click')
    await flushPromises()
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').text()).toContain('sample.zip')
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('hides installation from readers even for a direct URL and responds to permission revocation', async () => {
    const { wrapper, auth } = await render(false, '/capabilities?tab=install')
    expect(wrapper.find('#capability-tab-install').exists()).toBe(false)
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
    expect(wrapper.get('#capability-tab-skills').attributes('aria-selected')).toBe('true')
    auth.$patch({ permissions: ['admin:write'] })
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    auth.$patch({ permissions: ['admin:read'] })
    await flushPromises()
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
  })

  it('supports keyboard tab navigation', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('#capability-tab-skills').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('install')
    await wrapper.get('#capability-tab-install').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('connectors')
  })

  it('opens a progress dialog immediately and polls the real strict test run', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    let resolveStart!: (value: import('../types/domain').SkillTestRunProgress) => void
    vi.spyOn(content, 'startSkillTestRun').mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    const getProgress = vi.spyOn(content, 'getSkillTestRun').mockResolvedValue({
      runId: 'run-strict-1', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: '这是一段不应直接展示的 DSH 详细回复。', testedAt: '2026-09-13T15:01:00.000Z',
      steps: [
        { id: `activation:${skill.id}`, title: '激活根 Skill', description: '已验证锁定内容', status: 'completed' },
        { id: 'result', title: '核验发布条件', description: '这是一段不应在进度步骤中展示的 DSH 完整业务回复。', status: 'completed' },
      ],
    })
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.skill-test-dialog').text()).toContain('正在创建 DSH 严格试运行')
    expect(wrapper.find('[data-testid="skill-action-feedback"]').exists()).toBe(false)

    vi.useFakeTimers()
    resolveStart({
      runId: 'run-strict-1', skillId: skill.id, version: skill.version, status: 'running',
      steps: [{ id: 'activation', title: '激活根 Skill', description: '等待 DSH 调用 activate_skill', status: 'running' }],
    })
    await flushPromises()
    expect(wrapper.get('.skill-test-dialog').text()).toContain('Run run-strict-1')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('激活根 Skill')

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(getProgress).toHaveBeenCalledWith(skill.id, 'run-strict-1')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('试运行通过')
    expect(wrapper.get('.skill-test-dialog__result').text()).toContain('可以发布')
    expect(wrapper.get('.skill-test-dialog__result').text()).toContain('1 个 Skill 已验证，DSH 已返回有效结果')
    expect(wrapper.get('.skill-test-dialog').text()).not.toContain('不应直接展示的 DSH 详细回复')
    expect(wrapper.get('.skill-test-dialog').text()).not.toContain('不应在进度步骤中展示的 DSH 完整业务回复')
    expect(wrapper.get('.skill-test-progress').text()).toContain('全部发布条件均已通过')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('请在试运行窗口确认结果后发布')
  })

  it('publishes only after the administrator confirms the completed result', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    vi.spyOn(content, 'startSkillTestRun').mockResolvedValue({
      runId: 'run-strict-2', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: '根 Skill 与依赖均已激活。', testedAt: '2026-09-13T15:01:00.000Z',
      steps: [{ id: 'result', title: '生成并核验试运行结果', description: '全部门禁通过', status: 'completed' }],
    })
    const publish = vi.spyOn(content, 'setSkillStatus').mockResolvedValue({ ...skill, status: 'published', activeVersion: skill.version })
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(publish).not.toHaveBeenCalled()
    const publishButton = wrapper.findAll('button').find(button => button.text() === '确认结果并发布')
    expect(publishButton).toBeDefined()
    await publishButton!.trigger('click')
    await flushPromises()
    expect(publish).toHaveBeenCalledWith(skill.id, 'published')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('Skill 已发布')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('Skill 已发布')
  })
})
