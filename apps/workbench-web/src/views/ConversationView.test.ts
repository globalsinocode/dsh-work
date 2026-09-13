import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { TaskRun, Workspace } from '@/types/domain'
import ConversationView from './ConversationView.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
const route = vi.hoisted(() => ({ params: { id: 'run-001' } }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))

function task(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-001',
    title: '库存分析',
    prompt: '分析库存',
    status: 'failed',
    attemptId: 'attempt-001',
    workspaceId: 'ws-team',
    workspaceName: '供应链团队',
    sessionId: 'session-001',
    agentVersion: 'assistant@1.0.0',
    createdAt: '2026-09-10 10:00',
    updatedAt: '2026-09-10 10:05',
    owner: '林岚',
    messages: [],
    steps: [],
    sources: [],
    artifacts: [],
    attachments: [],
    error: {
      code: 'run_failed',
      message: '本轮执行失败',
      object: '运行 run-001',
      reason: '上游超时',
      suggestion: '可重新执行本轮。',
      retryable: true,
    },
    ...overrides,
  }
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-team',
    name: '供应链团队',
    description: '团队共享的协作空间。',
    type: 'team',
    memberCount: 2,
    sessionCount: 1,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚', '周航'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

async function mountView(options: { item?: TaskRun; workspace?: Workspace } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const taskStore = useTaskStore(pinia)
  taskStore.tasks.splice(0, taskStore.tasks.length, options.item ?? task())
  vi.spyOn(taskStore, 'load').mockResolvedValue(undefined)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, options.workspace ?? workspace())
  const wrapper = mount(ConversationView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: { TaskComposer: true, RunTimeline: true },
    },
  })
  await flushPromises()
  return { wrapper, taskStore, contentStore }
}

describe('ConversationView 归档只读态（design §2.7 / AC-23）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.params = { id: 'run-001' }
  })

  it('hides the follow-up composer and retry entries for a run in an archived team space', async () => {
    const { wrapper } = await mountView({
      workspace: workspace({ status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' }),
    })

    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(true)
    expect(wrapper.find('task-composer-stub').exists()).toBe(false)
    // 头部与错误区的重试入口都不渲染。
    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(false)
    expect(wrapper.findAll('button').filter(button => button.text() === '重新执行本轮')).toHaveLength(0)
    // 内容本身仍可读：对话正文与来源区保持渲染。
    expect(wrapper.find('.conversation-thread').exists()).toBe(true)
  })

  it('keeps the composer and retry entry on an active team space', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="重新执行本轮"]').exists()).toBe(true)
  })

  it('never applies the archived gate to a personal workspace (AC-23)', async () => {
    const { wrapper } = await mountView({
      item: task({ workspaceId: 'ws-personal', workspaceName: '我的空间' }),
      // 个人空间契约上恒为 active；即便夹具带上归档状态也不得隐藏入口。
      workspace: workspace({ id: 'ws-personal', type: 'personal', status: 'archived' }),
    })

    expect(wrapper.find('task-composer-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conversation-archived-notice"]').exists()).toBe(false)
  })

  it('renders assistant Markdown as structured content and keeps user input plain', async () => {
    const { wrapper } = await mountView({
      item: task({
        messages: [
          { id: 'message-user', role: 'user', content: '**不要加粗**', createdAt: '2026-09-10 10:00' },
          {
            id: 'message-assistant',
            role: 'assistant',
            content: ['## 无法安装的原因', '', '**运行时未授权工具**', '', '```text', 'Error: tool is not authorized', '```'].join('\n'),
            createdAt: '2026-09-10 10:01',
          },
        ],
      }),
    })

    expect(wrapper.get('.user-message p').text()).toBe('**不要加粗**')
    expect(wrapper.find('.user-message strong').exists()).toBe(false)
    expect(wrapper.get('.assistant-answer h4').text()).toBe('无法安装的原因')
    expect(wrapper.get('.assistant-answer strong').text()).toBe('运行时未授权工具')
    expect(wrapper.get('.assistant-answer pre code').text()).toBe('Error: tool is not authorized')
    expect(wrapper.get('.assistant-answer').text()).not.toContain('```')
  })
})
