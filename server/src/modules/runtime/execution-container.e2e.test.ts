import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { AcpJsonRpcClient } from './acp-json-rpc-client.ts'
import { AttemptExecutionContainers, resolveExecutionContainerUser } from './attempt-execution-containers.ts'
import { DockerExecutionBackend } from './docker-execution-backend.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation, withExecutionContainerOverlay } from './dsh-runtime-installation.ts'
import { createPlatformToolBridge } from './platform-tool-bridge.ts'
import { createRemoteSubprocessGateway, type ContainerCommandAudit } from './remote-subprocess-gateway.ts'

/**
 * P1-style check through real DSH and real Docker (no model vendor: a scripted
 * OpenAI-compatible fake). Opt-in: set DSH_WORK_EXECUTION_E2E_IMAGE to an image
 * pinned by digest or local ID that contains `rg`, and DSH_RUNTIME_HOME to the DSH checkout.
 */
const image = process.env.DSH_WORK_EXECUTION_E2E_IMAGE?.trim()
const skip = !image ? 'DSH_WORK_EXECUTION_E2E_IMAGE is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set'
    : spawnSync('docker', ['info'], { timeout: 5_000 }).status !== 0 ? 'Docker is not available' : false
const projectRoot = resolve(import.meta.dirname, '../../../..')

test('DSH glob/grep run inside the Attempt execution container; bash stays refused', { skip, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exec-e2e-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'notes'), { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'hello world\n')
  await writeFile(join(workspace, 'notes', 'b.txt'), 'hello again\n')
  await writeFile(join(workspace, 'c.md'), 'nothing here\n')
  const env = { ...process.env, DSH_WORK_DATA_ROOT: join(root, 'data') }

  // Same composition main.ts uses: deployment patch, then the execution container overlay, verified by preflight.
  const installation = await withExecutionContainerOverlay(await resolveDshRuntimeInstallation({ projectRoot, env }), { projectRoot, env })
  await preflightDshRuntime(installation)

  const backend = new DockerExecutionBackend()
  const containers = new AttemptExecutionContainers(backend, { image: image!, user: resolveExecutionContainerUser() })
  await backend.inspectExecutionImage(containers.image, containers.user)
  await backend.detectFeatures()

  const steps = [
    { name: 'glob', args: { pattern: '**/*.txt' } },
    { name: 'grep', args: { pattern: 'hello' } },
    { name: 'bash', args: { command: 'id', description: 'should be refused' } },
  ]
  const toolResults: unknown[] = []
  const model = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }
      const results = parsed.messages.filter(message => message.role === 'tool')
      if (results.length) toolResults[results.length - 1] = results.at(-1)!.content
      const step = steps[results.length]
      const delta = step
        ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${results.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: 'done' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (choices: unknown[], extra: object = {}) => response.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'e2e-chat', choices, ...extra })}\n\n`)
      chunk([{ index: 0, delta, finish_reason: null }])
      chunk([{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }])
      chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolveListen => model.listen(0, '127.0.0.1', resolveListen))
  const modelPatch = join(root, 'model.cordis.patch.yml')
  await writeFile(modelPatch, [
    '- id: settings', '  config:', `    path: ${JSON.stringify(join(root, 'settings.yaml'))}`,
    '- id: llm-pi-ai', '  config:', '    providers:', '      dshw-e2e:', '        api: openai-completions', '        apiKeyEnv: DSHW_E2E_KEY',
    `        baseURL: http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, '        models:', '          - id: e2e-chat', '            name: e2e', '            contextWindow: 131072',
    '- id: acp', '  config:', '    provider: dshw-e2e', '    model: e2e-chat', '',
  ].join('\n'))

  const audits: ContainerCommandAudit[] = []
  const attemptId = 'e2e-attempt'
  const bridge = await createPlatformToolBridge({}, 10, undefined, undefined, undefined, createRemoteSubprocessGateway({
    workspace,
    run: (command, signal) => containers.exec(attemptId, workspace, command, signal),
    onCommand: audit => audits.push(audit),
  }))
  const client = AcpJsonRpcClient.launch({
    ...installation.process,
    args: [...installation.process.args, '--patch', modelPatch],
    env: {
      ...installation.process.env,
      DSH_HOME: join(root, 'dsh-home'),
      DSHW_E2E_KEY: 'e2e-key',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_PLATFORM_TOOL_SOCKET: bridge.socket,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: join(root, 'sessions'),
      DSH_ALLOWED_TOOLS_JSON: JSON.stringify(['glob', 'grep', 'bash']),
      DSH_MAX_TOOL_CALLS: '10',
      DSH_WORKSPACE_ROOT: workspace,
      DSH_TOOL_APPROVAL_MODE: 'never',
      DSH_TOOL_APPROVAL_LOG: join(root, 'approvals.jsonl'),
    },
  }, {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  try {
    await client.initialize()
    const sessionId = await client.newSession(workspace)
    await client.prompt(sessionId, 'run the checks')
    const [globResult, grepResult, bashResult] = toolResults.map(value => typeof value === 'string' ? value : JSON.stringify(value))
    assert.match(globResult ?? '', /a\.txt/)
    assert.match(globResult ?? '', /notes\/b\.txt/)
    assert.doesNotMatch(globResult ?? '', /c\.md/)
    assert.match(grepResult ?? '', /hello world/)
    assert.match(grepResult ?? '', /hello again/)
    assert.doesNotMatch(bashResult ?? '', /uid=/, 'bash never ran')
    assert.deepEqual(audits.map(audit => [audit.executable, audit.exitCode]), [['rg', 0], ['rg', 0]], 'only the two rg commands reached the container')
    assert.equal(containers.activeAttempts.length, 1, 'one container for the Attempt')
  } finally {
    await client.close().catch(() => undefined)
    await bridge.close()
    await containers.release(attemptId).catch(() => undefined)
    model.close()
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(containers.activeAttempts.length, 0)
  const leftover = spawnSync('docker', ['ps', '-aq', '--filter', 'label=dsh-work.execution-container=1'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(leftover, '', 'the Attempt container was removed')
})
