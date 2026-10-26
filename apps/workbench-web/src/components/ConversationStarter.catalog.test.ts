import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import ConversationStarter from './ConversationStarter.vue'

const route = vi.hoisted(() => ({
  query: { agent: 'agent-assistant', agentVersion: 'agent-version-assistant-120' } as Record<string, string>,
}))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))

describe('ConversationStarter 员工目录预选', () => {
  it('展示 AI 同事预选，并把 Agent id 交给既有会话创建链路', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore(pinia)
    contentStore.initialized = true
    contentStore.agents = [{
      id: 'agent-assistant',
      versionId: 'agent-version-assistant-120',
      versionReference: 'agent-assistant@1.2.0',
      name: '经营分析同事',
      description: '帮助员工分析经营数据。',
      welcomeMessage: '告诉我分析主题和时间范围。',
      version: '1.2.0',
      publishedAt: '2026-09-23T00:00:00.000Z',
      examplePrompts: ['分析本月订单交付情况'],
    }]
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-agent' } as never)

    const wrapper = mount(ConversationStarter, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    const composer = wrapper.findComponent(TaskComposer)
    expect(composer.props('selectedAgentName')).toBe('经营分析同事')
    expect(composer.get('[aria-label="已选择 AI 同事"]').text()).toContain('经营分析同事')
    expect(composer.props('initialPrompt')).toBe('分析本月订单交付情况')
    composer.vm.$emit('submit', {
      prompt: '分析本月订单交付情况', files: [], workspaceId: '', mentions: [],
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '分析本月订单交付情况', [], undefined, '', 'agent-assistant', [], undefined, undefined,
      'agent-version-assistant-120', undefined,
    )
  })

  it('submits the exact Agent version selected in the plaza', async () => {
    route.query = { agent: 'agent-1', agentVersion: 'agent-version-v1' }
    const pinia = createPinia()
    setActivePinia(pinia)
    const contentStore = useContentStore(pinia)
    contentStore.initialized = true
    contentStore.agents = [{
      id: 'agent-1',
      versionId: 'agent-version-v1',
      versionReference: 'agent-1@1.0.0',
      name: '库存同事',
      description: '',
      welcomeMessage: '',
      version: '1.0.0',
      publishedAt: '2026-09-23T00:00:00.000Z',
      examplePrompts: [],
    }]
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-agent' } as never)
    const wrapper = mount(ConversationStarter, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()
    const composer = wrapper.findComponent(TaskComposer)
    composer.vm.$emit('submit', { prompt: '分析库存', files: [], workspaceId: '', mentions: [] })
    await flushPromises()
    expect(createTask).toHaveBeenCalledWith(
      '分析库存', [], undefined, '', 'agent-1', [], undefined, undefined, 'agent-version-v1', undefined,
    )
  })
})
