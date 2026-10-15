import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import { mkdir, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RuntimeManifest } from './runtime-types.ts'
import { dependencyUnavailable, invalidRequest } from '../../domain/request-errors.ts'

const IMAGE_PATTERN = /^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/
const ENTRY_PATTERN = /^(?:scripts\/)?[A-Za-z0-9._/-]+\.py$/

/** Executes declared Python source in a disposable, network-disabled container. */
export class PythonSkillRunner {
  readonly image: string
  private readonly command: string
  constructor(image: string, command = 'docker') {
    if (!IMAGE_PATTERN.test(image)) throw invalidRequest('DSH_WORK_PYTHON_IMAGE 必须使用 sha256 摘要锁定容器镜像')
    this.image = image
    this.command = command
  }

  async preflight() {
    const result = await run(this.command, ['image', 'inspect', this.image], AbortSignal.timeout(15000))
    if (result.exitCode !== 0) throw dependencyUnavailable(`Python Skill 沙箱镜像不可用：${result.stderr.trim() || this.image}`)
  }

  async execute(input: Record<string, unknown>, manifest: RuntimeManifest, workspaceDirectory: string, signal: AbortSignal) {
    const skillName = typeof input['skill'] === 'string' ? input['skill'].trim() : ''
    const entry = typeof input['entry'] === 'string' ? input['entry'].trim() : ''
    const args = input['args'] === undefined ? [] : input['args']
    if (!skillName || !ENTRY_PATTERN.test(entry) || entry.includes('..')) throw invalidRequest('Python Skill 或入口文件无效')
    if (!Array.isArray(args) || args.length > 32 || args.some(value => typeof value !== 'string' || value.length > 1000 || value.includes('\0'))) throw invalidRequest('Python 参数无效')
    const matches = manifest.agent_configuration.skill_instructions.filter(skill => (skill.name ?? skill.id) === skillName || skill.id === skillName)
    if (matches.length !== 1 || !matches[0]!.files?.some(file => file.path === entry && file.path.endsWith('.py'))) throw new Error('入口文件未在当前 Run 的锁定 Skill 中声明')
    const skillRoot = resolve(workspaceDirectory, 'skills', safeSegment(matches[0]!.id))
    const inputRoot = resolve(workspaceDirectory, 'input')
    const outputRoot = resolve(workspaceDirectory, 'python-output', safeSegment(matches[0]!.id))
    await Promise.all([mkdir(inputRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })])
    const dockerArgs = buildPythonSandboxArguments(this.image, skillRoot, inputRoot, outputRoot, entry, args as string[])
    const result = await run(this.command, dockerArgs, signal)
    const artifacts = await listArtifacts(outputRoot)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, artifacts }
  }
}

export function buildPythonSandboxArguments(image: string, skillRoot: string, inputRoot: string, outputRoot: string, entry: string, args: string[]) {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
    // A single written file may not exceed the largest artifact the runner will collect.
    '--ulimit', `fsize=${MAX_ARTIFACT_BYTES}:${MAX_ARTIFACT_BYTES}`,
    '--mount', `type=bind,src=${skillRoot},dst=/skill,readonly`,
    '--mount', `type=bind,src=${inputRoot},dst=/input,readonly`,
    '--mount', `type=bind,src=${outputRoot},dst=/output`,
    '--workdir', '/skill', image, 'python', '-I', '-B', entry, ...args,
  ]
}

const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

/**
 * Keeps at most `maxBytes` of a UTF-8 stream. Characters split across chunks are
 * reassembled, and a character cut by the limit is dropped rather than mangled.
 */
export function boundedUtf8Collector(maxBytes = MAX_CAPTURE_BYTES) {
  const decoder = new StringDecoder('utf8')
  let size = 0, text = ''
  return {
    write(chunk: Buffer) {
      if (size >= maxBytes) return
      const accepted = chunk.subarray(0, maxBytes - size)
      size += accepted.length
      text += decoder.write(accepted)
    },
    text: () => text,
  }
}

async function run(command: string, args: string[], signal: AbortSignal) {
  const child = spawn(command, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdoutCollector = boundedUtf8Collector(), stderrCollector = boundedUtf8Collector()
  child.stdout.on('data', (chunk: Buffer) => stdoutCollector.write(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderrCollector.write(chunk))
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', code => resolvePromise(code ?? -1))
  })
  return { exitCode, stdout: stdoutCollector.text(), stderr: stderrCollector.text() }
}

async function listArtifacts(root: string) {
  const names = (await readdir(root)).sort().slice(0, 20)
  const artifacts: Array<{ name: string; size: number }> = []
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue
    const details = await lstat(join(root, name))
    if (details.isFile() && details.size <= MAX_ARTIFACT_BYTES) artifacts.push({ name, size: details.size })
  }
  return artifacts
}

function safeSegment(value: string): string {
  const readable = value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}
