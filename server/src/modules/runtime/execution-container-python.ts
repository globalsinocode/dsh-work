import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RuntimeManifest } from './runtime-types.ts'
import { EXECUTION_CONTAINER_LIMITS, type ContainerCommand, type ContainerCommandResult } from './execution-backend.ts'
import { resolvePythonCall, skillDirectory } from './python-skill-runner.ts'

/** One `python_execute` call may run at most this long (dsh-work-tool-policy.js gives the tool 300 s). */
const PYTHON_CALL_TIMEOUT_MS = 290_000
const MAX_LISTED_FILES = 20
/** The contract's per-file bound for listed outputs; larger files are still collected by 2b-2 rules. */
const MAX_LISTED_BYTES = 20 * 1024 * 1024

/**
 * Execution isolation 1b② (plan 4.8): `python_execute` runs inside the Attempt's execution container,
 * with the Skill's own directory in the workspace as working directory and its paths given as
 * environment variables. Output goes to the workspace `output/`, so it is collected as artifacts
 * when the Attempt ends; the files this call created or changed are listed back to the model.
 */
export class ExecutionContainerPythonRunner {
  private readonly containers: {
    exec(attemptId: string, workspace: string, command: ContainerCommand, signal: AbortSignal): Promise<ContainerCommandResult>
  }

  constructor(containers: ExecutionContainerPythonRunner['containers']) {
    this.containers = containers
  }

  async execute(input: Record<string, unknown>, manifest: RuntimeManifest, workspaceDirectory: string, signal: AbortSignal) {
    const { skillId, entry, args } = resolvePythonCall(input, manifest)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const skillDir = skillDirectory(workspaceDirectory, skillId)
    const inputDir = resolve(workspaceDirectory, 'input')
    const outputDir = resolve(workspaceDirectory, 'output')
    await Promise.all([mkdir(inputDir, { recursive: true }), mkdir(outputDir, { recursive: true })])
    const before = await outputFiles(outputDir)
    const result = await this.containers.exec(manifest.attempt_id, workspaceDirectory, {
      argv: ['python3', '-I', '-B', entry, ...args],
      cwd: skillDir,
      env: { DSH_SKILL_DIR: skillDir, DSH_INPUT_DIR: inputDir, DSH_OUTPUT_DIR: outputDir },
      maxOutputBytes: EXECUTION_CONTAINER_LIMITS.maxOutputBytes,
      timeoutMs: PYTHON_CALL_TIMEOUT_MS,
      mayLeaveProcesses: true,
    }, signal)
    const after = await outputFiles(outputDir)
    const changed = [...after.entries()]
      .filter(([name, file]) => before.get(name)?.signature !== file.signature && file.size <= MAX_LISTED_BYTES)
      .map(([name, file]) => ({ name, size: file.size }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 137),
      stdout: result.stdout,
      stderr: [result.stderr, result.timedOut ? 'Python 执行超时，已终止。' : ''].filter(Boolean).join('\n'),
      artifacts: changed.slice(0, MAX_LISTED_FILES),
    }
  }
}

/** Top-level regular files in output/ with a change signature; links and directories are not outputs. */
async function outputFiles(root: string) {
  const files = new Map<string, { size: number; signature: string }>()
  for (const name of await readdir(root).catch(() => [])) {
    const details = await lstat(join(root, name)).catch(() => null)
    if (!details?.isFile()) continue
    files.set(name, { size: details.size, signature: `${details.size}:${details.mtimeMs}:${details.ino}` })
  }
  return files
}
