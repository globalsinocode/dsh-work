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
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/assistant', component: AdminAssistantView }, { path: '/skills', component: { template: '<div>Skill 管理</div>' } }] })
  await router.push(`/assistant${saved ? `?conversation=${conversationFixture().id}` : ''}`); await router.isReady()
  const wrapper = mount(AdminAssistantView, { global: { plugins: [pinia, router, ElementPlus] } }); wrappers.push(wrapper); await flushPromises()
  return { wrapper, store, auth, router }
}
function button(wrapper: VueWrapper, label: string) { return wrapper.findAll('button').find(item => item.text() === label)! }
describe('real Skill installation conversation', () => {
  it('loads server previews on refresh and confirms their exact digest', async () => {
    const result = conversationFixture(); result.installations[0]!.status = 'installed'; result.installations[0]!.skillId = 'skill-1'; result.installations[0]!.resultType = 'created'; result.installations[0]!.installedVersion = '0.1.0'
    result.messages.push({ id: 'installation-result', role: 'assistant', text: 'Skill“真实测试包”已安装完成，并保存为 v0.1.0 待验证草稿。\n下一步：前往 Skill 中心执行严格试运行，确认结果后发布。', runId: 'run-1' })
    const confirm = vi.spyOn(adminApi, 'confirmSkillInstallation').mockResolvedValue(result)
    const { wrapper } = await render(true, true)
    expect(wrapper.text()).toContain('真实测试包')
    expect(wrapper.text()).toContain('纯指令 Skill，无工具依赖')
    expect(wrapper.text()).not.toContain('演示完成')
    await button(wrapper, '确认安装计划').trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledWith('run-1', 'd'.repeat(64))
    expect(wrapper.text()).toContain('Skill 已安装')
    expect(wrapper.text()).toContain('已安装完成，并保存为 v0.1.0 待验证草稿')
    expect(wrapper.text()).toContain('前往 Skill 管理验证并发布')
    expect(wrapper.text()).toContain('查看已确认的安装计划')
  })
  it('routes messages through the backend and preserves idempotency on a connection retry', async () => {
    const send = vi.spyOn(adminApi, 'sendAssistantMessage').mockRejectedValueOnce(new Error('连接中断')).mockImplementationOnce(async input => ({ ...conversationFixture(), id: input.sessionId }))
    const { wrapper } = await render()
    await wrapper.get('textarea').setValue('curl -L https://example.org/skill.zip')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('连接中断')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toContain('curl')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(send.mock.calls[0]![0].requestId).toBe(send.mock.calls[1]![0].requestId)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })
  it('sends with Enter and keeps Shift + Enter available for a new line', async () => {
    const send = vi.spyOn(adminApi, 'sendAssistantMessage').mockImplementation(async input => ({ ...conversationFixture(), id: input.sessionId }))
    const { wrapper } = await render()
    const textarea = wrapper.get('textarea')

    await textarea.setValue('查询当前平台状态')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
    expect(send).not.toHaveBeenCalled()

    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].message).toBe('查询当前平台状态')
    expect(wrapper.text()).toContain('Enter 发送，Shift + Enter 换行')
  })
  it('shows a server-created Skill delegation proposal before starting its specialist', async () => {
    const proposal = { id: 'proposal-1', runId: 'run-1', kind: 'skill-install' as const, title: '安装已有 Skill', assistantName: 'Skill 安装助手', purpose: 'admin-skill-install' as const, request: 'curl -L https://example.org/skill.zip', impact: '检查来源并生成安装计划；不会直接写入。', proposalSha256: 'a'.repeat(64), status: 'pending' as const, delegatedRunId: null }
    const proposed = conversationFixture(); proposed.installations = []; proposed.proposals = [proposal]
    const confirmed = structuredClone(proposed); confirmed.proposals[0]!.status = 'confirmed'; confirmed.proposals[0]!.delegatedRunId = 'run-specialist'; confirmed.runs.push({ id: 'run-specialist', status: 'queued', error: null })
    let sessionId = ''
    vi.spyOn(adminApi, 'sendAssistantMessage').mockImplementation(async input => { sessionId = input.sessionId; return { ...proposed, id: input.sessionId } })
    const confirm = vi.spyOn(adminApi, 'confirmAssistantProposal').mockImplementation(async () => ({ ...confirmed, id: sessionId }))
    const { wrapper } = await render()

    await wrapper.get('textarea').setValue(proposal.request)
    await wrapper.get('form').trigger('submit'); await flushPromises()

    expect(wrapper.text()).toContain('识别到管理任务')
    expect(wrapper.text()).toContain('admin-skill-install')
    expect(wrapper.text()).toContain('确认前不会启动任务')
    await button(wrapper, '确认并调用').trigger('click'); await flushPromises()
    expect(confirm).toHaveBeenCalledWith('proposal-1', 'a'.repeat(64))
    expect(wrapper.text()).toContain('已确认')
  })
  it('uses the DSH-backed ordinary response without creating a task proposal', async () => {
    const result = conversationFixture(); result.installations = []; result.proposals = []; result.messages = [{ id: 'm1', role: 'user', text: '当前有哪些未发布的 Skill？', runId: 'run-1' }, { id: 'm2', role: 'assistant', text: '当前有 2 个未发布 Skill。', runId: 'run-1' }]
    const send = vi.spyOn(adminApi, 'sendAssistantMessage').mockImplementation(async input => ({ ...result, id: input.sessionId }))
    const { wrapper } = await render()

    await wrapper.get('textarea').setValue('当前有哪些未发布的 Skill？')
    await wrapper.get('form').trigger('submit'); await flushPromises()

    expect(send).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('当前有 2 个未发布 Skill')
    expect(wrapper.find('.delegation-card').exists()).toBe(false)
  })
  it('scrolls to the latest content when polling receives an assistant reply', async () => {
    const { wrapper, store } = await render(true, true)
    const messageList = wrapper.get('.conversation-body').element as HTMLElement
    const scrollTo = vi.fn()
    Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(messageList, 'scrollTo', { configurable: true, value: scrollTo })
    const refreshed = conversationFixture()
    refreshed.messages.push({ id: 'm3', role: 'assistant', text: '这是轮询后收到的完整回复。', runId: 'run-1' })
    vi.mocked(adminApi.getAssistantConversation).mockResolvedValue(refreshed)

    await store.refresh()
    await flushPromises()

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'smooth' })
  })
  it('renders and confirms the exact second-stage Agent action plan', async () => {
    const proposed = conversationFixture(); proposed.installations = []; proposed.proposals = [{ id: 'proposal-agent', runId: 'run-1', kind: 'agent-management', title: '调整 Agent 可见角色', assistantName: 'Agent 管理助手', purpose: 'admin-agent-manage', request: '调整采购分析 Agent 的可见角色', impact: '读取当前配置并生成差异计划。', proposalSha256: 'b'.repeat(64), status: 'pending', delegatedRunId: null }]
    const planned = structuredClone(proposed); planned.proposals[0]!.status = 'confirmed'; planned.proposals[0]!.delegatedRunId = 'run-agent'; planned.runs.push({ id: 'run-agent', status: 'succeeded', error: null }); planned.actions = [{ id: 'action-1', runId: 'run-agent', actionType: 'agent-update-draft', summary: '调整采购分析 Agent 可见角色', before: { roleIds: ['role-old'] }, after: { roleIds: ['role-new'] }, planSha256: 'c'.repeat(64), status: 'pending', resultSummary: null }]
    const executed = structuredClone(planned); executed.actions[0]!.status = 'executed'; executed.actions[0]!.resultSummary = 'Agent 草稿已更新'
    let sessionId = ''
    vi.spyOn(adminApi, 'sendAssistantMessage').mockImplementation(async input => { sessionId = input.sessionId; return { ...proposed, id: input.sessionId } })
    vi.spyOn(adminApi, 'confirmAssistantProposal').mockImplementation(async () => ({ ...planned, id: sessionId }))
    const confirmAction = vi.spyOn(adminApi, 'confirmAssistantAction').mockImplementation(async () => ({ ...executed, id: sessionId }))
    const { wrapper } = await render()

    await wrapper.get('textarea').setValue('调整采购分析 Agent 的可见角色')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.text()).toContain('Agent 管理助手')
    expect(wrapper.text()).toContain('admin-agent-manage')
    await button(wrapper, '确认并调用').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('role-old')
    expect(wrapper.text()).toContain('role-new')
    await button(wrapper, '确认执行计划').trigger('click'); await flushPromises()
    expect(confirmAction).toHaveBeenCalledWith('action-1', 'c'.repeat(64))
    expect(wrapper.text()).toContain('Agent 草稿已更新')
  })
  it('allows read-only administrators to chat and view proposals but not confirm them', async () => {
    const result = conversationFixture(); result.installations = []; result.proposals = [{ id: 'proposal-read', runId: 'run-1', kind: 'agent-management', title: '调整 Agent', assistantName: 'Agent 管理助手', purpose: 'admin-agent-manage', request: '调整采购分析 Agent 的可见角色', impact: '生成待确认计划。', proposalSha256: 'd'.repeat(64), status: 'pending', delegatedRunId: null }]
    const send = vi.spyOn(adminApi, 'sendAssistantMessage').mockImplementation(async input => ({ ...result, id: input.sessionId }))
    const { wrapper } = await render(false)

    expect(wrapper.find('textarea').exists()).toBe(true)
    await wrapper.get('textarea').setValue('调整采购分析 Agent 的可见角色')
    await wrapper.get('form').trigger('submit'); await flushPromises()

    expect(wrapper.text()).toContain('需要管理写权限')
    expect(button(wrapper, '确认并调用')).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('reports a duplicate package as an assistant reply without claiming a new draft', async () => {
    const result = conversationFixture()
    Object.assign(result.installations[0]!, { status: 'installed', skillId: 'skill-existing', resultType: 'duplicate', installedVersion: '1.2.0' })
    result.messages.push({ id: 'duplicate-result', role: 'assistant', text: 'Skill“真实测试包”已经安装，现有 v1.2.0 与本次包内容一致，本次未创建重复 Skill。\n无需重复安装。', runId: 'run-1' })
    vi.spyOn(adminApi, 'confirmSkillInstallation').mockResolvedValue(result)
    const { wrapper } = await render(true, true)

    await button(wrapper, '确认安装计划').trigger('click'); await flushPromises()

    expect(wrapper.text()).toContain('Skill 已存在，无需重复安装')
    expect(wrapper.text()).toContain('本次未创建重复 Skill')
    expect(wrapper.text()).toContain('现有版本 v1.2.0')
    expect(wrapper.text()).not.toContain('v1.2.0 为待验证草稿')
  })
  it('refreshes the conversation after a confirmation failure and shows the persisted reply', async () => {
    const failed = conversationFixture()
    failed.messages.push({ id: 'failure-result', role: 'assistant', text: 'Skill 安装失败：已有内容不同的待验证草稿。\n本次未创建或覆盖 Skill。请根据提示处理后重试。', runId: 'run-1' })
    vi.spyOn(adminApi, 'confirmSkillInstallation').mockRejectedValue(new Error('已有内容不同的待验证草稿'))
    const { wrapper } = await render(true, true)
    vi.mocked(adminApi.getAssistantConversation).mockResolvedValue(failed)

    await button(wrapper, '确认安装计划').trigger('click'); await flushPromises()

    expect(wrapper.text()).toContain('Skill 安装失败')
    expect(wrapper.text()).toContain('本次未创建或覆盖 Skill')
    expect(wrapper.find('.assistant-page > .el-alert').exists()).toBe(false)
  })
  it('does not allow confirmation while the run is active, or after write access is revoked', async () => {
    const { wrapper, store, auth } = await render(true, true)
    store.current.runs[0]!.status = 'running'; await flushPromises()
    expect(button(wrapper, '确认安装计划').attributes('disabled')).toBeDefined()
    auth.$patch({ permissions: ['admin:read'] }); await flushPromises()
    expect(button(wrapper, '确认安装计划')).toBeUndefined()
    expect(wrapper.find('textarea').exists()).toBe(true)
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
    await button(wrapper, 'Skill 来源').trigger('click')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toContain('github.com')
    expect(send).not.toHaveBeenCalled(); expect(store.current.installations).toHaveLength(0)
  })
})
