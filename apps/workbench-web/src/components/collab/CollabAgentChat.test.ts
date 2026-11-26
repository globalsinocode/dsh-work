import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { AgentConversation, AgentConversationSegment, TaskResult, TaskRun } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import CollabAgentChat from './CollabAgentChat.vue'

const api = vi.hoisted(() => ({
  getAgentConversation: vi.fn(),
  listConversationTargets: vi.fn(),
  getRun: vi.fn(),
  getSession: vi.fn(),
  getSkills: vi.fn(),
  resolveConversation: vi.fn(),
  getKnowledgeStatus: vi.fn(),
  getSessionKnowledgeBases: vi.fn(),
}))
vi.mock('@/api/client', () => ({ workbenchApi: api }))
vi.mock('@/utils/feedback', () => ({ notifyActionFailure: vi.fn(), downloadArtifactFile: vi.fn() }))

enableAutoUnmount(afterEach)

function result(): TaskResult {
  return {
    version: 'task-result/v1', runId: 'r', attemptId: 'a', execution: 'succeeded', outcome: 'achieved',
    summary: '', primaryOutput: null, receipts: [], pendingItems: [], sources: [], artifacts: [], error: null,
    evidence: {
      stopReason: null, toolCalls: null, toolResults: null, artifactsClaimed: null, artifactsRegistered: 0,
      inputTokens: null, outputTokens: null, elapsedMs: null, outputTruncated: false, interrupted: null,
    },
    completedAt: null,
  }
}

function run(id: string, sessionId: string, text: string): TaskRun {
  return {
    id, title: text, prompt: text, status: 'succeeded', attemptId: 'a', workspaceId: 'ws-me', workspaceName: '个人',
    workspaceType: 'personal', sessionId, agentVersion: 'inventory@2.0.0', createdAt: '', updatedAt: '', owner: '林岚',
    requestedBy: 'U1', steps: [], attachments: [], result: result(),
    messages: [
      { id: `${id}-q`, role: 'user', content: text, createdAt: '10:00', runId: id },
      { id: `${id}-a`, role: 'assistant', content: `回答：${text}`, createdAt: '10:01', runId: id, agentName: '库存助手' },
    ],
  } as TaskRun
}

function segment(sessionId: string, runId: string | null, title: string, at: string): AgentConversationSegment {
  return { sessionId, title, createdAt: at, lastActiveAt: at, agentVersion: '2.0.0', runCount: runId ? 1 : 0, latestRun: runId ? { id: runId, status: 'succeeded' } : null }
}

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    agent: { id: 'agent-x', name: '库存助手', description: '库存分析', version: '2.0.0', available: true },
    items: [segment('s-new', 'r-new', '本周库存', '2026-10-22T09:00:00.000Z'), segment('s-old', 'r-old', '上周库存', '2026-10-15T09:00:00.000Z')],
    nextCursor: null,
    continueSessionId: 's-new',
    ...overrides,
  }
}

async function mountChat(props: { agentId?: string; focusSessionId?: string; skillId?: string } = {}) {
  const wrapper = mount(CollabAgentChat, { props: { agentId: 'agent-x', ...props }, global: { plugins: [ElementPlus] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

async function submit(wrapper: Awaited<ReturnType<typeof mountChat>>, prompt: string) {
  const confirm = vi.fn()
  wrapper.findComponent(TaskComposer).vm.$emit('submit', { prompt, files: [], workspaceId: '', mentions: [], confirm })
  await flushPromises()
  return confirm
}

describe('CollabAgentChat (S5c 单聊)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(api).forEach(fn => fn.mockReset())
    api.listConversationTargets.mockResolvedValue({ items: [], nextCursor: null })
    api.getRun.mockImplementation(async (id: string) => run(id, id === 'r-new' ? 's-new' : 's-old', id === 'r-new' ? '本周' : '上周'))
    const auth = useAuthStore()
    vi.spyOn(auth, 'user', 'get').mockReturnValue({ id: 'U1', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] })
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
  })

  it('shows the sessions oldest first with “话题 · 时间” dividers', async () => {
    api.getAgentConversation.mockResolvedValue(conversation())
    const wrapper = await mountChat()
    const sections = wrapper.findAll('.collab-segment')
    expect(sections.map(item => item.attributes('data-session-id'))).toEqual(['s-old', 's-new'])
    expect(sections[0]!.find('.collab-segment__divider').text()).toContain('上周库存 ·')
    expect(sections[1]!.text()).toContain('回答：本周')
    expect(wrapper.get('h1').text()).toBe('库存助手')
  })

  it('continues the latest session through the existing run entry', async () => {
    api.getAgentConversation.mockResolvedValue(conversation())
    const wrapper = await mountChat()
    const store = useTaskStore()
    const start = vi.spyOn(store, 'startRunWithSessionFiles').mockResolvedValue(run('r-next', 's-new', '继续'))
    const create = vi.spyOn(store, 'createTask')
    vi.spyOn(store, 'subscribe').mockImplementation(() => undefined)
    const confirm = await submit(wrapper, '再看看华东')
    expect(start).toHaveBeenCalledWith('s-new', { prompt: '再看看华东', attachments: [], referencedFileIds: [] })
    expect(create).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalled()
    expect(api.getAgentConversation).toHaveBeenCalledTimes(2)
  })

  it('opens a new session when nothing can be continued', async () => {
    api.getAgentConversation.mockResolvedValue(conversation({ continueSessionId: null }))
    const wrapper = await mountChat()
    expect(wrapper.get('[data-testid="new-session-notice"]').text()).toContain('发送后将开始新的对话')
    const store = useTaskStore()
    const create = vi.spyOn(store, 'createTask').mockResolvedValue(run('r-first', 's-first', '你好'))
    const start = vi.spyOn(store, 'startRunWithSessionFiles')
    await submit(wrapper, '你好')
    expect(create).toHaveBeenCalledWith('你好', [], undefined, undefined, 'agent-x', [])
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps history readable but blocks sending when the AI colleague is unavailable', async () => {
    api.getAgentConversation.mockResolvedValue(conversation({
      agent: { id: 'agent-x', name: '库存助手', description: '', version: '1.0.0', available: false },
      continueSessionId: null,
    }))
    const wrapper = await mountChat()
    expect(wrapper.findComponent(TaskComposer).exists()).toBe(false)
    expect(wrapper.get('[data-testid="agent-unavailable-notice"]').text()).toContain('当前不可用')
    expect(wrapper.text()).toContain('回答：上周')
  })

  it('welcomes a first conversation and loads earlier sessions on demand', async () => {
    api.getAgentConversation.mockResolvedValueOnce(conversation({ items: [], continueSessionId: null }))
    const empty = await mountChat()
    expect(empty.text()).toContain('开始与 库存助手 对话')
    empty.unmount()

    api.getAgentConversation
      .mockResolvedValueOnce(conversation({ items: [segment('s-new', 'r-new', '本周库存', '2026-10-22T09:00:00.000Z')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(conversation({ items: [segment('s-old', 'r-old', '上周库存', '2026-10-15T09:00:00.000Z')], nextCursor: null }))
    const wrapper = await mountChat()
    expect(wrapper.findAll('.collab-segment')).toHaveLength(1)
    await wrapper.get('.thread-earlier').trigger('click')
    await flushPromises()
    expect(api.getAgentConversation).toHaveBeenLastCalledWith('agent-x', 'c1')
    expect(wrapper.findAll('.collab-segment').map(item => item.attributes('data-session-id'))).toEqual(['s-old', 's-new'])
    expect(wrapper.find('.thread-earlier').exists()).toBe(false)
  })

  it('pages back to a linked session and scrolls to it', async () => {
    api.getAgentConversation
      .mockResolvedValueOnce(conversation({ items: [segment('s-new', 'r-new', '本周库存', '2026-10-22T09:00:00.000Z')], nextCursor: 'c1' }))
      .mockResolvedValueOnce(conversation({ items: [segment('s-old', 'r-old', '上周库存', '2026-10-15T09:00:00.000Z')], nextCursor: null }))
    await mountChat({ focusSessionId: 's-old' })
    expect(api.getAgentConversation).toHaveBeenCalledTimes(2)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})

describe('CollabAgentChat: 选用 Skill 开始新会话（MODE-E2E-18）', () => {
  const skill = { id: 'skill-report', name: '区域汇总', version: '1.0.0', category: '文件', description: '', owner: '', testPrompt: '', updatedAt: '' }
  beforeEach(() => {
    setActivePinia(createPinia())
    Object.values(api).forEach(fn => fn.mockReset())
    api.listConversationTargets.mockResolvedValue({ items: [], nextCursor: null })
    api.getRun.mockImplementation(async (id: string) => run(id, id === 'r-new' ? 's-new' : 's-old', id === 'r-new' ? '本周' : '上周'))
    api.getAgentConversation.mockResolvedValue(conversation())
    api.getSkills.mockResolvedValue([skill])
    const auth = useAuthStore()
    vi.spyOn(auth, 'user', 'get').mockReturnValue({ id: 'U1', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] })
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
  })

  it('shows the Skill chip and starts a new session with it, letting the server pick the AI colleague', async () => {
    const wrapper = await mountChat({ skillId: 'skill-report' })
    expect(wrapper.get('[aria-label="已选择 Skill"]').text()).toContain('@区域汇总')
    expect(wrapper.get('[data-testid="skill-session-notice"]').text()).toContain('发送后将开始新的对话')
    expect(wrapper.find('[data-testid="new-session-notice"]').exists()).toBe(false)
    const store = useTaskStore()
    const create = vi.spyOn(store, 'createTask').mockResolvedValue(run('r-skill', 's-skill', '汇总'))
    const start = vi.spyOn(store, 'startRunWithSessionFiles')
    api.resolveConversation.mockResolvedValue({ type: 'agent', agentId: 'agent-x', sessionId: 's-skill' })
    const confirm = await submit(wrapper, '按区域汇总')
    // 与工作模式“新对话”相同：不指定 AI 同事（第 5 个参数），由服务端选出能提供该 Skill 工具的一位。
    expect(create).toHaveBeenCalledWith('按区域汇总', [], undefined, undefined, undefined, [], 'skill-report', undefined, [], [])
    expect(start).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalled()
    expect(api.resolveConversation).toHaveBeenCalledWith('r-skill')
    expect(wrapper.emitted('skill-cleared')).toHaveLength(1)
    expect(wrapper.emitted('open-agent')).toBeUndefined()
  })

  it('moves to the AI colleague the server picked when it is not this chat', async () => {
    const wrapper = await mountChat({ skillId: 'skill-report' })
    const store = useTaskStore()
    vi.spyOn(store, 'createTask').mockResolvedValue(run('r-skill', 's-skill', '汇总'))
    api.resolveConversation.mockResolvedValue({ type: 'agent', agentId: 'agent-search', sessionId: 's-skill' })
    await submit(wrapper, '按区域汇总')
    expect(wrapper.emitted('open-agent')).toEqual([['agent-search', 's-skill']])
    expect(wrapper.emitted('skill-cleared')).toBeUndefined()
  })

  it('keeps the knowledge-base choice for the new session instead of the one it would have continued', async () => {
    api.getKnowledgeStatus.mockResolvedValue({ enabled: true, level: 'bases' })
    api.getSessionKnowledgeBases.mockResolvedValue([{ id: 'kb-old', name: '旧选择', available: true }])
    const wrapper = await mountChat({ skillId: 'skill-report' })
    expect(api.getSessionKnowledgeBases).not.toHaveBeenCalled()
    await wrapper.setProps({ skillId: undefined })
    await flushPromises()
    expect(api.getSessionKnowledgeBases).toHaveBeenCalledWith('s-new')
  })

  it('continues the latest session again once the Skill is removed', async () => {
    const wrapper = await mountChat({ skillId: 'skill-report' })
    await wrapper.setProps({ skillId: undefined })
    await flushPromises()
    expect(wrapper.find('[aria-label="已选择 Skill"]').exists()).toBe(false)
    const store = useTaskStore()
    const start = vi.spyOn(store, 'startRunWithSessionFiles').mockResolvedValue(run('r-next', 's-new', '继续'))
    const create = vi.spyOn(store, 'createTask')
    vi.spyOn(store, 'subscribe').mockImplementation(() => undefined)
    await submit(wrapper, '继续')
    expect(start).toHaveBeenCalledWith('s-new', { prompt: '继续', attachments: [], referencedFileIds: [] })
    expect(create).not.toHaveBeenCalled()
  })

  it('prefills the Skill’s suggested question only when it has one', async () => {
    api.getSkills.mockResolvedValue([{ ...skill, testPrompt: '按区域汇总本月金额' }])
    const wrapper = await mountChat({ skillId: 'skill-report' })
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('按区域汇总本月金额')
    expect(wrapper.find('[data-testid="recommendation-prefill-notice"]').exists()).toBe(false)
  })

  it('asks the page to drop the Skill when its chip is removed', async () => {
    const wrapper = await mountChat({ skillId: 'skill-report' })
    await wrapper.get('[aria-label="移除已选择 Skill"]').trigger('click')
    expect(wrapper.emitted('skill-cleared')).toHaveLength(1)
  })

  it('ignores a Skill the employee cannot see and continues as usual', async () => {
    const wrapper = await mountChat({ skillId: 'skill-hidden' })
    expect(wrapper.find('[aria-label="已选择 Skill"]').exists()).toBe(false)
    const store = useTaskStore()
    const start = vi.spyOn(store, 'startRunWithSessionFiles').mockResolvedValue(run('r-next', 's-new', '继续'))
    vi.spyOn(store, 'subscribe').mockImplementation(() => undefined)
    await submit(wrapper, '继续')
    expect(start).toHaveBeenCalled()
    expect(useContentStore().skills.map(item => item.id)).toEqual(['skill-report'])
  })
})
