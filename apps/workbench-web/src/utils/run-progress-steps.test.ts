import { describe, expect, it } from 'vitest'

import type { RunStep } from '@/types/domain'
import { elapsedMs, formatElapsed, projectRunProgress, toolActionLabel } from './run-progress-steps'

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, seconds)).toISOString()
const ms = (seconds: number) => Date.parse(t(seconds))

function event(id: string, eventType: string, at: number): RunStep {
  return { id, title: eventType, detail: '', status: 'succeeded', event: eventType, at: t(at) }
}

function tool(id: string, name: string, startedAt: number, endedAt?: number, status: RunStep['status'] = 'succeeded'): RunStep {
  return endedAt === undefined
    ? { id, title: '正在调用工具', detail: '', status: 'running', tool: name, callId: id, event: 'tool.started', at: t(startedAt), startedAt: t(startedAt) }
    : { id, title: '调用工具', detail: '', status, tool: name, callId: id, event: 'tool.completed', at: t(endedAt), startedAt: t(startedAt) }
}

const summary = (rows: ReturnType<typeof projectRunProgress>['rows']) =>
  rows.map(row => [row.label, row.state, row.endMs !== undefined && row.startMs !== undefined ? (row.endMs - row.startMs) / 1000 : null])

describe('projectRunProgress', () => {
  it('shows the model thinking before the first tool call', () => {
    const progress = projectRunProgress({ status: 'running', steps: [event('q', 'run.queued', 0), event('s', 'run.started', 1)] })
    expect(summary(progress.rows)).toEqual([['正在理解问题', 'active', null]])
    expect(progress.rows[0]!.startMs).toBe(ms(1))
    expect(progress.startMs).toBe(ms(1))
  })

  it('lists finished tool calls with the thinking between them and the running call last', () => {
    const progress = projectRunProgress({
      status: 'running',
      steps: [event('s', 'run.started', 0), tool('c1', 'read', 11, 13), tool('c2', 'python_execute', 41)],
    })
    expect(summary(progress.rows)).toEqual([
      ['理解问题', 'done', 11],
      ['读取文件', 'done', 2],
      ['思考下一步', 'done', 28],
      ['正在运行 Python', 'active', null],
    ])
    expect(progress.toolCount).toBe(2)
  })

  it('shows thinking after the last finished tool while no tool runs', () => {
    const progress = projectRunProgress({ status: 'running', steps: [event('s', 'run.started', 0), tool('c1', 'read', 5, 6)] })
    expect(summary(progress.rows).at(-1)).toEqual(['正在思考下一步', 'active', null])
    expect(progress.rows.at(-1)!.startMs).toBe(ms(6))
  })

  it('marks failed and unanswered calls and names unknown tools', () => {
    const progress = projectRunProgress({
      status: 'succeeded',
      steps: [
        event('s', 'run.started', 0),
        tool('c1', 'read', 0, 0, 'failed'),
        tool('c2', 'erp.query', 0, 0, 'pending'),
        event('done', 'run.completed', 0),
      ],
    })
    expect(summary(progress.rows)).toEqual([['读取文件', 'failed', 0], ['调用 erp.query', 'unknown', 0]])
  })

  it('names the last thinking stretch after the run ends and measures the whole run', () => {
    const progress = projectRunProgress({
      status: 'succeeded',
      steps: [event('s', 'run.started', 0), tool('c1', 'read', 3, 4), event('done', 'run.completed', 30)],
    })
    expect(summary(progress.rows)).toEqual([['理解问题', 'done', 3], ['读取文件', 'done', 1], ['整理回答', 'done', 26]])
    expect((progress.endMs! - progress.startMs!) / 1000).toBe(30)
  })

  it('does not list sub-second gaps between back-to-back or parallel calls as thinking', () => {
    const progress = projectRunProgress({
      status: 'running',
      steps: [event('s', 'run.started', 0), tool('c1', 'grep', 0), tool('c2', 'glob', 0)],
    })
    expect(summary(progress.rows)).toEqual([['正在搜索文件内容', 'active', null], ['正在查找文件', 'active', null]])
  })

  it('ignores platform events and steps without event times', () => {
    const progress = projectRunProgress({
      status: 'running',
      steps: [
        event('s', 'run.started', 0),
        event('a', 'approval.resolved', 2),
        { id: 'legacy', title: '查询订单', detail: '', status: 'pending', tool: 'erp.get_sales_order' },
      ],
    })
    expect(summary(progress.rows)).toEqual([['正在理解问题', 'active', null]])
  })

  it('shows an approval wait as its own row and resumes timing from the new Attempt', () => {
    const progress = projectRunProgress({
      status: 'succeeded',
      steps: [
        event('s1', 'run.started', 0),
        tool('c1', 'read', 5, 6),
        event('a', 'approval.required', 10),
        event('w', 'run.waiting', 11),
        event('s2', 'run.started', 3600),
        tool('c2', 'write', 3605, 3606),
        event('done', 'run.completed', 3610),
      ],
    })
    expect(summary(progress.rows)).toEqual([
      ['理解问题', 'done', 5],
      ['读取文件', 'done', 1],
      ['思考下一步', 'done', 4],
      ['等待审批', 'done', 3590],
      ['思考下一步', 'done', 5],
      ['写入文件', 'done', 1],
      ['整理回答', 'done', 4],
    ])
    expect(progress.rows.some(row => row.kind === 'thinking' && row.endMs! - row.startMs! > 60_000)).toBe(false)
  })

  it('shows a permission check in progress instead of thinking', () => {
    const progress = projectRunProgress({ status: 'running', steps: [event('s', 'run.started', 0), event('a', 'approval.required', 4)] })
    expect(summary(progress.rows)).toEqual([['理解问题', 'done', 4], ['正在确认工具权限', 'active', null]])
  })

  it('shows a queued run as waiting', () => {
    const progress = projectRunProgress({ status: 'queued', steps: [event('q', 'run.queued', 0)] })
    expect(summary(progress.rows)).toEqual([['正在排队等待执行', 'active', null]])
  })
})

describe('elapsed time', () => {
  it('converts server time with the measured clock offset and never goes negative', () => {
    expect(elapsedMs(1_000, 41_000)).toBe(40_000)
    expect(elapsedMs(1_000, 41_000, 5_000)).toBe(35_000)
    expect(elapsedMs(50_000, 41_000)).toBe(0)
    expect(elapsedMs(undefined, 41_000)).toBeUndefined()
  })

  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(8_400)).toBe('8 秒')
    expect(formatElapsed(72_000)).toBe('1 分 12 秒')
    expect(formatElapsed(3_780_000)).toBe('1 小时 3 分')
    expect(formatElapsed(undefined)).toBe('')
  })

  it('labels tools with plain names', () => {
    expect(toolActionLabel('read')).toBe('读取文件')
    expect(toolActionLabel('python_execute', true)).toBe('正在运行 Python')
    expect(toolActionLabel('mes.progress', true)).toBe('正在调用 mes.progress')
  })
})
