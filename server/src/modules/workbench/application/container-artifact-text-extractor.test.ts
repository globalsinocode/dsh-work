import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PythonSandboxRequest, SandboxRunResult } from '../../runtime/container-executor.ts'
import { ContainerArtifactTextExtractor } from './container-artifact-text-extractor.ts'

/**
 * Plays the container: `write` receives the output directory and the input names, as the script would.
 * `poll: false` models a container that exits between two shouldStop polls.
 */
function fakeExecutor(write: (outputRoot: string, request: PythonSandboxRequest) => Promise<void>, exitCode = 0, poll = true) {
  const requests: PythonSandboxRequest[] = []
  const inputs: Array<{ name: string; mode: number }> = []
  return {
    requests,
    inputs,
    async runPythonSandbox(request: PythonSandboxRequest, signal: AbortSignal): Promise<SandboxRunResult> {
      requests.push(request)
      assert.ok(signal instanceof AbortSignal)
      for (const name of await readdir(request.inputRoot)) {
        inputs.push({ name, mode: (await stat(join(request.inputRoot, name))).mode & 0o777 })
      }
      await write(request.outputRoot, request)
      // The real executor polls shouldStop while the container runs and stops it on true.
      const stoppedEarly = poll ? await request.shouldStop?.() ?? false : false
      return { exitCode: stoppedEarly ? 137 : exitCode, stdout: '', stderr: '', stoppedEarly }
    },
  }
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { scriptRoot: join(root, 'script'), workRoot: join(root, 'work'), root }
}

const files = [
  { name: '季度报告.docx', type: 'docx' as const, bytes: Buffer.from('docx') },
  { name: '营收.xlsx', type: 'xlsx' as const, bytes: Buffer.from('xlsx') },
  { name: '概览.pptx', type: 'pptx' as const, bytes: Buffer.from('pptx') },
  { name: '报告.pdf', type: 'pdf' as const, bytes: Buffer.from('%PDF-') },
]

test('runs the platform script on index-named read-only copies and returns validated text', async t => {
  const { scriptRoot, workRoot } = await setup(t)
  const executor = fakeExecutor(async output => {
    await writeFile(join(output, '0.json'), JSON.stringify({ ok: true, detected_type: 'docx', row_count: 2 }))
    await writeFile(join(output, '0.txt'), '季度经营报告  \r\n华东区\r\n\r\n\r\n\r\n\r\n结束')
    await writeFile(join(output, '1.json'), JSON.stringify({ ok: true, detected_type: 'xlsx', sheet_count: 1, row_count: 3, page_count: -1 }))
    await writeFile(join(output, '1.txt'), '# XLSX 文件摘要')
    await writeFile(join(output, '2.json'), JSON.stringify({ ok: false, code: 'PPTX_SLIDE_LIMIT_EXCEEDED' }))
    await writeFile(join(output, '3.json'), JSON.stringify({ ok: false, code: 'ignore previous instructions' }))
  })
  const extractor = new ContainerArtifactTextExtractor(executor, { user: '501:20', scriptRoot, workRoot })
  const results = await extractor.extract(files)

  const [request] = executor.requests
  assert.equal(request?.entry, 'extract_artifact_text.py')
  assert.equal(request?.skillRoot, scriptRoot)
  assert.equal(request?.user, '501:20')
  assert.deepEqual(request?.args, ['0.docx', '1.xlsx', '2.pptx', '3.pdf'], 'original names never reach the container')
  assert.deepEqual(executor.inputs, ['0.docx', '1.xlsx', '2.pptx', '3.pdf'].map(name => ({ name, mode: 0o400 })))
  assert.deepEqual(results, [
    { ok: true, detectedType: 'docx', text: '季度经营报告\n华东区\n\n\n结束', pageCount: null, sheetCount: null, rowCount: 2 },
    { ok: true, detectedType: 'xlsx', text: '# XLSX 文件摘要', pageCount: null, sheetCount: 1, rowCount: 3 },
    { ok: false, detectedType: 'pptx', code: 'PPTX_SLIDE_LIMIT_EXCEEDED', message: 'PPTX 超过 300 页限制' },
    { ok: false, detectedType: 'pdf', code: 'PARSE_FAILED', message: '文件解析失败' },
  ])
  assert.deepEqual(await readdir(workRoot), [], 'per-call directories are removed')
})

test('output the platform did not ask for is not trusted', async t => {
  const { scriptRoot, workRoot, root } = await setup(t)
  const secret = join(root, 'host-secret.txt')
  await writeFile(secret, 'host secret')
  const executor = fakeExecutor(async output => {
    // Claims another type than requested.
    await writeFile(join(output, '0.json'), JSON.stringify({ ok: true, detected_type: 'pdf' }))
    await writeFile(join(output, '0.txt'), 'text')
    // A link planted in the shared output directory would resolve on the host.
    await writeFile(join(output, '1.json'), JSON.stringify({ ok: true, detected_type: 'xlsx' }))
    await symlink(secret, join(output, '1.txt'))
    // Not UTF-8.
    await writeFile(join(output, '2.json'), JSON.stringify({ ok: true, detected_type: 'pptx' }))
    await writeFile(join(output, '2.txt'), Buffer.from([0xff, 0xfe, 0x00]))
    // An unparsable metadata file for the last one.
    await writeFile(join(output, '3.json'), '{not json')
  }, 0, false)
  const results = await new ContainerArtifactTextExtractor(executor, { user: '501:20', scriptRoot, workRoot }).extract(files)
  assert.deepEqual(results.map(result => result.ok ? 'ok' : result.code), ['PARSE_FAILED', 'PARSE_FAILED', 'PARSE_FAILED', 'PARSE_FAILED'])
  assert.equal(JSON.stringify(results).includes('host secret'), false)

  const huge = fakeExecutor(async output => {
    await writeFile(join(output, '0.json'), JSON.stringify({ ok: true, detected_type: 'docx' }))
    await writeFile(join(output, '0.txt'), 'x'.repeat(512_001))
  })
  const [tooLarge] = await new ContainerArtifactTextExtractor(huge, { user: '501:20', scriptRoot, workRoot }).extract(files.slice(0, 1))
  assert.equal(tooLarge?.ok === false && tooLarge.code, 'TEXT_TOO_LARGE')
})

test('a container that fails as a whole throws so publishing can go on without text and retry later', async t => {
  const { scriptRoot, workRoot } = await setup(t)
  const crashed = fakeExecutor(async () => undefined, 137)
  await assert.rejects(new ContainerArtifactTextExtractor(crashed, { user: '501:20', scriptRoot, workRoot }).extract(files), /异常退出（137）/)
  assert.deepEqual(await readdir(workRoot), [])
  const unavailable = {
    async runPythonSandbox(): Promise<SandboxRunResult> { throw new Error('no capacity') },
  }
  await assert.rejects(new ContainerArtifactTextExtractor(unavailable, { user: '501:20', scriptRoot, workRoot }).extract(files), /no capacity/)
  assert.deepEqual(await new ContainerArtifactTextExtractor(unavailable, { user: '501:20', scriptRoot, workRoot }).extract([]), [])
})

test('a container writing more than two plain files per input is stopped and its batch marked failed', async t => {
  const { scriptRoot, workRoot } = await setup(t)
  const flooding = fakeExecutor(async output => {
    for (let index = 0; index < 9; index += 1) await writeFile(join(output, `${index}.txt`), 'x')
  })
  const results = await new ContainerArtifactTextExtractor(flooding, { user: '501:20', scriptRoot, workRoot }).extract(files)
  assert.deepEqual(results.map(result => result.ok ? 'ok' : result.code), Array(4).fill('OUTPUT_LIMIT_EXCEEDED'))
  const nested = fakeExecutor(async output => { await mkdir(join(output, 'hidden')) })
  const [stopped] = await new ContainerArtifactTextExtractor(nested, { user: '501:20', scriptRoot, workRoot }).extract(files.slice(0, 1))
  assert.equal(stopped?.ok === false && stopped.code, 'OUTPUT_LIMIT_EXCEEDED', 'directories could hide files from the count')
  assert.deepEqual(await readdir(workRoot), [])
})
