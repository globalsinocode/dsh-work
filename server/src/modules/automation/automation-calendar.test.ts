import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isValidTimezone,
  nextSlotUtc,
  normalizeSchedule,
  slotsBetween,
} from './automation-calendar.ts'

const SHANGHAI = 'Asia/Shanghai' // UTC+8，无 DST
const NEW_YORK = 'America/New_York' // 有 DST

test('normalizeSchedule 校验类型/时区/墙钟/星期', () => {
  assert.throws(() => normalizeSchedule({ kind: 'daily', timezone: 'Mars/Olympus', timeOfDay: '09:00' }), /IANA/)
  assert.throws(() => normalizeSchedule({ kind: 'daily', timezone: SHANGHAI, timeOfDay: '25:00' }), /HH:mm/)
  assert.throws(() => normalizeSchedule({ kind: 'daily', timezone: SHANGHAI }), /HH:mm/)
  assert.throws(() => normalizeSchedule({ kind: 'weekly', timezone: SHANGHAI, timeOfDay: '09:00', weekdays: [] }), /星期/)
  assert.throws(() => normalizeSchedule({ kind: 'weekly', timezone: SHANGHAI, timeOfDay: '09:00', weekdays: [7] }), /星期/)
  assert.throws(() => normalizeSchedule({ kind: 'hourly' as never, timezone: SHANGHAI }), /manual、daily 或 weekly/)

  const manual = normalizeSchedule({ kind: 'manual', timezone: SHANGHAI })
  assert.deepEqual(manual, { kind: 'manual', timezone: SHANGHAI })

  // 星期去重并排序
  const weekly = normalizeSchedule({ kind: 'weekly', timezone: SHANGHAI, timeOfDay: '08:30', weekdays: [3, 1, 1] })
  assert.deepEqual(weekly.weekdays, [1, 3])
})

test('daily 槽位按配置时区解析为正确 UTC 时刻', () => {
  const schedule = { kind: 'daily' as const, timezone: SHANGHAI, timeOfDay: '09:00' }
  // 上海 09:00 = UTC 01:00
  const slot = nextSlotUtc(schedule, new Date('2026-03-01T00:00:00Z'))
  assert.equal(slot?.toISOString(), '2026-03-01T01:00:00.000Z')
})

test('weekly 槽位只落在所选星期', () => {
  // 2026-03-01 是周日；选周三(3)与周日(0)
  const schedule = { kind: 'weekly' as const, timezone: SHANGHAI, timeOfDay: '09:00', weekdays: [3, 0] }
  const slots = slotsBetween(
    schedule,
    new Date('2026-03-01T00:00:00Z'),
    new Date('2026-03-09T00:00:00Z'),
  )
  assert.deepEqual(
    slots.map(slot => slot.toISOString()),
    ['2026-03-01T01:00:00.000Z', '2026-03-04T01:00:00.000Z', '2026-03-08T01:00:00.000Z'],
  )
})

test('manual 不产生任何槽位', () => {
  const schedule = { kind: 'manual' as const, timezone: SHANGHAI }
  assert.equal(nextSlotUtc(schedule, new Date()), null)
  assert.equal(slotsBetween(schedule, new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z')).length, 0)
})

test('DST 春季拨快：不存在的 02:30 被跳过而非前移', () => {
  // 纽约 2026-03-08 02:00→03:00 拨快，02:30 不存在
  const schedule = { kind: 'daily' as const, timezone: NEW_YORK, timeOfDay: '02:30' }
  const slots = slotsBetween(
    schedule,
    new Date('2026-03-06T00:00:00Z'),
    new Date('2026-03-11T00:00:00Z'),
  )
  // 应有 3/6、3/7、3/9、3/10 四天各一槽；3/8 缺失槽跳过
  assert.equal(slots.length, 4)
  const wallClocks = slots.map(slot =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: NEW_YORK, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(slot))
  assert.ok(wallClocks.every(clock => clock.endsWith('02:30')))
  assert.ok(!wallClocks.some(clock => clock.includes('03-08')))
})

test('DST 秋季拨回：重复的 01:30 只取第一次', () => {
  // 纽约 2026-11-01 02:00→01:00 拨回，01:30 出现两次（EDT 与 EST）
  const schedule = { kind: 'daily' as const, timezone: NEW_YORK, timeOfDay: '01:30' }
  const slots = slotsBetween(
    schedule,
    new Date('2026-10-31T00:00:00Z'),
    new Date('2026-11-03T00:00:00Z'),
  )
  assert.equal(slots.length, 3)
  // 11/01 的槽必须是第一次出现（EDT，UTC-4 → 05:30Z），而非第二次（EST，UTC-5 → 06:30Z）
  assert.equal(slots[1]!.toISOString(), '2026-11-01T05:30:00.000Z')
})

test('枚举不含起点、含终点，且总数受 cap 截断', () => {
  const schedule = { kind: 'daily' as const, timezone: 'UTC', timeOfDay: '00:00' }
  const start = new Date('2026-01-01T00:00:00Z')
  const slots = slotsBetween(schedule, start, new Date('2026-01-04T00:00:00Z'))
  // (1/1 00:00, 1/4 00:00] → 1/2、1/3、1/4
  assert.deepEqual(slots.map(s => s.toISOString()), [
    '2026-01-02T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
    '2026-01-04T00:00:00.000Z',
  ])
  assert.equal(slotsBetween(schedule, start, new Date('2027-06-01T00:00:00Z')).length <= 400, true)
})

test('isValidTimezone 区分合法 IANA 与非法输入', () => {
  assert.equal(isValidTimezone(SHANGHAI), true)
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('GMT+8'), false)
  assert.equal(isValidTimezone(''), false)
})
