import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminAssistantView from './AdminAssistantView.vue'
import { adminApi } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useAdminAssistantStore } from '../stores/admin-assistant'
import { conversationFixture } from '../testing/assistant-fixtures'
const wrappers: VueWrapper[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })
async function render(canManage = true, saved = false) {
  const pinia = createPinia(); setActivePinia(pinia)
  const auth = useAuthStore(); auth.$patch({ permissions: canManage ? ['admin:write'] : ['admin:read'] })
  const store = useAdminAssistantStore()
  vi.spyOn(adminApi, 'getAssistantConversation').mockResolvedValue(conversationFixture())
  vi.spyOn(adminApi, 'getAssistantConversations').mockResolvedValue([])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/assistant', component: AdminAssistantView }, { path: '/capabilities', component: { template: '<div>Skill 中心</div>' } }] })
  await router.push(`/assistant${saved ? `?conversation=${conversationFixture().id}` : ''}`); await router.isReady()
  const wrapper = mount(AdminAssistantView, { global: { plugins: [pinia, router, ElementPlus] } }); wrappers.push(wrapper); await flushPromises()
  return { wrapper, store, auth, router }
}
function button(wrapper: VueWrapper, label: string) { return wrapper.findAll('button').find(item => item.text() === label)! }
describe('real Skill installation conversation', () => {
  it('loads server previews on refresh and confirms their exact digest', async () => {
    const result = conversationFixture(); result.installations[0]!.status = 'installed'; result.installations[0]!.skillId = 'skill-1'
    result.messages.push({ id: 'installation-result', role: 'assistant', text: 'Skill“真实测试包”已安装完成，并保存为 0.1.0 待验证草稿。\n下一步：前往 Skill 中心执行严格试运行，确认结果后发布。', runId: 'run-1' })
    const confirm = vi.spyOn(adminApi, 'confirmSkillInstallation').mockResolvedValue(result)
    const { wrapper } = await render(true, true)
    expect(wrapper.text()).toContain('真实测试包')
    expect(wrapper.text()).toContain('纯指令 Skill，无工具依赖')
    expect(wrapper.text()).not.toContain('演示完成')
    await button(wrapper, '确认安装计划').trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledWith('run-1', 'd'.repeat(64))
    expect(wrapper.text()).toContain('Skill 已安装')
    expect(wrapper.text()).toContain('已安装完成，并保存为 0.1.0 待验证草稿')
    expect(wrapper.text()).toContain('前往 Skill 中心验证并发布')
    expect(wrapper.text()).toContain('查看已确认的安装计划')
  })
  it('preserves input and the idempotency key after an uncertain request failure', async () => {
    const send = vi.spyOn(adminApi, 'sendAssistantMessage').mockRejectedValueOnce(new Error('连接中断')).mockImplementationOnce(async input => ({ ...conversationFixture(), id: input.sessionId }))
    const { wrapper } = await render()
    await wrapper.get('textarea').setValue('curl -L https://example.org/skill.zip')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.text()).toContain('连接中断')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toContain('curl')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(send.mock.calls[0]![0].requestId).toBe(send.mock.calls[1]![0].requestId)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })
  it('does not allow confirmation while the run is active, or after write access is revoked', async () => {
    const { wrapper, store, auth } = await render(true, true)
    store.current.runs[0]!.status = 'running'; await flushPromises()
    expect(button(wrapper, '确认安装计划').attributes('disabled')).toBeDefined()
    auth.$patch({ permissions: ['admin:read'] }); await flushPromises()
    expect(button(wrapper, '确认安装计划')).toBeUndefined()
    expect(wrapper.find('textarea').exists()).toBe(false)
    const confirm = vi.spyOn(adminApi, 'confirmSkillInstallation')
    await store.confirm('run-1', 'a'.repeat(64)); expect(confirm).not.toHaveBeenCalled()
  })
  it('cancels through the server and displays the persisted result', async () => {
    const result = conversationFixture(); result.installations[0]!.status = 'cancelled'
    const cancel = vi.spyOn(adminApi, 'cancelAssistantRun').mockResolvedValue(result)
    const { wrapper } = await render(true, true)
    await button(wrapper, '取消安装').trigger('click'); await flushPromises()
    expect(cancel).toHaveBeenCalledWith('run-1')
    expect(wrapper.text()).toContain('安装已取消')
    expect(button(wrapper, '确认安装')).toBeUndefined()
  })
  it('replaces the running status link with a stop action in the send button', async () => {
    const cancelled = conversationFixture(); cancelled.runs[0]!.status = 'cancelled'; cancelled.installations[0]!.status = 'cancelled'
    const cancel = vi.spyOn(adminApi, 'cancelAssistantRun').mockResolvedValue(cancelled)
    const send = vi.spyOn(adminApi, 'sendAssistantMessage')
    const { wrapper, store } = await render(true, true)
    store.current.runs[0]!.status = 'running'; await flushPromises()

    expect(button(wrapper, '停止处理')).toBeUndefined()
    const stop = button(wrapper, '停止')
    expect(stop.attributes('type')).toBe('button')
    expect(stop.attributes('aria-label')).toBe('停止处理')
    expect(stop.attributes('disabled')).toBeUndefined()
    await stop.trigger('click'); await flushPromises()

    expect(cancel).toHaveBeenCalledWith('run-1')
    expect(send).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('安装已取消')
    expect(button(wrapper, '发送')).toBeDefined()
  })
  it('prefills commands without sending or locally fabricating an installation', async () => {
    const send = vi.spyOn(adminApi, 'sendAssistantMessage')
    const { wrapper, store } = await render()
    await button(wrapper, 'npx').trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toContain('npx skills add')
    expect(send).not.toHaveBeenCalled(); expect(store.current.installations).toHaveLength(0)
  })
})
