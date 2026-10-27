import { lstat, readdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Execution isolation 4.7: disk use of one Attempt workspace and free space on the data volume.
 * Only the given workspace is measured — never other Attempts, users' files or object storage.
 */
export const WORKSPACE_LIMITS = {
  /** Per-Attempt workspace cap: inputs, intermediates and outputs together. */
  maxBytes: 2 * 1024 ** 3,
  /** More entries than this counts as over the cap (masses of small files). */
  maxEntries: 50_000,
  /** Commands that leave the workspace above this fail the Attempt (overshoot between two measurements). */
  failBytes: 4 * 1024 ** 3,
  /** Measurement interval while a command runs. */
  pollMs: 2_000,
  /** Commands are refused while the data volume has less than max(this, minFreeRatio) free. */
  minFreeBytes: 10 * 1024 ** 3,
  minFreeRatio: 0.1,
} as const

export interface WorkspaceUsage {
  /** Allocated bytes (`st_blocks × 512`), so sparse files count what they really use. */
  bytes: number
  entries: number
  /** The walk stopped at `maxEntries`; treat as over the cap. */
  truncated: boolean
}

/**
 * Walks the workspace without following links. Hard links count once per name (conservative).
 * Entries that vanish mid-walk are skipped; a missing workspace measures as empty.
 */
export async function measureWorkspace(root: string, maxEntries: number = WORKSPACE_LIMITS.maxEntries): Promise<WorkspaceUsage> {
  let bytes = 0
  let entries = 0
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()!
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      entries += 1
      if (entries > maxEntries) return { bytes, entries, truncated: true }
      const path = join(directory, name)
      const details = await lstat(path).catch(() => null)
      if (!details) continue
      bytes += details.blocks * 512
      if (details.isDirectory()) stack.push(path)
    }
  }
  return { bytes, entries, truncated: false }
}

export function overWorkspaceLimit(usage: WorkspaceUsage) {
  return usage.truncated || usage.bytes > WORKSPACE_LIMITS.maxBytes
}

export interface FreeSpace {
  freeBytes: number
  totalBytes: number
  /** Below max(minFreeBytes, minFreeRatio × total). */
  low: boolean
}

/** Free space available to the service on the volume holding `path`. */
export async function freeSpace(path: string): Promise<FreeSpace> {
  const stats = await statfs(path)
  const freeBytes = stats.bavail * stats.bsize
  const totalBytes = stats.blocks * stats.bsize
  const threshold = Math.max(WORKSPACE_LIMITS.minFreeBytes, WORKSPACE_LIMITS.minFreeRatio * totalBytes)
  return { freeBytes, totalBytes, low: freeBytes < threshold }
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
