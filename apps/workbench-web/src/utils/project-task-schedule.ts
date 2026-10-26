import type { ProjectTaskSchedule, ProjectTaskScheduleInput } from '@/types/domain'

/**
 * 项目空间 S4：Agent 任务执行规则的展示与编辑（docs/design/project-space-plan.md 第 11 节）。
 * “工作日”是 weekly + 周一至周五，界面单列一项。
 */

export type ScheduleMode = 'manual' | 'daily' | 'weekdays' | 'weekly'

export interface ScheduleDraft {
  mode: ScheduleMode
  timeOfDay: string
  /** 0=周日 … 6=周六（仅“每周”使用）。 */
  weekdays: number[]
}

export const scheduleModeLabels: Record<ScheduleMode, string> = {
  manual: '手动',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
}

export const weekdayOptions = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
]

const WORKDAYS = [1, 2, 3, 4, 5]
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting', 'cancel_requested']

export function defaultScheduleDraft(): ScheduleDraft {
  return { mode: 'daily', timeOfDay: '09:00', weekdays: [1] }
}

function isWorkdays(weekdays: number[] | undefined): boolean {
  return Boolean(weekdays && weekdays.length === WORKDAYS.length && WORKDAYS.every(day => weekdays.includes(day)))
}

export function draftFromSchedule(schedule: ProjectTaskSchedule | null): ScheduleDraft {
  if (!schedule) return defaultScheduleDraft()
  const timeOfDay = schedule.timeOfDay ?? '09:00'
  if (schedule.kind === 'manual') return { mode: 'manual', timeOfDay, weekdays: [1] }
  if (schedule.kind === 'daily') return { mode: 'daily', timeOfDay, weekdays: [1] }
  if (isWorkdays(schedule.weekdays)) return { mode: 'weekdays', timeOfDay, weekdays: [...WORKDAYS] }
  return { mode: 'weekly', timeOfDay, weekdays: [...(schedule.weekdays ?? [1])] }
}

export function scheduleInputFromDraft(draft: ScheduleDraft): ProjectTaskScheduleInput {
  if (draft.mode === 'manual') return { kind: 'manual' }
  if (draft.mode === 'daily') return { kind: 'daily', timeOfDay: draft.timeOfDay }
  if (draft.mode === 'weekdays') return { kind: 'weekly', timeOfDay: draft.timeOfDay, weekdays: [...WORKDAYS] }
  return { kind: 'weekly', timeOfDay: draft.timeOfDay, weekdays: [...draft.weekdays] }
}

const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']

/** 如“每天 09:00”“工作日 18:00”“每周一、三 09:00”“手动”。 */
export function scheduleLabel(schedule: ProjectTaskSchedule | null): string {
  if (!schedule) return '—'
  if (schedule.kind === 'manual') return '手动'
  const time = schedule.timeOfDay ?? ''
  if (schedule.kind === 'daily') return `每天 ${time}`
  if (isWorkdays(schedule.weekdays)) return `工作日 ${time}`
  const days = [...(schedule.weekdays ?? [])]
    .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
    .map(day => weekdayNames[day])
    .join('、')
  return `每周${days} ${time}`
}

/** 暂停或停止的原因。 */
export function scheduleReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'completed': return '任务已完成'
    case 'due_passed': return '已过截止日期'
    case 'consecutive_failures': return '连续失败 3 次'
    case 'setter_ineligible': return '设置规则的成员已无权发起执行，重新保存规则即可接管'
    case 'agent_unavailable': return 'Agent 已停用或移出空间'
    case 'workspace_archived': return '空间已归档'
    default: return ''
  }
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return Boolean(status && ACTIVE_RUN_STATUSES.includes(status))
}

/** 最近执行的结果：成功 / 失败 / 已停止 / 执行中。 */
export function runOutcomeLabel(status: string | null | undefined): string {
  if (!status) return ''
  if (status === 'succeeded') return '成功'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已停止'
  if (isActiveRunStatus(status)) return '执行中'
  return status
}

export function runOutcomeTone(status: string | null | undefined): 'success' | 'danger' | 'active' | 'muted' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (isActiveRunStatus(status)) return 'active'
  return 'muted'
}

/** 今天 09:00 / 明天 09:00 / 昨天 09:00 / 10月19日 09:00（本地时区）。 */
export function formatRunMoment(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000)
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `明天 ${time}`
  if (days === -1) return `昨天 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
