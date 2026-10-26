import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useTaskStore } from '@/stores/tasks'
import type { AgentConversation, AgentConversationSegment, TaskResult, TaskRun } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import CollabAgentChat from './CollabAgentChat.vue'

const api = vi.hoisted(() => ({
  getAgentConversation: vi.fn(),
  listConversationTargets: vi.fn(),
  getRun: vi.fn(),
  getSession: vi.fn(),
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

async function mountChat(props: { agentId?: string; focusSessionId?: string } = {}) {
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
