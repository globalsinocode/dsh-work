import { sessionSummaryMaxConcurrent } from './conversation-context.ts'

/**
 * Background work that shares the Runtime with interactive work. Each purpose has
 * its own lane: at most this many Attempts run at once, and the effective limit is
 * min(limit, capacity - 1) so one Worker always stays free for interactive work.
 * Automation has its own configurable lane and is not listed here.
 */
export const backgroundLaneMaxConcurrent = {
  'session-summary': sessionSummaryMaxConcurrent,
  /** S3: Agent validation cases run in parallel, at most two at a time. */
  'agent-release-trial': 2,
} as const

export type BackgroundLanePurpose = keyof typeof backgroundLaneMaxConcurrent

export function isBackgroundLanePurpose(purpose: string | null | undefined): purpose is BackgroundLanePurpose {
  return purpose !== null && purpose !== undefined && Object.hasOwn(backgroundLaneMaxConcurrent, purpose)
}
