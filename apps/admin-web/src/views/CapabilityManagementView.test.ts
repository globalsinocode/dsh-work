import ElementPlus, { ElMessageBox } from 'element-plus'
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
  const wrapper = mount(CapabilityManagementView, { global: { plugins: [pinia, router, ElementPlus] } })
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

  it('shows persistent progress and success feedback for a strict Skill test', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    let resolveTest!: (value: { id: string; skillId: string; version: string; status: 'passed'; resultSummary: string; testedAt: string }) => void
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(undefined as never)
    vi.spyOn(content, 'testSkill').mockReturnValue(new Promise(resolve => { resolveTest = resolve }))
    vi.spyOn(content, 'setSkillStatus').mockResolvedValue({ ...skill, status: 'published', activeVersion: skill.version })
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('正在严格试运行')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('DSH 试运行')

    resolveTest({ id: 'test-1', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: 'DSH 试运行完成：已激活 Skill。', testedAt: '2026-09-13 15:01' })
    await flushPromises()

    expect(content.setSkillStatus).toHaveBeenCalledWith(skill.id, 'published')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('Skill 已发布')
  })

  it('keeps a visible result when the administrator postpones publication', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce(undefined as never).mockRejectedValueOnce('cancel')
    vi.spyOn(content, 'testSkill').mockResolvedValue({ id: 'test-1', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: 'DSH 试运行完成。', testedAt: '2026-09-13 15:01' })
    const publish = vi.spyOn(content, 'setSkillStatus')
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(publish).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('试运行已通过，尚未发布')
  })
})
