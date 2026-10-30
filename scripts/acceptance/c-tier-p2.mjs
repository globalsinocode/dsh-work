#!/usr/bin/env node
// C 档 P2 验收（执行隔离方案第 9 节）：只经员工端公开接口驱动真实 DSH，逐场景留证。
// 不读写数据库，不代办 OIDC 登录；结论由验收人复核 evidence.json 后填写。
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
export const SCHEMA_VERSION = 'c-tier-p2-evidence/v1'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled'])

const SALES_ROWS = [['华东', '办公椅', 1200], ['华北', '文件柜', 860], ['西南', '白板', 430]]
export const PROMPTS = {
  xlsx: [
    '这是一次平台验收任务，请严格按要求完成：',
    '1. 用 Python（openpyxl）生成 output/华东销售.xlsx，工作表名“销售”，表头为“区域、产品、金额”，依次写入以下三行：',
    ...SALES_ROWS.map(row => `   ${row.join('，')}`),
    '   最后一行写“合计”，金额用 SUM 公式。',
    '2. 用 soffice --headless --convert-to pdf 把它转换为 output/华东销售.pdf。',
    '3. 中间文件不要放在 output/。完成后用一两句话说明结果。',
  ].join('\n'),
  revise: '在刚才的表格中、合计行之前加一行：华南，投影仪，2100。合计公式相应调整，文件名不变，并重新生成同名 PDF。',
  docx: [
    '这是一次平台验收任务，请严格按要求完成：',
    '1. 用 Python（python-docx）生成 output/季度质量报告.docx：一级标题“季度质量报告”，正文一段“本季度一次合格率为 98.6%，较上季度提升 0.4 个百分点。”，再加一个两列表格（指标、数值），写入“一次合格率，98.6%”和“客诉数量，3”。',
    '2. 用 soffice --headless --convert-to pdf 把它转换为 output/季度质量报告.pdf。',
    '3. 中间文件不要放在 output/。完成后用一两句话说明结果。',
  ].join('\n'),
  bashLimits: [
    '这是一次平台验收任务，请依次：',
    '1. 调用 bash 工具运行 `echo c-tier-ok`，并把参数 run_in_background 设为 true；如果该工具没有这个参数，请直接说明。',
    '2. 如果第 1 步不能后台运行，用前台方式再运行同一条命令。',
    '3. 最后说明：第 1 步的结果是什么；你可用的工具中是否有名称以 job_ 开头的工具。',
  ].join('\n'),
  pythonSkill: '这是一次平台验收任务：请运行当前 Skill 登记的脚本完成一次示例任务，把结果写入输出目录，并说明生成了哪些文件。',
}

export function parseArgs(argv) {
  const options = { scenarios: null, timeoutSeconds: 900 }
  const names = {
    '--base': 'base', '--origin': 'origin', '--cookie-file': 'cookieFile', '--login-file': 'loginFile',
    '--health-url': 'healthUrl', '--image': 'image', '--data-root': 'dataRoot', '--python-skill': 'pythonSkill',
    '--agent': 'agent', '--out': 'out', '--environment': 'environment', '--revision': 'revision',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--scenarios') options.scenarios = argv[++index]?.split(',').map(item => item.trim()).filter(Boolean)
    else if (flag === '--timeout') options.timeoutSeconds = Number(argv[++index])
    else if (names[flag]) options[names[flag]] = argv[++index]
    else throw new Error(`未知参数：${flag}`)
  }
  if (!options.base) throw new Error('缺少 --base（员工端地址，如 https://<IP>:4174）')
  if (!options.environment) throw new Error('缺少 --environment（如 mac-mini-production、local-rehearsal）')
  if (!options.cookieFile === !options.loginFile) throw new Error('--cookie-file 与 --login-file 二选一')
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 60) throw new Error('--timeout 至少 60 秒')
  options.base = options.base.replace(/\/+$/, '')
  options.origin = (options.origin ?? options.base).replace(/\/+$/, '')
  return options
}

/** Parses an SSE body into the JSON payloads of its `data:` lines. */
export function parseSse(text) {
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    try { events.push(JSON.parse(data)) } catch { /* keep-alive or non-JSON line */ }
  }
  return events
}

/** Tool calls seen in Run events, by name with their final status. */
export function toolCalls(events) {
  const calls = new Map()
  for (const event of events) {
    const meta = event?.safe_metadata ?? {}
    if (!String(event?.event_type).startsWith('tool.') || !meta.tool_name) continue
    const key = meta.call_id ?? `${meta.tool_name}:${event.sequence}`
    calls.set(key, { name: meta.tool_name, status: meta.status ?? calls.get(key)?.status ?? null, errorCode: meta.error_code ?? null })
  }
  return [...calls.values()]
}

/** Font names in `pdffonts` output that are CJK, and whether all of them are the Simplified Chinese face. */
export function cjkFonts(pdffontsOutput) {
  const fonts = pdffontsOutput.split('\n').slice(2).map(line => line.trim().split(/\s+/)[0]).filter(Boolean)
  const cjk = fonts.filter(name => /CJK|SourceHan/i.test(name))
  return { fonts, cjk, allSc: cjk.length > 0 && cjk.every(name => /CJK-?sc\b|CJKsc|Han(Sans|Serif)SC/i.test(name)) }
}

export function fileKind(bytes) {
  if (bytes.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip'
  return 'unknown'
}

class Client {
  constructor(options) {
    this.base = options.base
    this.origin = options.origin
    this.api = `${options.base}/api/workbench/v1`
    this.cookies = new Map()
    if (options.cookieFile) {
      for (const pair of readFileSync(options.cookieFile, 'utf8').trim().replace(/^cookie:\s*/i, '').split(/;\s*/)) {
        const at = pair.indexOf('=')
        if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1))
      }
    }
  }

  headers(extra = {}) {
    return { Origin: this.origin, Referer: `${this.origin}/`, Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...extra }
  }

  remember(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1))
    }
  }

  /** Local-auth rehearsal only: deployments sign in through AI Hub, so they pass --cookie-file. */
  async login(file) {
    const { username, password } = JSON.parse(readFileSync(file, 'utf8'))
    const response = await fetch(`${this.base}/auth/workbench/login`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) throw new Error(`登录失败（${response.status}）`)
    this.remember(response)
  }

  async json(method, path, body) {
    const response = await fetch(`${this.api}${path}`, {
      method, headers: this.headers({ Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }),
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${payload?.error?.code ?? ''} ${payload?.error?.message ?? ''}`.trim())
    return payload?.data ?? payload
  }

  async bytes(path) {
    const response = await fetch(`${this.api}${path}`, { headers: this.headers({ Accept: 'application/octet-stream' }), signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  /** Replays the Run's safe events; the stream is read until a terminal event or the time limit. */
  async events(runId, limitMs = 20_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limitMs)
    let text = ''
    try {
      const response = await fetch(`${this.api}/runs/${encodeURIComponent(runId)}/events`, { headers: this.headers({ Accept: 'text/event-stream' }), signal: controller.signal })
      if (!response.ok) throw new Error(`GET /runs/${runId}/events -> ${response.status}`)
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true })
        if (parseSse(text).some(event => TERMINAL_EVENTS.has(event.event_type))) break
      }
    } catch (error) {
      if (error?.name !== 'AbortError') throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    return parseSse(text)
  }
}

class Scenario {
  constructor(id, title) {
    Object.assign(this, { id, title, status: 'passed', checks: [], runs: [], files: [], notes: [] })
  }

  check(name, ok, detail = '') {
    this.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 2000) })
    if (!ok) this.status = 'failed'
    return Boolean(ok)
  }

  review(note) {
    this.notes.push(note)
    if (this.status === 'passed') this.status = 'needs-review'
  }
}

async function runPrompt(client, options, scenario, sessionId, prompt, fileIds = []) {
  const started = await client.json('POST', `/sessions/${encodeURIComponent(sessionId)}/runs`, { prompt, idempotencyKey: randomUUID(), ...(fileIds.length ? { fileIds } : {}) })
  const runId = started.id
  const deadline = Date.now() + options.timeoutSeconds * 1000
  let run = started
  while (!TERMINAL.has(run.status) && Date.now() < deadline) {
    if (run.status === 'waiting') break
    await new Promise(done => setTimeout(done, 3000))
    run = await client.json('GET', `/runs/${encodeURIComponent(runId)}`)
  }
  const events = await client.events(runId)
  const record = {
    runId, sessionId, status: run.status,
    attemptIds: [...new Set(events.map(event => event.attempt_id).filter(Boolean))],
    tools: toolCalls(events),
    answer: events.filter(event => event.event_type === 'assistant.completed').map(event => event.display_message).join('\n').slice(0, 4000),
    failure: events.find(event => event.event_type === 'run.failed')?.display_message ?? null,
  }
  scenario.runs.push(record)
  scenario.check(`Run ${runId} 成功结束`, run.status === 'succeeded', `状态 ${run.status}${record.failure ? `：${record.failure}` : ''}`)
  return record
}

async function newSession(client, options, title, extra = {}) {
  const session = await client.json('POST', '/sessions', { title, ...(options.agent ? { agentId: options.agent } : {}), ...extra })
  return session.id
}

/** The Run's artifacts as the conversation shows them, with the file reference that “继续修改” attaches. */
async function runArtifacts(client, runId) {
  return (await client.json('GET', `/runs/${encodeURIComponent(runId)}/result`)).artifacts ?? []
}

/** Downloads the Run's artifacts of the given types, checks magic bytes and the server's extracted text. */
async function collectArtifacts(client, options, scenario, run, expected) {
  const artifacts = await runArtifacts(client, run.runId)
  const found = {}
  for (const [type, keywords] of Object.entries(expected)) {
    const artifact = artifacts.find(item => item.type === type)
    if (!scenario.check(`登记 ${type} 成果`, artifact, artifacts.map(item => `${item.name}(${item.type})`).join('、') || '无成果')) continue
    const bytes = await client.bytes(`/artifacts/${encodeURIComponent(artifact.id)}/versions/${artifact.version}/download`)
    const saved = join(options.out, 'files', `${scenario.id}-v${artifact.version}-${artifact.name}`)
    writeFileSync(saved, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    scenario.files.push({ id: artifact.id, name: artifact.name, type, version: artifact.version, size: bytes.length, sha256, saved })
    scenario.check(`${artifact.name} 下载内容为 ${type}`, fileKind(bytes) === (type === 'pdf' ? 'pdf' : 'zip'), `${bytes.length} 字节，sha256 ${sha256}`)
    const preview = await waitForText(client, artifact)
    const text = preview.status === 'available' ? preview.text : ''
    scenario.check(`${artifact.name} 解析文本可预览`, preview.status === 'available', preview.status === 'failed' ? preview.message : preview.status)
    const missing = keywords.filter(keyword => !text.includes(keyword))
    scenario.check(`${artifact.name} 解析文本含中文内容`, text && !missing.length, missing.length ? `缺少：${missing.join('、')}` : keywords.join('、'))
    found[type] = { artifact, saved }
  }
  return found
}

async function waitForText(client, artifact) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const preview = await client.json('GET', `/artifacts/${encodeURIComponent(artifact.id)}/versions/${artifact.version}/text`)
    if (preview.status !== 'pending') return preview
    await new Promise(done => setTimeout(done, 3000))
  }
  return { status: 'pending' }
}

/** Fonts are read inside the execution image, so the host needs no poppler. */
function checkPdfFonts(options, scenario, saved) {
  if (!options.image) return scenario.review('未提供 --image：PDF 中文字体需人工打开核对（应为 Noto Sans CJK SC）')
  const directory = resolve(saved, '..')
  const name = saved.slice(directory.length + 1)
  try {
    const output = execFileSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '-v', `${directory}:/in:ro`, '--entrypoint', 'pdffonts', options.image, `/in/${name}`], { encoding: 'utf8', timeout: 60_000 })
    const fonts = cjkFonts(output)
    scenario.check(`${name} 中文字体为 Noto Sans CJK SC`, fonts.allSc, fonts.cjk.join('、') || `未见 CJK 字体：${fonts.fonts.join('、')}`)
  } catch (error) {
    scenario.check(`${name} 字体检查可执行`, false, error.message)
  }
}

/** fetch() refuses port 4190 (a WHATWG "bad port"), where the service's loopback health check listens. */
function getJson(url) {
  return new Promise((resolveResponse, reject) => {
    const request = (url.startsWith('https:') ? httpsGet : httpGet)(url, { timeout: 30_000 }, response => {
      let text = ''
      response.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => {
        let body = null
        try { body = JSON.parse(text) } catch { /* reported through the status check */ }
        resolveResponse({ status: response.statusCode, body })
      })
    })
    request.on('timeout', () => request.destroy(new Error(`${url} 超时`))).on('error', reject)
  })
}

function usedBash(scenario, run) {
  const bash = run.tools.filter(tool => tool.name === 'bash')
  scenario.check('经 bash 在执行容器中运行', bash.length > 0, run.tools.map(tool => tool.name).join('、') || '无工具调用')
  scenario.check('未出现 job_* 工具', !run.tools.some(tool => tool.name.startsWith('job_')))
}

const SCENARIOS = {
  async health(client, options, scenario) {
    if (!options.healthUrl) return scenario.review('未提供 --health-url：在部署机执行 curl http://127.0.0.1:4190/health 并人工核对')
    const response = await getJson(options.healthUrl)
    const body = response.body ?? {}
    const container = (body.data ?? body).executionCapabilities?.executionContainer
    writeFileSync(join(options.out, 'health.json'), `${JSON.stringify(body, null, 2)}\n`)
    scenario.check('健康检查可读', response.status === 200, response.status)
    scenario.check('执行容器可用', container?.status === 'available', JSON.stringify(container ?? null))
    scenario.check('数据卷剩余空间充足（无 diskLow）', container && !container.diskLow, JSON.stringify(container ?? null))
    scenario.review('在服务日志中核对 “execution container toolchain:” 一行（bash、rg、soffice、pdftoppm、python3 及版本）')
  },

  async 'office-xlsx'(client, options, scenario, state) {
    const sessionId = await newSession(client, options, 'C 档 P2：表格与 PDF')
    const run = await runPrompt(client, options, scenario, sessionId, PROMPTS.xlsx)
    usedBash(scenario, run)
    const found = await collectArtifacts(client, options, scenario, run, { xlsx: ['华东', '办公椅', '西南'], pdf: ['华东', '办公椅'] })
    if (found.pdf) checkPdfFonts(options, scenario, found.pdf.saved)
    if (found.xlsx) state.sheet = { sessionId, artifact: found.xlsx.artifact }
  },

  async 'office-revise'(client, options, scenario, state) {
    if (!state.sheet) return Object.assign(scenario, { status: 'skipped' }).notes.push('office-xlsx 未产出表格，跳过')
    // 与员工端“继续修改”相同：把上一轮的表格成果作为引用附在本轮消息上。
    const { fileId, canReference } = state.sheet.artifact
    if (!scenario.check('上一轮表格可“继续修改”', fileId && canReference, `fileId ${fileId ?? '无'}，canReference ${canReference}`)) return
    const run = await runPrompt(client, options, scenario, state.sheet.sessionId, PROMPTS.revise, [fileId])
    const artifacts = await runArtifacts(client, run.runId)
    const sheet = artifacts.find(artifact => artifact.type === 'xlsx')
    scenario.check('同名表格登记为新版本', sheet && sheet.id === state.sheet.artifact.id && sheet.version > state.sheet.artifact.version,
      sheet ? `${sheet.name} V${sheet.version}（原 V${state.sheet.artifact.version}，${sheet.id === state.sheet.artifact.id ? '同一成果' : '不同成果'}）` : '无表格成果')
    const found = await collectArtifacts(client, options, scenario, run, { xlsx: ['华南', '投影仪', '华东'], pdf: ['华南'] })
    if (found.pdf) checkPdfFonts(options, scenario, found.pdf.saved)
  },

  async 'office-docx'(client, options, scenario) {
    const sessionId = await newSession(client, options, 'C 档 P2：文档与 PDF')
    const run = await runPrompt(client, options, scenario, sessionId, PROMPTS.docx)
    usedBash(scenario, run)
    const found = await collectArtifacts(client, options, scenario, run, { docx: ['季度质量报告', '98.6'], pdf: ['季度质量报告', '98.6'] })
    if (found.pdf) checkPdfFonts(options, scenario, found.pdf.saved)
  },

  async 'bash-limits'(client, options, scenario) {
    const sessionId = await newSession(client, options, 'C 档 P2：命令限制')
    const run = await runPrompt(client, options, scenario, sessionId, PROMPTS.bashLimits)
    usedBash(scenario, run)
    scenario.review('核对回答与工具结果：run_in_background 不可用或被拒绝；回答中不应列出 job_* 工具')
  },

  async 'python-skill'(client, options, scenario) {
    if (!options.pythonSkill) return Object.assign(scenario, { status: 'skipped' }).notes.push('未提供 --python-skill')
    const sessionId = await newSession(client, options, 'C 档 P2：Python Skill', { skillId: options.pythonSkill })
    const run = await runPrompt(client, options, scenario, sessionId, PROMPTS.pythonSkill)
    const python = run.tools.filter(tool => tool.name === 'python_execute')
    scenario.check('调用 python_execute 且成功', python.some(tool => tool.status === 'succeeded'), JSON.stringify(python))
    const artifacts = await runArtifacts(client, run.runId)
    scenario.check('脚本输出登记为成果', artifacts.length > 0, artifacts.map(item => item.name).join('、') || '无成果')
  },

  async 'workspace-retire'(client, options, scenario, state) {
    if (!options.dataRoot) return scenario.review('未提供 --data-root：在部署机核对 <数据根>/dsh-attempts 下本次 Attempt 的 attempt-end.json 与 workspace/ 已删除')
    const attemptsRoot = join(options.dataRoot, 'dsh-attempts')
    for (const run of state.runs) {
      for (const attemptId of run.attemptIds) {
        const directory = findAttemptDirectory(attemptsRoot, run.runId, attemptId)
        if (!scenario.check(`Attempt ${attemptId} 目录存在`, directory)) continue
        const end = existsSync(join(directory, 'attempt-end.json')) ? JSON.parse(readFileSync(join(directory, 'attempt-end.json'), 'utf8')) : null
        scenario.check(`Attempt ${attemptId} 已记录结束`, end, JSON.stringify(end))
        const kept = existsSync(join(directory, 'workspace'))
        scenario.check(`Attempt ${attemptId} 工作区按规则处理`, end?.status === 'failed' ? kept : !kept, `${end?.status ?? '未结束'}，工作区${kept ? '保留' : '已删除'}`)
      }
    }
  },
}

/** Attempt directories are `<tenant>-<hash>/<run id>-<hash>/<attempt id>-<hash>` under the runtime root. */
export function findAttemptDirectory(attemptsRoot, runId, attemptId) {
  const child = (parent, id) => readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && (entry.name === id || entry.name.startsWith(`${id}-`))).map(entry => join(parent, entry.name))
  for (const tenant of readdirSync(attemptsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const runDirectory of child(join(attemptsRoot, tenant.name), runId)) {
      const [attempt] = child(runDirectory, attemptId)
      if (attempt) return attempt
    }
  }
  return null
}

export const SCENARIO_TITLES = {
  health: '执行容器可用与磁盘告警', 'office-xlsx': '生成表格并转换为 PDF', 'office-revise': '继续修改得到 V2',
  'office-docx': '生成文档并转换为 PDF', 'bash-limits': '后台运行被拒绝、job_* 不可见', 'python-skill': 'Python Skill 在执行容器中运行',
  'workspace-retire': 'Attempt 结束后工作区回收',
}

function revision(options) {
  if (options.revision) return options.revision
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return '' }
}

export function summaryMarkdown(evidence) {
  const lines = [`# C 档 P2 验收记录（${evidence.environment}）`, '', `- 员工端：${evidence.base}`, `- 代码版本：${evidence.codeRevision || '未知'}`,
    `- 执行镜像：${evidence.image || '未提供'}`, `- 执行时间：${evidence.executedAt} — ${evidence.finishedAt}`, `- 结论：待验收人复核（evidence.json 的 status、reviewer、conclusion）`, '']
  for (const scenario of evidence.scenarios) {
    lines.push(`## ${scenario.id}：${scenario.title} — ${scenario.status}`, '')
    for (const check of scenario.checks) lines.push(`- ${check.ok ? '✅' : '❌'} ${check.name}${check.detail ? `（${check.detail.replace(/\n/g, ' ')}）` : ''}`)
    for (const note of scenario.notes) lines.push(`- 👀 ${note}`)
    for (const run of scenario.runs) lines.push(`- Run ${run.runId}：${run.status}；工具 ${run.tools.map(tool => `${tool.name}(${tool.status ?? '?'})`).join('、') || '无'}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const order = Object.keys(SCENARIOS)
  const selected = options.scenarios ?? order
  for (const id of selected) if (!SCENARIOS[id]) throw new Error(`未知场景：${id}（可选 ${order.join(', ')}）`)
  options.out = resolve(options.out ?? join(root, '.runtime', 'c-tier-p2', new Date().toISOString().replace(/[:.]/g, '-')))
  mkdirSync(join(options.out, 'files'), { recursive: true })
  const client = new Client(options)
  if (options.loginFile) await client.login(options.loginFile)
  await client.json('GET', '/session')
  const evidence = {
    schemaVersion: SCHEMA_VERSION, environment: options.environment, base: options.base, codeRevision: revision(options),
    image: options.image ?? '', executedAt: new Date().toISOString(), finishedAt: '', status: 'unreviewed', reviewer: '', conclusion: '', scenarios: [],
  }
  const state = { runs: [] }
  for (const id of order.filter(item => selected.includes(item))) {
    const scenario = new Scenario(id, SCENARIO_TITLES[id])
    if (id === 'workspace-retire') state.runs = evidence.scenarios.flatMap(item => item.runs)
    console.log(`▶ ${id}：${scenario.title}`)
    try {
      await SCENARIOS[id](client, options, scenario, state)
    } catch (error) {
      scenario.check('场景执行未出错', false, error.message)
    }
    console.log(`  ${scenario.status}`)
    evidence.scenarios.push(scenario)
  }
  evidence.finishedAt = new Date().toISOString()
  writeFileSync(join(options.out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  writeFileSync(join(options.out, 'summary.md'), summaryMarkdown(evidence))
  console.log(`证据目录：${options.out}`)
  if (evidence.scenarios.some(scenario => scenario.status === 'failed')) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 2
  })
}
