import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Execution isolation 4.7 (decisions 5, 6): an Attempt's `workspace/` is removed when the Attempt
 * ends, except a failed one, which stays three days for diagnosis. Registered artifacts are not
 * affected: their bytes and extracted text are in object storage, and nothing reads the workspace
 * after the Attempt ends (checkpoints are kept with the Run). The small metadata files next to it
 * (`manifest.json`, `sessions/`, the approval log) stay.
 */
export const FAILED_WORKSPACE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000
const END_MARKER = 'attempt-end.json'

interface AttemptEnd { status: string; endedAt: string }

/** Records how the Attempt ended and removes its workspace unless it failed. */
export async function retireAttemptWorkspace(attemptDirectory: string, status: string, now = new Date()) {
  const end: AttemptEnd = { status, endedAt: now.toISOString() }
  await writeFile(join(attemptDirectory, END_MARKER), `${JSON.stringify(end)}\n`)
  if (status !== 'failed') await rm(join(attemptDirectory, 'workspace'), { recursive: true, force: true })
}

/**
 * Removes workspaces under `<runtimeRoot>/<tenant>/<run>/<attempt>/` that the rules no longer keep:
 * ended without failing, failed more than three days ago, or — without an end record (Attempts from
 * before this rule, or cut off by a restart) — untouched for three days. Directories of Attempts
 * still running in this process are skipped.
 */
export async function sweepAttemptWorkspaces(runtimeRoot: string, options: {
  isActive: (attemptDirectory: string) => boolean
  now?: number
  retentionMs?: number
}): Promise<{ inspected: number; removed: number }> {
  const now = options.now ?? Date.now()
  const retention = options.retentionMs ?? FAILED_WORKSPACE_RETENTION_MS
  let inspected = 0
  let removed = 0
  for (const tenant of await directories(runtimeRoot)) {
    for (const run of await directories(tenant)) {
      for (const attempt of await directories(run)) {
        const workspace = join(attempt, 'workspace')
        const details = await lstat(workspace).catch(() => null)
        if (!details?.isDirectory() || options.isActive(attempt)) continue
        inspected += 1
        const end = await readEnd(attempt)
        const endedAt = end ? Date.parse(end.endedAt) : (await lstat(attempt)).mtimeMs
        const keep = end?.status === 'failed' || !end ? now - endedAt < retention : false
        if (keep) continue
        await rm(workspace, { recursive: true, force: true })
        removed += 1
      }
    }
  }
  return { inspected, removed }
}

async function directories(parent: string) {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory()).map(entry => join(parent, entry.name))
}

async function readEnd(attempt: string): Promise<AttemptEnd | null> {
  try {
    const parsed = JSON.parse(await readFile(join(attempt, END_MARKER), 'utf8')) as Partial<AttemptEnd>
    return typeof parsed.status === 'string' && typeof parsed.endedAt === 'string' && !Number.isNaN(Date.parse(parsed.endedAt))
      ? { status: parsed.status, endedAt: parsed.endedAt }
      : null
  } catch {
    return null
  }
}
