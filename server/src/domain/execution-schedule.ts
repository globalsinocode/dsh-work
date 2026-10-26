import { CronExpressionParser } from 'cron-parser'

import { invalidRequest, stateConflict } from './request-errors.ts'

/**
 * 结构化调度规则。自动任务、主动任务与项目任务共用同一日历语义：
 * 只暴露 daily / weekly / manual，不开放完整 cron。
 *
 * 放在领域层，是为了项目任务不必反向依赖 automation 模块
 * （automation 已依赖 run，run 已依赖 workbench，反向依赖会成环）。
 *
 * DST 语义（契约测试固化，库行为不等于本契约承诺）：
 * - 缺失槽（春季拨快，本地时间不存在）：cron-parser 会把触发点前移到
 *   合法时刻；本封装按「墙钟必须等于配置的 timeOfDay」判定其为缺失槽
 *   并跳过，绝不把前移结果当有效槽位；
 * - 重复槽（秋季拨回，本地时间出现两次）：取第一次出现。
 */
export interface ExecutionSchedule {
  kind: 'manual' | 'daily' | 'weekly'
  /** IANA 时区标识，如 Asia/Shanghai、America/New_York。 */
  timezone: string
  /** 'HH:mm'（24h）；daily/weekly 必填，manual 忽略。 */
  timeOfDay?: string
  /** weekly 的星期集合，0=Sunday … 6=Saturday。 */
  weekdays?: number[]
}

const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
/** 枚举上限：每天至多一个槽，连续跳过缺失槽最多每自然年一次。 */
const MAX_ENUMERATED_SLOTS = 400

/**
 * 调度规则的时区校验。不复用 execution-time.isValidTimezone：
 * 那边还有 64 字符上限，套用会改变已有规则的接受范围。
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** 校验并规范化调度规则；非法输入抛错（路由层转 400）。 */
export function normalizeSchedule(input: ExecutionSchedule): ExecutionSchedule {
  if (!input || typeof input !== 'object') throw stateConflict('调度规则不能为空')
  if (!['manual', 'daily', 'weekly'].includes(input.kind)) {
    throw invalidRequest('调度类型必须是 manual、daily 或 weekly')
  }
  if (typeof input.timezone !== 'string' || !isValidTimezone(input.timezone)) {
    throw invalidRequest('时区必须是有效的 IANA 标识')
  }
  if (input.kind === 'manual') return { kind: 'manual', timezone: input.timezone }

  const timeOfDay = input.timeOfDay ?? ''
  if (!WALL_CLOCK.test(timeOfDay)) throw invalidRequest('执行时间必须是 HH:mm（24 小时制）')
  if (input.kind === 'daily') {
    return { kind: 'daily', timezone: input.timezone, timeOfDay }
  }
  const weekdays = [...new Set(input.weekdays ?? [])]
  if (
    weekdays.length === 0
    || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw invalidRequest('每周执行必须选择 0（周日）到 6（周六）之间的星期')
  }
  weekdays.sort((a, b) => a - b)
  return { kind: 'weekly', timezone: input.timezone, timeOfDay, weekdays }
}

function cronExpression(schedule: ExecutionSchedule): string | null {
  if (schedule.kind === 'manual' || !schedule.timeOfDay) return null
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number)
  if (schedule.kind === 'daily') return `${minute} ${hour} * * *`
  return `${minute} ${hour} * * ${schedule.weekdays!.join(',')}`
}

const wallClockFormat = new Map<string, Intl.DateTimeFormat>()

function wallClockOf(instant: Date, timezone: string): string {
  let format = wallClockFormat.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    wallClockFormat.set(timezone, format)
  }
  const parts = format.formatToParts(instant)
  const hour = parts.find(part => part.type === 'hour')?.value ?? ''
  const minute = parts.find(part => part.type === 'minute')?.value ?? ''
  return `${hour}:${minute}`
}

/**
 * 枚举 (afterUtc, untilUtc] 内的有效槽位（UTC 绝对时刻，升序）。
 * DST 缺失槽被跳过且不计入返回；manual 或无有效配置返回空数组。
 */
export function slotsBetween(
  schedule: ExecutionSchedule,
  afterUtc: Date,
  untilUtc: Date,
  cap = MAX_ENUMERATED_SLOTS,
): Date[] {
  const expression = cronExpression(schedule)
  if (!expression) return []
  const iterator = CronExpressionParser.parse(expression, {
    tz: schedule.timezone,
    currentDate: afterUtc,
  })
  const slots: Date[] = []
  while (slots.length < cap) {
    const candidate = iterator.next().toDate()
    if (candidate.getTime() > untilUtc.getTime()) break
    // 缺失槽判定：库可能把触发点前移到合法时刻，墙钟不符即跳过。
    if (wallClockOf(candidate, schedule.timezone) !== schedule.timeOfDay) continue
    slots.push(candidate)
  }
  return slots
}

/** 严格晚于 afterUtc 的下一个有效槽位；manual 返回 null。 */
export function nextSlotUtc(schedule: ExecutionSchedule, afterUtc: Date): Date | null {
  const [slot] = slotsBetween(schedule, afterUtc, new Date('2100-01-01T00:00:00Z'), 1)
  return slot ?? null
}
