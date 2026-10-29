import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { AgentRoutineResult, Automation } from '@/types/domain'
import AutomationsView from './AutomationsView.vue'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: '纽约晨报',
    agentVersionId: 'ver-1',
    agentId: 'agent-1',
    agentName: '市场助手',
    agentVersion: '2',
    workspaceId: 'ws-personal',
    schedule: { kind: 'daily', timezone: 'America/New_York', timeOfDay: '09:00' },
    scheduleRevision: 1,
    // 纽约 10 月 30 日 09:00（夏令时，UTC-4）。
    nextSlotUtc: '2026-10-30T13:00:00.000Z',
    inputTemplate: { prompt: '汇总晨报' },
    scopeCeiling: {},
    confirmedConfigRevision: 'rev',
    revision: 1,
    status: 'enabled',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastExecution: null,
    ...overrides,
  }
}

async function mountView(items: Automation[], results: AgentRoutineResult[] = []) {
  vi.spyOn(workbenchApi, 'getAutomations').mockResolvedValue(items)
  vi.spyOn(workbenchApi, 'getAgentRoutineResults').mockResolvedValue(results)
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
  const wrapper = mount(AutomationsView, { global: { plugins: [pinia, ElementPlus] } })
  await flushPromises()
  return wrapper
}

describe('AutomationsView 卡片“下次运行 / 最近一次”与主动任务结果页签', () => {
  beforeEach(() => {
    // 只固定“现在”，保留真实定时器给防抖与 Element Plus 使用。纽约此刻为 10 月 29 日 10:00。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T14:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the next run in the task timezone and the latest outcome on the card', async () => {
    const wrapper = await mountView([automation({
      lastExecution: {
        id: 'exe-1',
        kind: 'scheduled',
        plannedSlotUtc: '2026-10-29T13:00:00.000Z',
        missedFromUtc: null,
        missedToUtc: null,
        admissionStatus: 'accepted',
        reasonCode: null,
        runStatus: 'succeeded',
        resultOutcome: 'achieved',
        createdAt: '2026-10-29T13:00:00.000Z',
      },
    })])

    const card = wrapper.get('section[aria-label="定时任务：纽约晨报"]')
    expect(card.text()).toContain('每天 09:00 · 纽约')
    expect(card.text()).toContain('明天 09:00')
    expect(card.text()).toContain('目标已达成')
    expect(card.text()).toContain('今天 09:00 · 定时触发')
    expect(card.findAll('button').map(button => button.text())).toEqual(
      expect.arrayContaining(['立即运行', '暂停', '执行记录']),
    )
  })

  it('explains a skipped latest execution with its reason and hides next run while paused', async () => {
    const wrapper = await mountView([automation({
      status: 'paused',
      lastExecution: {
        id: 'exe-2',
        kind: 'scheduled',
        plannedSlotUtc: '2026-10-29T13:00:00.000Z',
        missedFromUtc: null,
        missedToUtc: null,
        admissionStatus: 'skipped',
        reasonCode: 'overlap',
        runStatus: null,
        resultOutcome: null,
        createdAt: '2026-10-29T13:00:00.000Z',
      },
    })])

    const card = wrapper.get('section[aria-label="定时任务：纽约晨报"]')
    expect(card.text()).toContain('已跳过')
    expect(card.text()).toContain('上一次执行未结束，本次跳过')
    expect(card.text()).toContain('已暂停，启用后恢复')
    expect(card.text()).not.toContain('明天 09:00')
    expect(card.findAll('button').map(button => button.text())).toEqual(
      expect.arrayContaining(['启用', '试运行']),
    )
  })

  it('filters cards by status', async () => {
    const wrapper = await mountView([
      automation(),
      automation({ id: 'auto-2', name: '草稿任务', status: 'draft' }),
    ])

    await wrapper.findAll('.automation-filter').find(button => button.text().startsWith('草稿'))!.trigger('click')
    const names = wrapper.findAll('section.automation-card').map(card => card.attributes('aria-label'))
    expect(names).toEqual(['定时任务：草稿任务'])
  })

  it('lists AI 同事 results in their own tab with collapsible answers', async () => {
    const wrapper = await mountView([], [{
      executionId: 'routine-exe-1',
      routineName: '每日舆情摘要',
      agentName: '市场洞察助手',
      workspaceId: 'ws-team',
      runId: 'run-1',
      runStatus: 'succeeded',
      resultOutcome: 'unverified',
      answer: '第一行\n第二行\n第三行',
      createdAt: '2026-10-29T12:00:00.000Z',
    }])

    const tab = wrapper.findAll('.el-tabs__item').find(item => item.text().includes('AI 同事主动任务结果'))
    expect(tab?.text()).toContain('1')
    await tab!.trigger('click')

    const answer = wrapper.get('.agent-results__answer')
    expect(answer.classes()).toContain('is-collapsed')
    expect(wrapper.text()).toContain('结果待核验')
    const toggle = wrapper.findAll('button').find(button => button.text() === '展开全文')
    await toggle!.trigger('click')
    expect(wrapper.get('.agent-results__answer').classes()).not.toContain('is-collapsed')
    expect(wrapper.findAll('button').some(button => button.text() === '收起')).toBe(true)
  })
})
