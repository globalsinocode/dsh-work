import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import ModelUsageView from './ModelUsageView.vue'
import { adminApi } from '../api/client'
import type { ModelUsageBreakdownRow, ModelUsageExecution, ModelUsageOverview, ModelUsageTotals } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

const totals: ModelUsageTotals = {
  totalTokens: 120000, inputTokens: 110000, outputTokens: 10000, cacheReadTokens: 40000, cacheInputTokens: 80000,
  requests: 50, failedRequests: 5, requestsKnown: true, executions: 20, failedExecutions: 2, estimatedTokens: 0,
}

function overview(overrides: Partial<ModelUsageOverview['totals']> = {}): ModelUsageOverview {
  return {
    range: '7d', from: '2026-11-02', to: '2026-11-08', granularity: 'day',
    totals: { ...totals, employees: 3, ...overrides },
    trend: [
      { bucket: '2026-11-07', label: '11/7', models: [{ model: 'deepseek-v4-pro', tokens: 60000, estimatedTokens: 0 }] },
      { bucket: '2026-11-08', label: '11/8', models: [{ model: 'qwen3.8-flash', tokens: 60000, estimatedTokens: 20000 }] },
    ],
    facets: { models: ['deepseek-v4-pro', 'qwen3.8-flash'], sources: ['automation', 'conversation'] },
  }
}

const row = (key: string, label: string, extra: Partial<ModelUsageBreakdownRow> = {}): ModelUsageBreakdownRow => ({ ...totals, key, label, sub: '', ...extra })

const execution: ModelUsageExecution = {
  attemptId: 'attempt-1', runId: 'run-1', time: '11-08 10:42', source: 'automation', agentId: 'inventory', agentName: '库存日报',
  employeeId: 'U00001', employeeName: '林岚', department: '华东销售部', providerKey: 'deepseek-official', providerName: 'DeepSeek 官方',
  model: 'deepseek-v4-pro', routeName: '平台默认模型路由', status: 'success', errorCode: null, totalTokens: 1350,
  inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: null, requests: 2, failedRequests: 0,
  measurement: 'gateway', search: { model: 'deepseek-v4-flash', inputTokens: 200, outputTokens: 50, requests: 1 },
  durationMs: 41000, traceId: 'trace-1',
}

async function render(data: ModelUsageOverview = overview()) {
  setActivePinia(createPinia())
  const overviewSpy = vi.spyOn(adminApi, 'getModelUsageOverview').mockResolvedValue(data)
  const breakdownSpy = vi.spyOn(adminApi, 'getModelUsageBreakdown').mockImplementation(async (_filter, dimension) =>
    dimension === 'employee'
      ? [row('U00001', '林岚', { sub: '华东销售部' })]
      : dimension === 'source'
        ? [row('automation', 'automation'), row('conversation', 'conversation', { estimatedTokens: 3000 })]
        : [row('deepseek-v4-pro', 'deepseek-v4-pro', { sub: 'DeepSeek 官方' })])
  const executionsSpy = vi.spyOn(adminApi, 'getModelUsageExecutions').mockResolvedValue({ items: [execution], total: 1, page: 1, pageSize: 20 })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/audit', component: { template: '<div />' } }] })
  const wrapper = mount(ModelUsageView, { attachTo: document.body, global: { plugins: [ElementPlus, router], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, overviewSpy, breakdownSpy, executionsSpy }
}

function tab(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('[role="tab"]').find(item => item.text().startsWith(label))
  if (!button) throw new Error(`没有找到标签：${label}`)
  return button
}

describe('ModelUsageView', () => {
  it('默认近 7 天：显示概况、按模型统计，没有估算提示与导出按钮', async () => {
    const { wrapper, overviewSpy, breakdownSpy } = await render()
    expect(overviewSpy).toHaveBeenCalledWith({ range: '7d' })
    expect(breakdownSpy).toHaveBeenCalledWith({ range: '7d' }, 'model')
    const text = wrapper.text()
    expect(text).toContain('12.0 万')
    expect(text).toContain('50.0%')
    expect(text).toContain('失败率 10.0%')
    expect(text).not.toContain('估算数据')
    expect(text).not.toContain('导出')
    expect(wrapper.findAll('.usage-trend__bar')).toHaveLength(2)
    expect(wrapper.find('.usage-trend__segment--estimated').exists()).toBe(true)
  })

  it('有估算数据时显示占比提示；来源按中文名称展示并标出含估算', async () => {
    const { wrapper } = await render(overview({ estimatedTokens: 30000 }))
    expect(wrapper.text()).toContain('当前范围含 25.0% 估算数据')
    await tab(wrapper, '按来源').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('定时任务')
    expect(wrapper.text()).toContain('员工对话')
    expect(wrapper.text()).toContain('含估算')
  })

  it('点员工下钻：切到执行明细并带上员工条件，清除后恢复', async () => {
    const { wrapper, overviewSpy, executionsSpy } = await render()
    await tab(wrapper, '按员工').trigger('click')
    await flushPromises()
    await wrapper.findAll('.usage-drill-link').find(item => item.text() === '林岚')!.trigger('click')
    await flushPromises()
    expect(executionsSpy).toHaveBeenLastCalledWith({ range: '7d', employee: 'U00001' }, 1, 20)
    expect(overviewSpy).toHaveBeenLastCalledWith({ range: '7d', employee: 'U00001' })
    expect(wrapper.find('[data-testid="usage-drill"]').text()).toContain('员工：林岚')
    expect(tab(wrapper, '执行明细').attributes('aria-selected')).toBe('true')
    expect(wrapper.text()).toContain('含联网搜索')
    expect(wrapper.text()).toContain('网关计量')

    await wrapper.find('[data-testid="usage-drill"] .el-tag__close').trigger('click')
    await flushPromises()
    expect(executionsSpy).toHaveBeenLastCalledWith({ range: '7d' }, 1, 20)
  })

  it('点模型行时直接写入模型筛选；切换时间范围重新加载', async () => {
    const { wrapper, overviewSpy } = await render()
    await wrapper.findAll('.usage-drill-link').find(item => item.text() === 'deepseek-v4-pro')!.trigger('click')
    await flushPromises()
    expect(overviewSpy).toHaveBeenLastCalledWith({ range: '7d', model: 'deepseek-v4-pro' })
    await wrapper.findAll('input[type="radio"]').find(item => (item.element as HTMLInputElement).value === '30d')!.setValue(true)
    await flushPromises()
    expect(overviewSpy).toHaveBeenLastCalledWith({ range: '30d', model: 'deepseek-v4-pro' })
  })

  it('执行详情显示缓存、联网搜索与计量说明；厂商未返回的缓存写入显示“未返回”', async () => {
    const { wrapper } = await render()
    await tab(wrapper, '执行明细').trigger('click')
    await flushPromises()
    await wrapper.find('[aria-label="查看 11-08 10:42 库存日报 的用量详情"]').trigger('click')
    await flushPromises()
    const drawer = wrapper.find('.el-drawer')
    expect(drawer.text()).toContain('命中率 60.0%')
    expect(drawer.text()).toContain('未返回')
    expect(drawer.text()).toContain('联网搜索单独计量')
    expect(drawer.text()).toContain('用量来自模型网关逐次请求的计量')
  })

  it('先后下钻 Agent 与员工时两个条件同时保留，可分别清除', async () => {
    const { wrapper, executionsSpy, breakdownSpy } = await render()
    breakdownSpy.mockImplementation(async (_filter, dimension) =>
      dimension === 'agent' ? [row('inventory', '库存日报')] : [row('U00001', '林岚', { sub: '华东销售部' })])
    await tab(wrapper, '按 Agent').trigger('click')
    await flushPromises()
    await wrapper.findAll('.usage-drill-link').find(item => item.text() === '库存日报')!.trigger('click')
    await flushPromises()
    await tab(wrapper, '按员工').trigger('click')
    await flushPromises()
    await wrapper.findAll('.usage-drill-link').find(item => item.text() === '林岚')!.trigger('click')
    await flushPromises()
    expect(executionsSpy).toHaveBeenLastCalledWith({ range: '7d', agent: 'inventory', employee: 'U00001' }, 1, 20)
    const chips = wrapper.findAll('[data-testid="usage-drill"]')
    expect(chips.map(chip => chip.text())).toEqual(['Agent：库存日报', '员工：林岚'])
    await chips[0]!.find('.el-tag__close').trigger('click')
    await flushPromises()
    expect(executionsSpy).toHaveBeenLastCalledWith({ range: '7d', employee: 'U00001' }, 1, 20)
  })

  it('快速切换时间范围时，晚到的旧结果不覆盖新结果', async () => {
    const { wrapper, overviewSpy } = await render()
    let resolveSlow: (value: ModelUsageOverview) => void = () => undefined
    overviewSpy
      .mockImplementationOnce(() => new Promise(resolve => { resolveSlow = resolve }))
      .mockImplementationOnce(async () => overview({ totalTokens: 3000, inputTokens: 2000, outputTokens: 1000 }))
    const radio = (value: string) => wrapper.findAll('input[type="radio"]').find(item => (item.element as HTMLInputElement).value === value)!
    await radio('30d').setValue(true)
    await radio('today').setValue(true)
    await flushPromises()
    resolveSlow(overview({ totalTokens: 999999 }))
    await flushPromises()
    expect(wrapper.text()).toContain('3,000')
    expect(wrapper.text()).not.toContain('100.0 万')
  })

  it('统计满 200 项时提示只显示前 200 项', async () => {
    const { wrapper, breakdownSpy } = await render()
    breakdownSpy.mockResolvedValue(Array.from({ length: 200 }, (_, index) => row(`model-${index}`, `model-${index}`)))
    await tab(wrapper, '按 Agent').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('只显示用量最高的 200 项')
  })
})
