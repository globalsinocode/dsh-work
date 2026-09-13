import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AcpJsonRpcClient, type AcpProcessConfiguration } from '../../server/src/modules/runtime/acp-json-rpc-client.ts'
import { resolveDshRuntimeInstallation } from '../../server/src/modules/runtime/dsh-runtime-installation.ts'
import { redactSensitiveText } from '../../server/src/security/safe-observability.ts'

const modes = ['handshake', 'model', 'tool', 'artifact', 'cancel', 'concurrency'] as const
type ProbeMode = typeof modes[number]
const toolMarker = 'DSH_WORK_TOOL_7F3C91A2'
const artifactMarker = 'DSH_WORK_ARTIFACT_4B8E20D7'
const execFileAsync = promisify(execFile)

export async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Probe timed out after ${milliseconds} ms`)), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

// Register each client immediately so partial startup failures also close earlier workers.
export async function withProbeWorkspace<T>(
  run: (root: string, clients: Array<{ close(): Promise<void> }>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-probe-'))
  const clients: Array<{ close(): Promise<void> }> = []
  const failures: unknown[] = []
  let value: T | undefined
  try {
    value = await run(root, clients)
  } catch (error) {
    failures.push(error)
  }
  const closed = await Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.close())))
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
  try {
    // Tool input directories are read-only during the probe, including on failure.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('workspace-')) {
        await chmod(join(root, entry.name, 'input'), 0o755).catch(() => undefined)
      }
    }
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Probe execution or cleanup failed')
  return value as T
}

export async function runProbe(mode: ProbeMode, configuration: AcpProcessConfiguration, version: string) {
  const runBatch = (concurrency: number) => withProbeWorkspace(async (root, registered) => {
    const diagnostics: string[] = []
    let diagnosticCount = 0
    let permissionRequestCount = 0
    const updateTypes = new Set<string>()
    const texts = Array.from({ length: concurrency }, () => '')
    const clients: AcpJsonRpcClient[] = []
    const sessions: string[] = []
    let sampling = false
    let peakRssKiB = 0
    let sampler: Promise<void> | undefined
    let samplingError: unknown
    try {
      const workspaces = await Promise.all(texts.map(async (_text, index) => {
        const workspace = join(root, `workspace-${index}`)
        await mkdir(workspace)
        if (mode === 'tool' || mode === 'artifact') {
          await mkdir(join(workspace, 'input'))
          const path = join(workspace, 'input', mode === 'artifact' ? 'source.txt' : 'inventory-status.txt')
          await writeFile(path, `${mode === 'artifact' ? artifactMarker : toolMarker}\n`, { flag: 'wx' })
          await chmod(path, 0o444)
          await chmod(join(workspace, 'input'), 0o555)
          if (mode === 'artifact') await mkdir(join(workspace, 'output'))
        }
        return workspace
      }))
      for (let index = 0; index < concurrency; index += 1) {
        const client = AcpJsonRpcClient.launch({
          ...configuration,
          env: {
            ...configuration.env,
            DSH_PERMISSION_MODE: 'workspace-write',
            DSH_SNAPSHOT: 'record',
            DSH_SNAPSHOT_SESSIONS_ROOT: join(root, `sessions-${index}`),
            DSH_WORK_DSH_SESSIONS_ROOT: join(root, `sessions-${index}`),
            DSH_WORKSPACE_ROOT: workspaces[index]!,
            DSH_ALLOWED_TOOLS_JSON: JSON.stringify(mode === 'artifact' ? ['read', 'write'] : mode === 'tool' ? ['read'] : []),
            DSH_TOOL_APPROVAL_MODE: 'never',
          },
          shutdownGraceMs: 5000,
        }, {
          onSessionUpdate: ({ update }) => {
            if (typeof update['sessionUpdate'] === 'string') updateTypes.add(update['sessionUpdate'])
            const content = update['content']
            if (update['sessionUpdate'] === 'agent_message_chunk' && isRecord(content)
              && content['type'] === 'text' && typeof content['text'] === 'string') texts[index] += content['text']
          },
          onPermissionRequest: async () => {
            permissionRequestCount += 1
            return { outcome: { outcome: 'cancelled' } }
          },
          onDiagnostic: message => {
            diagnosticCount += 1
            diagnostics.push(redactSensitiveText(message).slice(-1000))
            if (diagnostics.length > 8) diagnostics.shift()
          },
        })
        registered.push(client)
        clients.push(client)
      }
      const initialized = await withDeadline(Promise.all(clients.map(client => client.initialize())), 30_000)
      sessions.push(...await withDeadline(Promise.all(clients.map((client, index) => client.newSession(workspaces[index]!))), 30_000))
      const base = { dshVersion: version, protocolVersion: initialized[0]?.['protocolVersion'], transport: 'acp-stdio', diagnosticCount }
      if (mode === 'handshake') {
        await clients[0]!.cancel(sessions[0]!)
        return { ...base, sessionCreated: sessions[0]!.length > 0, realModelPromptExecuted: false }
      }
      const startedAt = performance.now()
      if (mode === 'cancel') {
        const response = await withDeadline((async () => {
          // Attach rejection handling before waiting to send cancellation.
          const prompt = clients[0]!.prompt(sessions[0]!, '请生成一份非常详细的企业数据治理实施手册，至少包含一百个章节。在完成前不要提前总结。')
          const cancellation = delay(250).then(() => clients[0]!.cancel(sessions[0]!))
          return (await Promise.all([prompt, cancellation]))[0]
        })(), 30_000)
        if (response['stopReason'] !== 'cancelled') throw new Error(`Unexpected cancellation stopReason: ${String(response['stopReason'])}`)
        return { ...base, diagnosticCount, realModelCancellationVerified: true, stopReason: 'cancelled', settleMs: Math.round(performance.now() - startedAt) }
      }
      if (mode === 'concurrency') {
        sampling = true
        sampler = samplePeakRss(clients.flatMap(client => client.pid === undefined ? [] : [client.pid]),
          () => sampling, rss => { peakRssKiB = Math.max(peakRssKiB, rss) })
          .catch(error => { samplingError = error })
      }
      const prompt = mode === 'artifact'
        ? '请读取只读文件 input/source.txt，将其中的完整标记写入 output/report.md，文件内容只包含一级标题“POC 成果”和该标记。完成后只回复“成果已生成”。'
        : mode === 'tool'
          ? '请使用文件读取工具读取 input/inventory-status.txt，并且只回复文件中的完整标记。不要猜测文件内容。'
          : '这是一条 dsh-work 合成链路测试消息。请只回复 DSH_WORK_MODEL_OK，不要调用任何工具。'
      const responses = await withDeadline(Promise.all(clients.map((client, index) => client.prompt(sessions[index]!, prompt))), 180_000)
      const elapsedMs = Math.round(performance.now() - startedAt)
      sampling = false
      await sampler
      if (samplingError) throw samplingError
      if (responses.some(response => response['stopReason'] !== 'end_turn') || texts.some(text => !text.trim())) {
        throw new Error('Probe requires end_turn and nonempty assistant text for every worker')
      }
      if (mode === 'concurrency') {
        return { concurrency, succeeded: responses.length, elapsedMs, peakWorkerTreeRssMiB: Math.round(peakRssKiB / 1024), diagnosticCount }
      }
      if (mode === 'tool' && !texts[0]!.includes(toolMarker)) throw new Error('Tool response did not contain the workspace-only marker')
      const evidence = await waitForSessionEvidence(join(root, 'sessions-0'), mode !== 'model')
      const artifact = mode === 'artifact' ? await verifyArtifact(workspaces[0]!, artifactMarker) : undefined
      return {
        ...base, diagnosticCount, modelConfiguration: 'dsh-default', realModelPromptExecuted: true,
        realReadOnlyToolVerified: mode !== 'model', tokenUsageRecorded: true, ...evidence,
        artifactVerified: artifact !== undefined, artifactBytes: artifact?.bytes ?? 0, artifactSha256: artifact?.sha256 ?? null,
        assistantTextReceived: true, assistantResponseBytes: Buffer.byteLength(texts[0]!), stopReason: 'end_turn',
      }
    } catch (error) {
      await Promise.allSettled(clients.map((client, index) => sessions[index] ? client.cancel(sessions[index]!) : Promise.resolve()))
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1000)
      throw new Error(JSON.stringify({ error: message, diagnostic: diagnostics.join('\n') || null,
        updateTypes: [...updateTypes].slice(0, 20), permissionRequestCount }))
    } finally {
      sampling = false
      await sampler
    }
  })
  if (mode !== 'concurrency') return { ok: true, probeMode: mode, ...await runBatch(1) }
  const batches = []
  for (const count of [1, 3, 5]) batches.push(await runBatch(count))
  return { ok: true, probeMode: mode, dshVersion: version, transport: 'acp-stdio', modelConfiguration: 'dsh-default', batches }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function waitForSessionEvidence(root: string, requireTool: boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const evidence = await readSessionEvidence(root)
    if (evidence && (!requireTool || evidence.toolCallCount > 0 && evidence.toolResultCount > 0)) return evidence
    await delay(100)
  }
  throw new Error('DSH canonical Session Log did not contain the expected usage and Tool evidence')
}

export async function readSessionEvidence(root: string) {
  const paths = await findSessionLogs(root)
  let inputTokens = 0
  let outputTokens = 0
  let usageFound = false
  let toolCallCount = 0
  let toolResultCount = 0
  for (const path of paths) {
    // Ignore a trailing partial record while the runtime is appending the log.
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!line) continue
      let event: unknown
      try { event = JSON.parse(line) } catch (error) {
        if (index === lines.length - 1) continue
        throw error
      }
      if (!isRecord(event)) continue
      if (event['type'] === 'tool/call') toolCallCount += 1
      if (event['type'] === 'tool/result') toolResultCount += 1
      if (event['type'] !== 'assistant/message' || !isRecord(event['data'])) continue
      const usage = event['data']['usage']
      if (!isRecord(usage) || typeof usage['inputTokens'] !== 'number' || typeof usage['outputTokens'] !== 'number') continue
      usageFound = true
      inputTokens += usage['inputTokens']
      outputTokens += usage['outputTokens']
    }
  }
  return usageFound ? { inputTokens, outputTokens, toolCallCount, toolResultCount } : undefined
}

async function findSessionLogs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSessionLogs(path))
    else if (entry.isFile() && entry.name === 'session.jsonl') paths.push(path)
  }
  return paths
}

export async function verifyArtifact(workspace: string, marker: string) {
  if (await readFile(join(workspace, 'input/source.txt'), 'utf8') !== `${marker}\n`) throw new Error('Artifact probe modified the read-only input')
  const artifact = await readFile(join(workspace, 'output/report.md'))
  if (!artifact.toString('utf8').includes(marker)) throw new Error('Artifact output does not contain the source marker')
  return { bytes: artifact.byteLength, sha256: createHash('sha256').update(artifact).digest('hex') }
}

async function samplePeakRss(roots: number[], active: () => boolean, observe: (rssKiB: number) => void) {
  while (active()) {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5000 })
    const processes = stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    const descendants = new Set(roots)
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parent] of processes) {
        if (pid === undefined || parent === undefined || descendants.has(pid) || !descendants.has(parent)) continue
        descendants.add(pid)
        changed = true
      }
    }
    observe(processes.reduce((total, [pid, , rss]) => pid !== undefined && rss !== undefined && descendants.has(pid) ? total + rss : total, 0))
    await delay(100)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  const help = 'Usage: pnpm probe <handshake|model|tool|artifact|cancel|concurrency>\nhandshake does not call a model. All other modes call the configured DSH model. Temporary workspaces and logs are removed on exit.'
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!)) console.log(help)
  else if (args.length !== 1 || !modes.includes(args[0] as ProbeMode)) {
    console.error(help)
    process.exitCode = 2
  } else {
    try {
      const result = await withProbeWorkspace(async root => {
        const projectRoot = resolve(import.meta.dirname, '../..')
        const installation = await resolveDshRuntimeInstallation({ projectRoot, env: { ...process.env, DSH_WORK_DATA_ROOT: root } })
        const deploymentConfig = process.env['DSH_DEPLOYMENT_CONFIG']
        const configuration = deploymentConfig === undefined ? installation.process : {
          ...installation.process,
          // The resolver appends --patch/--config and its overlay as the final arguments.
          args: [...installation.process.args.slice(0, -1), resolve(deploymentConfig)],
        }
        return runProbe(args[0] as ProbeMode, configuration, installation.version)
      })
      console.log(JSON.stringify(result))
    } catch (error) {
      console.error(JSON.stringify({ ok: false, probeMode: args[0], error: redactSensitiveText(error instanceof Error ? error.message : String(error)) }))
      process.exitCode = 1
    }
  }
}
