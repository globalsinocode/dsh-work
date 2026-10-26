/**
 * EX-00: stage timing summary of recent Runtime Attempts, read from the database.
 *
 *   pnpm report:run-timings -- [--since 2026-10-01T00:00:00Z] [--until …]
 *                               [--purpose employee|automation|session-summary|all|<purpose>]
 *                               [--run <runId> …] [--json]
 *
 * Reads DSH_WORK_DATABASE_URL; queries only, never writes. Stage values come from
 * the Runtime events (`run.started` and the terminal event) and the Attempt rows;
 * a stage that was not reported counts as missing, not as zero. Queue wait is
 * Attempt creation → claim; end to end is Attempt creation → terminal event.
 */
import { pathToFileURL } from 'node:url'

import { createDatabase } from '../../server/src/infrastructure/postgres/database.ts'
import { formatSummary, summarizeTimings, type AttemptSample } from './run-timings-summary.ts'

interface Options { since: string; until: string | null; purpose: string; runIds: string[]; json: boolean }

export function parseArguments(argv: readonly string[], now = new Date()): Options {
  const options: Options = {
    since: new Date(now.getTime() - 7 * 86_400_000).toISOString(), until: null, purpose: 'employee', runIds: [], json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    switch (argv[index]) {
      case '--since': options.since = requireValue('--since', value); index += 1; break
      case '--until': options.until = requireValue('--until', value); index += 1; break
      case '--purpose': options.purpose = requireValue('--purpose', value); index += 1; break
      case '--run': options.runIds.push(requireValue('--run', value)); index += 1; break
      case '--json': options.json = true; break
      case '--': break
      default: throw new Error(`未知参数：${argv[index]}`)
    }
  }
  for (const [name, date] of [['--since', options.since], ['--until', options.until]] as const) {
    if (date !== null && Number.isNaN(Date.parse(date))) throw new Error(`${name} 不是有效时间：${date}`)
  }
  return options
}

function requireValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`)
  return value
}

const numericKeys = ['prepare_ms', 'worker_spawn_ms', 'worker_init_ms', 'session_ready_ms', 'first_output_ms', 'execution_ms',
  'artifact_collect_ms', 'elapsed_ms', 'worker_rss_kb', 'worker_cpu_ms', 'input_tokens', 'output_tokens', 'tool_call_count']

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const url = process.env.DSH_WORK_DATABASE_URL
  if (!url) throw new Error('需要 DSH_WORK_DATABASE_URL')
  const database = createDatabase({ url, maxConnections: 2 })
  try {
    const rows = await database<Array<{
      attemptId: string; purpose: string | null; createdAt: Date; startedAt: Date | null
      started: Record<string, unknown> | null; terminalType: string | null
      terminal: Record<string, unknown> | null; terminalAt: Date | null
    }>>`
      select a.id as "attemptId", a.manifest->>'purpose' as purpose, a.created_at as "createdAt", a.started_at as "startedAt",
             started.safe_metadata as started, terminal.event_type as "terminalType",
             terminal.safe_metadata as terminal, terminal.occurred_at as "terminalAt"
        from run_attempts a
        left join lateral (
          select e.safe_metadata from run_events e
           where e.tenant_id = a.tenant_id and e.attempt_id = a.id and e.event_type = 'run.started'
           order by e.stream_position limit 1
        ) started on true
        left join lateral (
          select e.event_type, e.safe_metadata, e.occurred_at from run_events e
           where e.tenant_id = a.tenant_id and e.attempt_id = a.id
             and e.event_type in ('run.completed', 'run.failed', 'run.cancelled')
           order by e.stream_position desc limit 1
        ) terminal on true
       where a.created_at >= ${options.since}::timestamptz
         and (${options.until}::timestamptz is null or a.created_at < ${options.until}::timestamptz)
         and (${options.runIds.length === 0} or a.run_id = any(${options.runIds}))
       order by a.created_at
    `
    const samples: AttemptSample[] = rows
      .filter(row => options.purpose === 'all'
        || (options.purpose === 'employee' ? row.purpose === null : row.purpose === options.purpose))
      .map(row => {
        const merged = { ...(row.started ?? {}), ...(row.terminal ?? {}) }
        const metrics: Record<string, number | null> = Object.fromEntries(numericKeys.map(key => [key, asNumber(merged[key])]))
        metrics['queue_wait_ms'] = row.startedAt ? row.startedAt.getTime() - row.createdAt.getTime() : null
        metrics['end_to_end_ms'] = row.terminalAt ? row.terminalAt.getTime() - row.createdAt.getTime() : null
        return {
          attemptId: row.attemptId,
          purpose: row.purpose,
          outcome: row.terminalType === 'run.completed' ? 'completed'
            : row.terminalType === 'run.failed' ? 'failed'
              : row.terminalType === 'run.cancelled' ? 'cancelled' : 'unfinished',
          errorCode: typeof row.terminal?.['error_code'] === 'string' ? row.terminal['error_code'] as string : null,
          metrics,
        }
      })
    const summary = summarizeTimings(samples)
    process.stdout.write(options.json
      ? `${JSON.stringify({ options, summary }, null, 2)}\n`
      : `时间范围：${options.since} ～ ${options.until ?? '现在'}；范围：${options.purpose}\n${formatSummary(summary)}\n`)
  } finally {
    await database.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
