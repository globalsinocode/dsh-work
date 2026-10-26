import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { Automation, AutomationExecution, AutomationExecutionPage } from '@/types/domain'
import AutomationsView from './AutomationsView.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router }))

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: '日报',
    agentVersionId: 'version-1',
    agentId: 'agent-1',
    agentName: '助手',
    agentVersion: '1.0.0',
    workspaceId: 'ws-personal',
    schedule: { kind: 'manual', timezone: 'Asia/Shanghai' },
    scheduleRevision: 1,
    nextSlotUtc: null,
    inputTemplate: { prompt: '执行' },
    scopeCeiling: {},
    confirmedConfigRevision: '',
    revision: 1,
    status: 'paused',
    archivedAt: null,
    archivedBy: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function executionPage(items: AutomationExecution[], hasMore = false): AutomationExecutionPage {
  return { items, nextCursor: hasMore ? 'cursor-1' : null, hasMore }
}

async function mountView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, {
    id: 'ws-personal',
    name: '个人空间',
    description: '',
    type: 'personal',
    memberCount: 1,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-10-21T00:00:00.000Z',
    owner: '测试',
    members: ['测试'],
    files: [],
    status: 'active',
    archivedAt: null,
  })
  const wrapper = mount(AutomationsView, { global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  return wrapper
}

describe('AutomationsView lifecycle UI', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'getAgentRoutineResults').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'getAutomations').mockResolvedValue([automation({ status: 'paused' })])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('loads archived tasks and restores to paused', async () => {
    vi.spyOn(workbenchApi, 'restoreAutomation').mockResolvedValue(automation({ status: 'paused' }))
    const wrapper = await mountView()
    await wrapper.get('[aria-label="任务状态筛选"]').setValue('archived')
    await flushPromises()
    expect(workbenchApi.getAutomations).toHaveBeenCalledWith({ status: 'archived' })
    await wrapper.findAll('button').find(button => button.text() === '恢复')!.trigger('click')
    expect(workbenchApi.restoreAutomation).toHaveBeenCalledWith('automation-1')
  })

  it('polls while a visible execution is nonterminal and stops at terminal', async () => {
    vi.useFakeTimers()
    const running: AutomationExecution = {
      id: 'exec-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      kind: 'manual',
      plannedSlotUtc: '2026-10-21T00:00:00.000Z',
      missedFromUtc: null,
      missedToUtc: null,
      taskRevision: 1,
      scheduleRevision: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      runStatus: 'running',
      resultOutcome: null,
      admissionStatus: 'accepted',
      reasonCode: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    }
    const completed = { ...running, runStatus: 'succeeded' }
    vi.spyOn(workbenchApi, 'listAutomationExecutions')
      .mockResolvedValueOnce(executionPage([running]))
      .mockResolvedValueOnce(executionPage([completed]))
    const wrapper = await mountView()
    await wrapper.findAll('button').find(button => button.text().includes('执行记录'))!.trigger('click')
    await flushPromises()
    expect(workbenchApi.listAutomationExecutions).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(workbenchApi.listAutomationExecutions).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(workbenchApi.listAutomationExecutions).toHaveBeenCalledTimes(2)
  })
})
