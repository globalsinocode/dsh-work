import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import { minimalXlsx } from '../../testing/office-fixtures.ts'
import { ContainerArtifactTextExtractor } from '../workbench/application/container-artifact-text-extractor.ts'
import { ContainerExecutor } from './container-executor.ts'
import { measureWorkspace } from './workspace-usage.ts'
import { ExecutionContainerPythonRunner } from './execution-container-python.ts'
import { skillDirectory } from './python-skill-runner.ts'
import type { RuntimeManifest } from './runtime-types.ts'

/**
 * P1-style check through real DSH and real Docker (no model vendor: a scripted
 * OpenAI-compatible fake). Opt-in: set DSH_WORK_EXECUTION_E2E_IMAGE to an execution image
 * pinned by digest or local ID that passes the startup toolchain check (bash, rg, LibreOffice,
 * poppler; the image built by .github/workflows/execution-image.yml), and DSH_RUNTIME_HOME to the DSH checkout.
 */
const image = process.env.DSH_WORK_EXECUTION_E2E_IMAGE?.trim()
const skip = !image ? 'DSH_WORK_EXECUTION_E2E_IMAGE is not set'
  : !process.env.DSH_RUNTIME_HOME ? 'DSH_RUNTIME_HOME is not set'
    : spawnSync('docker', ['info'], { timeout: 5_000 }).status !== 0 ? 'Docker is not available' : false
const projectRoot = resolve(import.meta.dirname, '../../../..')

test('DSH glob/grep/bash run inside the Attempt execution container and stay contained', { skip, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exec-e2e-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'notes'), { recursive: true })
  await mkdir(join(workspace, 'output'), { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'hello world\n')
  await writeFile(join(workspace, 'notes', 'b.txt'), 'hello again\n')
  await writeFile(join(workspace, 'c.md'), 'nothing here\n')
  // 2b-4: an original input file as the Adapter mounts it (read-only for the service user).
  await mkdir(join(workspace, 'input', 'original'), { recursive: true })
  await writeFile(join(workspace, 'input', 'original', '01-data.xlsx'), minimalXlsx(), { mode: 0o400 })
  // Another Attempt's workspace and host files next to this one: never visible in the container.
  await mkdir(join(root, 'other-attempt'), { recursive: true })
  await writeFile(join(root, 'other-attempt', 'secret.txt'), 'other attempt secret\n')
  const sentinel = `dsh-work-e2e-sentinel-${Date.now()}`
  const env = { ...process.env, DSH_WORK_DATA_ROOT: join(root, 'data') }

  // Same composition main.ts uses: deployment patch, then the execution container overlay, verified by preflight.
  const installation = await withExecutionContainerOverlay(await resolveDshRuntimeInstallation({ projectRoot, env }), { projectRoot, env })
  await preflightDshRuntime(installation)

  const backend = new DockerExecutionBackend()
  // The free-space guard (plan 4.7) has its own tests; a developer machine low on disk must not turn
  // this chain test into a refusal. Workspace measurement stays real.
  const containers = new AttemptExecutionContainers(backend, {
    image: image!, user: resolveExecutionContainerUser(),
    usage: {
      measure: root => measureWorkspace(root),
      freeSpace: async () => ({ freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER, low: false }),
    },
  })
  // The same startup check main.ts runs: the image must provide the Office toolchain (2b-1).
  const toolchain = await backend.inspectExecutionImage(containers.image, containers.user)
  for (const id of ['bash', 'rg', 'soffice', 'pdftoppm']) assert.ok(toolchain.some(tool => tool.id === id), id)
  await backend.detectFeatures()

  const dshHome = join(root, 'dsh-home')
  const probe = (label: string, script: string) => ({ name: 'bash', args: { command: script, description: label } })
  const buildSteps = (socket: string) => [
    { name: 'glob', args: { pattern: '**/*.txt' } },
    { name: 'grep', args: { pattern: 'hello' } },
    // The model writes and runs a script; its output lands in the shared workspace.
    probe('script', 'mkdir -p work && printf "print(sum(range(101)))" > work/s.py && python3 work/s.py > output/sum.txt && cat output/sum.txt && id -u'),
    probe('original', 'python3 -c "import zipfile; print(sorted(zipfile.ZipFile(\'input/original/01-data.xlsx\').namelist()))"'),
    // 2b-1: LibreOffice and poppler work under the container posture (read-only root, HOME tmpfs,
    // uid without a passwd entry): a workbook written with openpyxl becomes a PDF artifact with
    // Simplified Chinese glyphs, and a page image.
    probe('office', [
      'python3 -c "import openpyxl; book = openpyxl.Workbook(); book.active.append([\'区域\', \'收入\']); book.active.append([\'华东\', 1200]); book.save(\'work/营收.xlsx\')"',
      'soffice --headless --convert-to pdf --outdir output work/营收.xlsx > work/soffice.log 2>&1; test -s output/营收.pdf || cat work/soffice.log',
      'head -c 5 output/营收.pdf; echo',
      'pdffonts output/营收.pdf | grep -oE "NotoSansCJK[a-z]+" | sort -u',
      'pdftoppm -png -r 30 -singlefile output/营收.pdf work/page && test -s work/page.png && echo PNG_OK',
    ].join('\n')),
    // Fixed environment: no Worker variables, no DSH_HOME, no bridge socket, no other workspaces or host files.
    probe('env', [
      'env; echo ---',
      'cat /proc/1/environ | tr "\\0" "\\n"; echo ---',
      `test -e ${JSON.stringify(socket)} && echo SOCKET_VISIBLE`,
      `for path in ${JSON.stringify(dshHome)} ${JSON.stringify(join(root, 'other-attempt'))} ${JSON.stringify(join(projectRoot, '.env'))} ${JSON.stringify(join(projectRoot, 'server'))}; do test -e "$path" && echo "VISIBLE $path"; done`,
      'echo ENV_DONE',
    ].join('\n')),
    // No network and a read-only root.
    probe('network', 'python3 -c "import socket; socket.create_connection((\'1.1.1.1\', 53), 3)" && echo NET_OK || echo NET_BLOCKED; (echo x > /etc/x) 2>/dev/null && echo ROOT_WRITABLE || echo ROOT_READONLY'),
    // Detached leftovers: the quiescence step must clear them before the next tool runs.
    // The braces send bash's own redirect error (a process exiting mid-scan) to /dev/null too.
    probe('leftover', 'setsid sleep 300 > /dev/null 2>&1 < /dev/null & nohup sleep 301 > /dev/null 2>&1 & echo STARTED'),
    probe('leftover-check', 'for p in /proc/[0-9]*; do { tr "\\0" " " < "$p/cmdline"; } 2>/dev/null; echo; done | grep -c "^sleep 30[01]" || true'),
    // bash-local's own deadline: terminate aborts the bridge request and the platform kills the process group.
    { name: 'bash', args: { command: 'sleep 30; echo SHOULD_NOT_PRINT', description: 'timeout', timeoutMs: 2000 } },
    probe('timeout-check', 'for p in /proc/[0-9]*; do { tr "\\0" " " < "$p/cmdline"; } 2>/dev/null; echo; done | grep -c "^sleep 30 *$" || true'),
    // C tier has no background jobs.
    { name: 'bash', args: { command: 'echo BACKGROUND_RAN', description: 'background', run_in_background: true } },
  ]
  let steps: ReturnType<typeof buildSteps> = []
  const toolResults: string[] = []
  let modelToolNames: string[] = []
  const model = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      if (!modelToolNames.length) modelToolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '')
      const results = parsed.messages.filter(message => message.role === 'tool')
      if (results.length) {
        const content = results.at(-1)!.content
        toolResults[results.length - 1] = typeof content === 'string' ? content : JSON.stringify(content)
      }
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
  const bridge = await createPlatformToolBridge({}, 20, undefined, undefined, undefined, createRemoteSubprocessGateway({
    workspace,
    run: (command, signal) => containers.exec(attemptId, workspace, command, signal),
    onCommand: audit => audits.push(audit),
  }))
  // The bridge socket's host path is only known now; the env probe checks it is not reachable.
  steps = buildSteps(bridge.socket)
  const client = AcpJsonRpcClient.launch({
    ...installation.process,
    args: [...installation.process.args, '--patch', modelPatch],
    env: {
      ...installation.process.env,
      DSH_HOME: dshHome,
      DSHW_E2E_KEY: 'e2e-key',
      DSH_WORK_E2E_SENTINEL: sentinel,
      DSH_PLATFORM_TOOL_SOCKET: bridge.socket,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: join(root, 'sessions'),
      DSH_ALLOWED_TOOLS_JSON: JSON.stringify(['glob', 'grep', 'bash']),
      DSH_MAX_TOOL_CALLS: '20',
      DSH_WORKSPACE_ROOT: workspace,
      DSH_TOOL_APPROVAL_MODE: 'never',
      DSH_TOOL_APPROVAL_LOG: join(root, 'approvals.jsonl'),
    },
  }, {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => { permissionRequests += 1; return { outcome: { outcome: 'cancelled' } } },
  })
  let permissionRequests = 0
  try {
    await client.initialize()
    const sessionId = await client.newSession(workspace)
    await client.prompt(sessionId, 'run the checks')
    const [globResult, grepResult, scriptResult, originalResult, officeResult, envResult, networkResult, leftoverResult, leftoverCheck, timeoutResult, timeoutCheck, backgroundResult] = toolResults
    assert.match(globResult ?? '', /a\.txt/)
    assert.match(globResult ?? '', /notes\/b\.txt/)
    assert.doesNotMatch(globResult ?? '', /c\.md/)
    assert.match(grepResult ?? '', /hello world/)
    assert.match(grepResult ?? '', /hello again/)

    // bash ran in the container, as the service user, writing into the shared workspace.
    assert.match(scriptResult ?? '', new RegExp(`5050\\s+${resolveExecutionContainerUser().split(':')[0]}`))
    assert.equal((await readFile(join(workspace, 'output', 'sum.txt'), 'utf8')).trim(), '5050')
    assert.match(originalResult ?? '', /xl\/workbook\.xml/, 'the container reads the read-only original input')
    assert.match(officeResult ?? '', /%PDF-/, 'soffice converted the workbook under the container posture')
    assert.match(officeResult ?? '', /NotoSansCJKsc/)
    assert.doesNotMatch(officeResult ?? '', /NotoSansCJK(jp|kr|tc|hk)/)
    assert.match(officeResult ?? '', /PNG_OK/)
    assert.equal((await readFile(join(workspace, 'output', '营收.pdf'))).subarray(0, 5).toString(), '%PDF-')
    assert.equal(permissionRequests, 0, 'approval follows the Agent mode (never here); DSH adds no prompt of its own')

    assert.match(envResult ?? '', /ENV_DONE/)
    assert.doesNotMatch(envResult ?? '', new RegExp(sentinel), 'Worker variables never reach the container')
    assert.doesNotMatch(envResult ?? '', /DSH_|DSHW_E2E_KEY|e2e-key/)
    assert.doesNotMatch(envResult ?? '', /SOCKET_VISIBLE|VISIBLE /)

    assert.match(networkResult ?? '', /NET_BLOCKED/)
    assert.match(networkResult ?? '', /ROOT_READONLY/)

    assert.match(leftoverResult ?? '', /STARTED/)
    assert.equal((leftoverCheck ?? '').trim(), '0', 'setsid/nohup leftovers are gone before the next tool runs')

    assert.ok(timeoutResult !== undefined, 'the timeout step ran')
    assert.doesNotMatch(timeoutResult, /SHOULD_NOT_PRINT/)
    const timedOut = audits.find(audit => audit.summary.includes('SHOULD_NOT_PRINT'))
    assert.ok(timedOut && (timedOut.aborted || timedOut.timedOut), 'the timed-out command was cut off in the container')
    assert.ok(timedOut.durationMs < 15_000, `cut off near its 2 s deadline, not after sleep 30 (${timedOut.durationMs} ms)`)
    assert.equal((timeoutCheck ?? '').trim(), '0', 'the timed-out process group is gone before the next tool runs')

    assert.ok(backgroundResult !== undefined, 'the background step ran')
    assert.doesNotMatch(backgroundResult, /BACKGROUND_RAN/, 'run_in_background never starts a job')
    assert.ok(modelToolNames.includes('bash'), 'bash is visible to the model')
    assert.equal(modelToolNames.some(name => name.startsWith('job_')), false, 'job tools are not visible')

    // Only ripgrep and bash -c reach the container, each command audited.
    assert.deepEqual([...new Set(audits.map(audit => audit.executable))].sort(), ['bash', 'rg'])
    assert.ok(audits.filter(audit => audit.executable === 'bash').length >= 5)
    assert.equal(containers.activeAttempts.length <= 1, true, 'at most one container for the Attempt')
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

const extractionSkip = !image ? 'DSH_WORK_EXECUTION_E2E_IMAGE is not set'
  : spawnSync('docker', ['info'], { timeout: 15_000 }).status !== 0 ? 'Docker is not available' : false

test('2b-3: binary artifact text is extracted by the platform script in a disposable container', { skip: extractionSkip, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-e2e-'))
  try {
    // Real Office files written by the image's own libraries and LibreOffice, as an Agent would produce them.
    const generated = join(root, 'generated')
    await mkdir(generated)
    const user = resolveExecutionContainerUser()
    const make = spawnSync('docker', [
      'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', user,
      '--tmpfs', '/tmp', '--tmpfs', `/home/exec:uid=${user.split(':')[0]},gid=${user.split(':')[1]}`, '-e', 'HOME=/home/exec',
      '--mount', `type=bind,src=${generated},dst=/generated`, '--workdir', '/generated', '--entrypoint', 'bash', image!, '-c', [
        'python3 - <<"PY"',
        'import docx, openpyxl, pptx',
        'document = docx.Document(); document.add_heading("季度经营报告", 1); document.add_paragraph("华东区收入同比增长 12%。"); document.save("report.docx")',
        'book = openpyxl.Workbook(); book.active.title = "营收"; book.active.append(["区域", "收入"]); book.active.append(["华东", 1200]); book.active.append(["合计", "=SUM(B2:B2)"]); book.save("revenue.xlsx")',
        'deck = pptx.Presentation(); slide = deck.slides.add_slide(deck.slide_layouts[1]); slide.shapes.title.text = "经营概览"; deck.save("overview.pptx")',
        'PY',
        'soffice --headless --convert-to pdf report.docx > /dev/null 2>&1',
      ].join('\n'),
    ], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(make.status, 0, make.stderr)

    // Feature detection only: preflight would also sweep every platform container on this daemon.
    const extractionBackend = new DockerExecutionBackend()
    await extractionBackend.detectFeatures()
    const executor = new ContainerExecutor(extractionBackend, { pythonImage: image!, maxContainers: 1 })
    const extractor = new ContainerArtifactTextExtractor(executor, {
      user, scriptRoot: join(projectRoot, 'server/config/execution'), workRoot: join(root, 'work'),
    })
    const read = (name: string) => readFile(join(generated, name))
    const results = await extractor.extract([
      { name: '季度报告.docx', type: 'docx', bytes: await read('report.docx') },
      { name: '营收.xlsx', type: 'xlsx', bytes: await read('revenue.xlsx') },
      { name: '概览.pptx', type: 'pptx', bytes: await read('overview.pptx') },
      { name: '报告.pdf', type: 'pdf', bytes: await read('report.pdf') },
      { name: '损坏.pdf', type: 'pdf', bytes: Buffer.from('%PDF-1.7 broken') },
    ])
    const texts = results.map(result => result.ok ? result.text : `failed:${result.code}`)
    assert.match(texts[0]!, /季度经营报告\n华东区收入同比增长 12%。/)
    assert.match(texts[1]!, /^# XLSX 文件摘要\n工作表：1；数据行：3/)
    assert.match(texts[1]!, /## 营收\n区域\t收入\n华东\t1200\n合计\t=SUM\(B2:B2\)/, 'a formula without a cached value shows the formula')
    assert.match(texts[2]!, /## 第 1 页\n经营概览/)
    assert.match(texts[3]!, /季度经营报告/)
    assert.equal(results[3]?.ok && results[3].pageCount, 1)
    assert.equal(texts[4], 'failed:PDF_UNREADABLE')
    assert.deepEqual(await readdir(join(root, 'work')), [], 'per-call directories are removed')
    executor.close()
    assert.equal(executor.containersInUse, 0, 'the extraction container was removed')
    assert.deepEqual(executor.pendingRemovals, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('1b②: a Skill script runs inside the Attempt container and finds its paths through the environment', { skip: extractionSkip, timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-container-e2e-'))
  const workspace = join(root, 'workspace')
  const backend = new DockerExecutionBackend()
  await backend.detectFeatures()
  const containers = new AttemptExecutionContainers(backend, {
    image: image!, user: resolveExecutionContainerUser(),
    usage: { measure: dir => measureWorkspace(dir), freeSpace: async () => ({ freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER, low: false }) },
  })
  try {
    // The Adapter materializes an activated Skill under workspace/skills/<id>; the platform mounts inputs read-only.
    const skillDir = skillDirectory(workspace, 'skill-report')
    await mkdir(join(skillDir, 'scripts'), { recursive: true })
    await writeFile(join(skillDir, 'scripts', 'build.py'), [
      'import csv, os, sys',
      'rows = list(csv.reader(open(os.path.join(os.environ["DSH_INPUT_DIR"], "01-sales.csv.txt"), encoding="utf-8")))',
      'total = sum(int(row[1]) for row in rows[1:])',
      'open(os.path.join(os.environ["DSH_OUTPUT_DIR"], "汇总.md"), "w", encoding="utf-8").write(f"# 合计\\n{total}\\n")',
      'print(os.getcwd() == os.environ["DSH_SKILL_DIR"], sys.argv[1], total)',
    ].join('\n'), { mode: 0o400 })
    await mkdir(join(workspace, 'input'), { recursive: true })
    await writeFile(join(workspace, 'input', '01-sales.csv.txt'), '区域,收入\n华东,1200\n华南,800\n', { mode: 0o400 })
    const manifest = {
      attempt_id: 'py-e2e-attempt',
      agent_configuration: { skill_instructions: [{ id: 'skill-report', name: 'report', version: '1.0.0', files: [{ path: 'scripts/build.py', sha256: 'a'.repeat(64), size: 1 }] }] },
    } as unknown as RuntimeManifest
    const result = await new ExecutionContainerPythonRunner(containers)
      .execute({ skill: 'report', entry: 'scripts/build.py', args: ['华东'] }, manifest, workspace, new AbortController().signal)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'True 华东 2000', 'cwd is the Skill directory; args and inputs arrive')
    assert.deepEqual(result.artifacts.map(file => file.name), ['汇总.md'])
    assert.equal(await readFile(join(workspace, 'output', '汇总.md'), 'utf8'), '# 合计\n2000\n')
    // The fixed sandbox mounts of the per-call mode do not exist here.
    const fixed = await containers.exec('py-e2e-attempt', workspace, {
      argv: ['bash', '-c', 'test -e /skill || test -e /input || test -e /output && echo PRESENT || echo ABSENT'],
      cwd: workspace, maxOutputBytes: 1024, timeoutMs: 10_000, mayLeaveProcesses: true,
    }, new AbortController().signal)
    assert.equal(fixed.stdout.trim(), 'ABSENT')
  } finally {
    await containers.release('py-e2e-attempt').catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
