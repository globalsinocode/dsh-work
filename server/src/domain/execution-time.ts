// Execution time shown to the model. The Manifest freezes `created_at` (UTC) and an IANA
// `timezone`; the adapter renders the local wall clock from them so "today" means the
// same day for the model as for the people it works for.

/** Platform default when nothing more specific (such as a routine's schedule) applies. */
export const DEFAULT_PLATFORM_TIMEZONE = 'Asia/Shanghai'

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Reads DSH_WORK_TIMEZONE; an invalid value fails startup rather than silently using UTC. */
export function resolvePlatformTimezone(value: string | undefined): string {
  const timezone = value?.trim()
  if (!timezone) return DEFAULT_PLATFORM_TIMEZONE
  if (!isValidTimezone(timezone)) throw new Error(`DSH_WORK_TIMEZONE 不是有效的 IANA 时区：${timezone}`)
  return timezone
}

/** e.g. `2026-10-17 星期六 07:32（Asia/Taipei，UTC+08:00）` */
export function formatExecutionTime(iso: string, timezone: string): string {
  const instant = new Date(iso)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(instant).map(part => [part.type, part.value]))
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'long' }).format(instant)
  const offset = parts.timeZoneName === 'GMT' ? 'UTC+00:00' : String(parts.timeZoneName).replace('GMT', 'UTC')
  return `${parts.year}-${parts.month}-${parts.day} ${weekday} ${parts.hour}:${parts.minute}（${timezone}，${offset}）`
}
