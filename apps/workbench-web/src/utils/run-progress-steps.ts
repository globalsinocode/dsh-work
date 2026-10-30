import type { RunStatus, RunStep } from '@/types/domain'

/**
 * EX-PROGRESS-01：把一次 Run 的执行步骤投影为员工可读的进度行——工具调用与其间的“思考”。
 *
 * DSH 只在一次模型调用结束后发出事件，平台收不到“正在思考”的信号；没有工具在运行时
 * 即视为模型在思考：首个工具前是“理解问题”，之后是“思考下一步”，结束后最后一段是“整理回答”
 * （执行中无法预知哪次模型调用是最后一次，所以只在结束后这样称呼）。等待权限确认或审批的时间
 * 单列为“等待审批”，审批后从恢复时刻（新 Attempt 的 `run.started` 或 `approval.resolved`）继续计。
 * 其他平台内部事件（排队、Worker 启动等）不成行，仍在执行过程抽屉中可见。
 *
 * 时间均为服务端事件时间（毫秒）：已结束的行用两端之差，不受本机时钟影响；进行中的行由
 * 调用方用 `elapsedMs` 结合时钟差换算。
 */

export type ProgressRowState = 'active' | 'done' | 'failed' | 'unknown'

export interface ProgressRow {
  key: string
  kind: 'thinking' | 'tool' | 'queued' | 'waiting'
  label: string
  state: ProgressRowState
  startMs?: number
  endMs?: number
}

export interface RunProgress {
  rows: ProgressRow[]
  /** 本次执行开始（`run.started`）的服务端时间。 */
  startMs?: number
  /** 本次执行结束（完成、失败或取消）的服务端时间。 */
  endMs?: number
  toolCount: number
}

/** 两段之间不足 1 秒的空隙不单列为“思考”，避免连续工具调用之间出现零碎的行。 */
const MIN_THINKING_MS = 1000

const toolVerbs: Record<string, string> = {
  read: '读取文件',
  read_image: '查看图片',
  glob: '查找文件',
  grep: '搜索文件内容',
  write: '写入文件',
  edit: '修改文件',
  str_replace_editor: '修改文件',
  web_fetch: '读取网页',
  web_search: '搜索网页',
  bash: '执行命令',
  python_execute: '运行 Python',
  activate_skill: '启用 Skill',
  todo_write: '更新待办清单',
  project_tasks_list: '查看项目任务',
  project_task_get: '查看项目任务',
}

/** 工具的易懂名称；未知工具显示原名。进行中加“正在”。 */
export function toolActionLabel(tool: string, active = false): string {
  const verb = toolVerbs[tool] ?? `调用 ${tool}`
  return active ? `正在${verb}` : verb
}

const terminalEvents = new Set(['run.completed', 'run.failed', 'run.cancelled'])
const pauseEvents = new Set(['approval.required', 'run.waiting'])

export function projectRunProgress(task: { status: RunStatus; steps: RunStep[] }): RunProgress {
  const steps = task.steps
  const firstStarted = steps.find(step => step.event === 'run.started')
  const startMs = time(firstStarted?.at)
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(task.status)
  const endMs = terminal ? time([...steps].reverse().find(step => step.event && terminalEvents.has(step.event))?.at) : undefined

  if (task.status === 'queued') {
    const queuedAt = time(steps.find(step => step.at)?.at)
    return { rows: [{ key: 'queued', kind: 'queued', label: '正在排队等待执行', state: 'active', startMs: queuedAt }], toolCount: 0 }
  }

  const rows: ProgressRow[] = []
  let cursor = startMs
  let pausedAt: number | undefined
  let toolCount = 0
  // 第一段思考是“理解问题”，之后的都是“思考下一步”。
  const thinkingLabel = () => rows.some(row => row.kind === 'thinking' || row.kind === 'tool') ? '思考下一步' : '理解问题'
  const pushThinking = (from: number | undefined, to: number | undefined, label = thinkingLabel()) => {
    if (from === undefined || to === undefined || to - from < MIN_THINKING_MS) return
    rows.push({ key: `thinking-${rows.length}`, kind: 'thinking', label, state: 'done', startMs: from, endMs: to })
  }

  for (const step of steps) {
    const at = time(step.at)
    if (step.event && pauseEvents.has(step.event)) {
      if (pausedAt === undefined && at !== undefined) {
        pushThinking(cursor, at)
        pausedAt = at
      }
      continue
    }
    if (at !== undefined && (step.event === 'approval.resolved' || (step.event === 'run.started' && step !== firstStarted))) {
      if (pausedAt !== undefined && at - pausedAt >= MIN_THINKING_MS) {
        rows.push({ key: `waiting-${rows.length}`, kind: 'waiting', label: '等待审批', state: 'done', startMs: pausedAt, endMs: at })
      }
      pausedAt = undefined
      cursor = at
      continue
    }
    if (!step.tool || (step.event !== 'tool.started' && step.event !== 'tool.completed')) continue
    const active = step.status === 'running'
    const end = active ? undefined : time(step.at)
    const start = time(step.startedAt) ?? end
    pushThinking(cursor, start)
    rows.push({
      key: step.callId ?? step.id,
      kind: 'tool',
      label: toolActionLabel(step.tool, active),
      state: active ? 'active' : step.status === 'failed' ? 'failed' : step.status === 'pending' ? 'unknown' : 'done',
      startMs: start,
      endMs: end,
    })
    toolCount += 1
    const reached = end ?? start
    if (reached !== undefined) cursor = cursor === undefined ? reached : Math.max(cursor, reached)
  }

  if (terminal) {
    pushThinking(pausedAt === undefined ? cursor : undefined, endMs, toolCount === 0 ? '思考并回答' : '整理回答')
  } else if (task.status === 'running' && pausedAt !== undefined) {
    rows.push({ key: `waiting-${rows.length}`, kind: 'waiting', label: '正在确认工具权限', state: 'active', startMs: pausedAt })
  } else if (task.status === 'running' && !rows.some(row => row.state === 'active')) {
    rows.push({ key: `thinking-${rows.length}`, kind: 'thinking', label: `正在${thinkingLabel()}`, state: 'active', startMs: cursor })
  }

  return { rows, startMs, endMs, toolCount }
}

/** 进行中的计时：把服务端开始时间按时钟差换算到本机后与当前时间相减，最小为 0。 */
export function elapsedMs(startMs: number | undefined, now: number, clockOffsetMs = 0): number | undefined {
  if (startMs === undefined) return undefined
  return Math.max(0, now - clockOffsetMs - startMs)
}

/** 形如“8 秒”“1 分 12 秒”“1 小时 3 分”。 */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function time(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : undefined
}
