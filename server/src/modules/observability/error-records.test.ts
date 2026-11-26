import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import {
  ClientErrorReportInvalid,
  clientAddress,
  clientSummary,
  parseClientErrorBatch,
} from './client-error-report.ts'
import { maskPersonalData, maskQuotedText, normalizeForFingerprint, sanitizeErrorMessage, sanitizeStack } from './error-sanitize.ts'
import { FixedWindowLimiter } from './fixed-window-limiter.ts'
import { installProcessFailureHandlers, serverFailureRecord } from './server-failure-records.ts'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSourceMapStackResolver, decodeSourceMap, originalPosition } from './source-map-resolver.ts'

const traceId = 'trace-http-7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a'

test('message sanitizing keeps one line and masks secrets, personal data and URLs', () => {
  const message = sanitizeErrorMessage('请求失败 13800138000 token=abc123 https://example.com/a?q=客户名单\n第二行 secret')
  assert.ok(!message.includes('13800138000'))
  assert.ok(!message.includes('abc123'))
  assert.ok(!message.includes('example.com'))
  assert.ok(!message.includes('第二行'))
  assert.match(message, /\[个人信息\]/)
  assert.equal(sanitizeErrorMessage(''), '未提供错误消息')
  assert.equal(maskPersonalData('没有敏感值'), '没有敏感值')
})

test('stack sanitizing keeps only frame positions and drops everything else', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined (reading \'phone 13800138000\')',
    '    at renderArtifacts (https://work.example.com/assets/ArtifactList-3f2a9c.js?v=1:1:4821)',
    '    at async https://work.example.com/assets/index-9a01bc.js:2:17',
    'some injected line with password=hunter2',
    'loadPage@https://work.example.com/assets/ProjectSpaceView-1d4b0e.js:1:99',
  ].join('\n')
  const result = sanitizeStack(stack)!
  assert.equal(result.split('\n').length, 3)
  assert.match(result, /at renderArtifacts \(ArtifactList-3f2a9c\.js:1:4821\)/)
  assert.match(result, /at loadPage \(ProjectSpaceView-1d4b0e\.js:1:99\)/)
  assert.ok(!result.includes('example.com'))
  assert.ok(!result.includes('13800138000'))
  assert.ok(!result.includes('hunter2'))
  assert.equal(sanitizeStack('no frames here'), null)
})

test('fingerprint normalization ignores ids, numbers and quoted values', () => {
  assert.equal(
    normalizeForFingerprint("Cannot load 'run-1' 42 7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a"),
    normalizeForFingerprint("Cannot load 'run-2' 43 11111111-2222-3333-4444-555555555555"),
  )
})

test('client batches are strictly validated', () => {
  const ok = parseClientErrorBatch({ app: 'workbench', reports: [
    { kind: 'render', message: 'boom 13800138000', stack: '    at a (https://x/assets/a-123456.js:1:2)', route: 'conversation', release: '2026.11.26-01', count: 3 },
    { kind: 'api', message: '接口失败', code: 'operation_failed', traceId, route: 'conversation' },
    { kind: 'notice', code: 'forbidden', template: 'project.open', route: 'project-space' },
  ] })
  assert.equal(ok.reports.length, 3)
  assert.equal(ok.reports[0]!.count, 3)
  assert.ok(!ok.reports[0]!.message.includes('13800138000'))
  assert.equal(ok.reports[1]!.traceId, traceId)
  assert.equal(ok.reports[2]!.message, '失败提示 project.open（forbidden）')
  assert.equal(ok.reports[2]!.stack, null)

  const invalid = [
    null, [], { app: 'other', reports: [{ kind: 'render' }] },
    { app: 'workbench', reports: [] },
    { app: 'workbench', reports: [{ kind: 'render' }], extra: 1 },
    { app: 'workbench', reports: [{ kind: 'render', body: 'x' }] },
    { app: 'workbench', reports: [{ kind: 'http' }] },
    { app: 'workbench', reports: [{ kind: 'render', traceId: 'trace-http-not-a-uuid' }] },
    { app: 'workbench', reports: [{ kind: 'render', route: 'https://evil/?q=1' }] },
    { app: 'workbench', reports: [{ kind: 'render', count: 0 }] },
    { app: 'workbench', reports: [{ kind: 'notice', code: 'forbidden', message: '原文：张三的合同' }] },
    { app: 'workbench', reports: [{ kind: 'notice' }] },
    { app: 'workbench', reports: Array.from({ length: 21 }, () => ({ kind: 'render' })) },
  ]
  for (const body of invalid) assert.throws(() => parseClientErrorBatch(body), ClientErrorReportInvalid)
})

test('same problem on another build hash shares a fingerprint; different problems do not', () => {
  const a = parseClientErrorBatch({ app: 'workbench', reports: [{ kind: 'render', message: "Cannot read 'x'", stack: '    at f (https://h/assets/index-aaaaaaaa.js:1:5)' }] })
  const b = parseClientErrorBatch({ app: 'workbench', reports: [{ kind: 'render', message: "Cannot read 'y'", stack: '    at f (https://h/assets/index-bbbbbbbb.js:1:9)' }] })
  const c = parseClientErrorBatch({ app: 'admin', reports: [{ kind: 'render', message: "Cannot read 'x'", stack: '    at f (https://h/assets/index-aaaaaaaa.js:1:5)' }] })
  assert.equal(a.reports[0]!.fingerprint, b.reports[0]!.fingerprint)
  assert.notEqual(a.reports[0]!.fingerprint, c.reports[0]!.fingerprint)
})

test('client summary and address', () => {
  assert.equal(clientSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit DingTalk/7.5'), '钉钉 iOS')
  assert.equal(clientSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'), 'Chrome 131 / macOS')
  assert.equal(clientSummary(undefined), null)
  const request = (remote: string, realIp?: string) => ({
    socket: { remoteAddress: remote }, headers: realIp ? { 'x-real-ip': realIp, 'x-forwarded-for': '9.9.9.9' } : { 'x-forwarded-for': '9.9.9.9' },
  }) as never
  assert.equal(clientAddress(request('127.0.0.1', '10.1.2.3')), '10.1.2.3')
  assert.equal(clientAddress(request('10.0.0.8', '10.1.2.3')), '10.0.0.8')
  assert.equal(clientAddress(request('::1')), '::1')
})

test('fixed window limiter grants partial batches and resets', () => {
  let now = 0
  const limiter = new FixedWindowLimiter({ limit: 10, windowMs: 1_000, now: () => now })
  assert.equal(limiter.take('a', 6), 6)
  assert.equal(limiter.take('a', 6), 4)
  assert.equal(limiter.take('a', 1), 0)
  assert.equal(limiter.take('b', 1), 1)
  now = 1_000
  assert.equal(limiter.take('a', 3), 3)
  const small = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, maxKeys: 1, now: () => now })
  assert.equal(small.take('x'), 1)
  assert.equal(small.take('y'), 0)
})

test('server failures group by route template and code, and carry the run id from route params', () => {
  const failure = { traceId, method: 'GET', routePath: '/api/workbench/v1/runs/:runId/events', status: 500, code: 'operation_failed',
    errorMessage: 'connect failed password=abc', params: { runId: 'run-123' }, userId: 'U00001' }
  const first = serverFailureRecord(failure, '2026.11.26-01')
  const second = serverFailureRecord({ ...failure, traceId: 'trace-http-other', params: { runId: 'run-456' }, errorMessage: 'other' }, null)
  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(first.runId, 'run-123')
  assert.equal(first.route, 'GET /api/workbench/v1/runs/:runId/events')
  assert.ok(!first.message.includes('abc'))
  assert.equal(serverFailureRecord({ ...failure, params: {} }, null).runId, null)
})

test('process failure handlers record once and then exit even when recording hangs', async () => {
  const target = new EventEmitter()
  const exits: number[] = []
  const recorded: string[] = []
  const errors = console.error
  console.error = () => undefined
  try {
    installProcessFailureHandlers({
      target, timeoutMs: 20, release: null, exit: code => { exits.push(code) },
      record: async input => { recorded.push(input.message); await new Promise(() => undefined) },
    })
    target.emit('uncaughtException', new Error('boom token=secret-value'))
    target.emit('unhandledRejection', new Error('second'))
    await new Promise(resolve => setTimeout(resolve, 60))
  } finally {
    console.error = errors
  }
  assert.deepEqual(exits, [1])
  assert.equal(recorded.length, 1)
  assert.ok(!recorded[0]!.includes('secret-value'))
})

test('source maps resolve minified positions', () => {
  // 生成 1:0 → src/a.ts 第 3 行第 5 列（名称 load）；生成 1:10 → src/b.ts 第 1 行第 1 列。
  const map = JSON.stringify({ version: 3, sources: ['../src/a.ts', '../src/b.ts'], names: ['load'], mappings: 'AAEIA,UCFJ' })
  const decoded = decodeSourceMap(map)
  assert.deepEqual(originalPosition(decoded, 1, 1), { source: 'src/a.ts', line: 3, column: 5, name: 'load' })
  assert.equal(originalPosition(decoded, 1, 12)?.source, 'src/b.ts')
  assert.equal(originalPosition(decoded, 2, 1), null)
  assert.throws(() => decodeSourceMap('{"version":2}'))
})

test('quoted business text is masked; plain identifiers are kept', () => {
  assert.equal(maskQuotedText('名称“张三的合同”已存在'), '名称“[内容]”已存在')
  assert.equal(maskQuotedText("Cannot read properties of undefined (reading 'artifacts')"), "Cannot read properties of undefined (reading 'artifacts')")
  assert.equal(maskQuotedText('文件 "季度 报表.xlsx" 解析失败'), '文件 "[内容]" 解析失败')
  assert.equal(sanitizeErrorMessage('项目「华东大客户」无权查看'), '项目「[内容]」无权查看')
})

test('source map lookups never leave the source map directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-maps-'))
  const outside = path.join(root, 'outside')
  await mkdir(path.join(root, 'maps', 'v1'), { recursive: true })
  await mkdir(outside, { recursive: true })
  const map = JSON.stringify({ version: 3, sources: ['../src/secret.ts'], names: [], mappings: 'AAAA' })
  await writeFile(path.join(outside, 'a.js.map'), map)
  await writeFile(path.join(root, 'maps', 'v1', 'a.js.map'), map)
  const resolve = createSourceMapStackResolver(path.join(root, 'maps'))
  const stack = '  at f (a.js:1:1)'
  assert.equal((await resolve(stack, '..')).resolved, false)
  assert.equal((await resolve(stack, '../outside')).resolved, false)
  assert.equal((await resolve(stack, 'v1..')).resolved, false)
  assert.equal((await resolve(stack, 'v1')).resolved, true)
})
