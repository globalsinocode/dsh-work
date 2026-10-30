import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cjkFonts, fileKind, findAttemptDirectory, parseArgs, parseSse, PROMPTS, summaryMarkdown, toolCalls } from './c-tier-p2.mjs'

test('requires a target, an environment label and exactly one way to sign in', () => {
  assert.throws(() => parseArgs(['--environment', 'x', '--cookie-file', 'c']), /--base/)
  assert.throws(() => parseArgs(['--base', 'https://h:4174', '--cookie-file', 'c']), /--environment/)
  assert.throws(() => parseArgs(['--base', 'https://h:4174', '--environment', 'x']), /二选一/)
  assert.throws(() => parseArgs(['--base', 'https://h:4174', '--environment', 'x', '--cookie-file', 'c', '--login-file', 'l']), /二选一/)
  assert.throws(() => parseArgs(['--base', 'h', '--environment', 'x', '--cookie-file', 'c', '--bogus']), /未知参数/)
  const options = parseArgs(['--base', 'https://h:4174/', '--environment', 'mac-mini', '--cookie-file', 'c', '--scenarios', 'health, office-xlsx'])
  assert.equal(options.base, 'https://h:4174')
  assert.equal(options.origin, 'https://h:4174')
  assert.deepEqual(options.scenarios, ['health', 'office-xlsx'])
})

test('reads Run events from SSE and keeps the final status of each tool call', () => {
  const body = [
    ': keep-alive', '',
    'id: 1', `data: ${JSON.stringify({ event_type: 'tool.started', sequence: 1, safe_metadata: { tool_name: 'bash', call_id: 'a', status: 'running' } })}`, '',
    `data: ${JSON.stringify({ event_type: 'tool.completed', sequence: 2, safe_metadata: { tool_name: 'bash', call_id: 'a', status: 'succeeded', error_code: null } })}`, '',
    `data: ${JSON.stringify({ event_type: 'run.completed', sequence: 3, safe_metadata: {} })}`, '', '',
  ].join('\n')
  const events = parseSse(body)
  assert.equal(events.length, 3)
  assert.deepEqual(toolCalls(events), [{ name: 'bash', status: 'succeeded', errorCode: null }])
})

test('accepts only the Simplified Chinese CJK face in pdffonts output', () => {
  const header = 'name                                 type              encoding         emb sub uni object ID\n------------------------------------ ----------------- ---------------- --- --- --- ---------\n'
  assert.equal(cjkFonts(`${header}BAAAAA+NotoSansCJKsc-Regular  CID TrueType  Identity-H  yes yes yes 10 0\nCAAAAA+LiberationSans  TrueType  WinAnsi  yes yes yes 12 0\n`).allSc, true)
  assert.equal(cjkFonts(`${header}BAAAAA+NotoSansCJKhk-Regular  CID TrueType  Identity-H  yes yes yes 10 0\n`).allSc, false)
  assert.equal(cjkFonts(`${header}CAAAAA+LiberationSans  TrueType  WinAnsi  yes yes yes 12 0\n`).allSc, false)
})

test('recognises downloaded PDF and Office (ZIP) files by their bytes', () => {
  assert.equal(fileKind(Buffer.from('%PDF-1.7\n')), 'pdf')
  assert.equal(fileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])), 'zip')
  assert.equal(fileKind(Buffer.from('<html>')), 'unknown')
})

test('prompts ask for files in output/ and conversion with soffice', () => {
  for (const prompt of [PROMPTS.xlsx, PROMPTS.docx]) {
    assert.match(prompt, /output\//)
    assert.match(prompt, /soffice --headless --convert-to pdf/)
  }
  assert.match(PROMPTS.bashLimits, /run_in_background/)
})

test('summary lists checks, review notes and Runs per scenario', () => {
  const text = summaryMarkdown({
    environment: 'local-rehearsal', base: 'http://localhost', codeRevision: 'abc', image: '', executedAt: 't0', finishedAt: 't1',
    scenarios: [{ id: 'health', title: '健康', status: 'needs-review', checks: [{ name: '可用', ok: true, detail: '' }], notes: ['看日志'], runs: [] }],
  })
  assert.match(text, /local-rehearsal/)
  assert.match(text, /✅ 可用/)
  assert.match(text, /👀 看日志/)
})

test('finds Attempt directories by id under hashed tenant, Run and Attempt names', t => {
  const root = mkdtempSync(join(tmpdir(), 'c-tier-attempts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const attempt = join(root, 'tenant-a-1f2e', 'run-1-ab12', 'attempt-9-cd34')
  mkdirSync(attempt, { recursive: true })
  mkdirSync(join(root, 'tenant-a-1f2e', 'run-10-ef56', 'attempt-9-cd34'), { recursive: true })
  mkdirSync(join(root, 'mcp-inspection-x'))
  assert.equal(findAttemptDirectory(root, 'run-1', 'attempt-9'), attempt)
  assert.equal(findAttemptDirectory(root, 'run-2', 'attempt-9'), null)
})
