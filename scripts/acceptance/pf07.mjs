import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const expectedIds = new Set([
  'session-neutral-task', 'external-action', 'cumulative-budget', 'mcp-connector',
  'persistent-wait', 'controlled-memory', 'agent-delegation'
])
const requiredEvidence = [
  'matrixVersion', 'codeRevision', 'deploymentVersion', 'environment', 'executedAt', 'actor',
  'dshVersion', 'adapterVersion', 'model', 'approvedCapabilities', 'reviewer', 'conclusion'
]

export function validateMatrix(matrix, scripts) {
  const errors = []
  if (matrix?.schemaVersion !== 'agent-platform-capabilities/v1') errors.push('能力矩阵版本无效')
  if (!Array.isArray(matrix?.capabilities)) return [...errors, '能力列表缺失']
  const seen = new Set()
  for (const capability of matrix.capabilities) {
    if (!expectedIds.has(capability.id) || seen.has(capability.id)) errors.push(`能力 ID 无效或重复: ${capability.id}`)
    seen.add(capability.id)
    if (!/^PF-0[1-6]$/.test(capability.package)) errors.push(`${capability.id}: 实施包无效`)
    for (const level of ['p0', 'p1']) {
      if (!Array.isArray(capability[level]) || !capability[level].length) {
        errors.push(`${capability.id}: 缺少 ${level} 测试`)
        continue
      }
      for (const command of capability[level]) {
        const match = /^pnpm ([a-z0-9:-]+)$/.exec(command)
        if (!match || !Object.hasOwn(scripts, match[1])) errors.push(`${capability.id}: 未定义测试命令 ${command}`)
      }
    }
    if (!Array.isArray(capability.p2Scenarios) || !capability.p2Scenarios.length ||
        new Set(capability.p2Scenarios).size !== capability.p2Scenarios.length) {
      errors.push(`${capability.id}: P2 场景缺失或重复`)
    }
  }
  for (const id of expectedIds) if (!seen.has(id)) errors.push(`缺少能力: ${id}`)
  return errors
}

export function validateP2(record, matrix) {
  const errors = []
  if (record?.schemaVersion !== 'agent-platform-p2-evidence/v1') errors.push('P2 记录版本无效')
  if (record?.status !== 'verified') errors.push('P2 状态必须由验收人明确标记 verified')
  for (const field of requiredEvidence) {
    if (typeof record?.[field] !== 'string' || !record[field].trim()) errors.push(`缺少 ${field}`)
  }
  if (record?.matrixVersion !== matrix.schemaVersion) errors.push('P2 能力矩阵版本与当前矩阵不一致')
  if (!Array.isArray(record?.knownLimitations)) errors.push('缺少已知限制列表')
  if (!Array.isArray(record?.capabilities)) return [...errors, '缺少能力验收记录']
  const byId = new Map()
  for (const capability of record.capabilities) {
    if (byId.has(capability.id)) errors.push(`重复能力验收: ${capability.id}`)
    byId.set(capability.id, capability)
  }
  for (const expected of matrix.capabilities) {
    const capability = byId.get(expected.id)
    if (!capability) { errors.push(`缺少能力验收: ${expected.id}`); continue }
    const scenarios = new Map()
    for (const scenario of capability.scenarios ?? []) {
      if (scenarios.has(scenario.id)) errors.push(`${expected.id}: 重复场景 ${scenario.id}`)
      scenarios.set(scenario.id, scenario)
    }
    for (const id of expected.p2Scenarios) {
      const scenario = scenarios.get(id)
      if (!scenario || scenario.result !== 'passed' || !Array.isArray(scenario.evidenceRefs) ||
          !scenario.evidenceRefs.length || scenario.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
          !Array.isArray(scenario.runIds) || !scenario.runIds.length ||
          !Array.isArray(scenario.attemptIds) || !scenario.attemptIds.length) {
        errors.push(`${expected.id}/${id}: 缺少通过结论、Run/Attempt 或可审计证据引用`)
      }
    }
  }
  if (byId.size !== matrix.capabilities.length) errors.push('存在未定义的能力验收记录')
  return errors
}

export function createP2Template(matrix) {
  return {
    schemaVersion: 'agent-platform-p2-evidence/v1', status: 'evidence_pending',
    matrixVersion: matrix.schemaVersion, codeRevision: '', deploymentVersion: '', environment: '', executedAt: '', actor: '',
    dshVersion: '', adapterVersion: '', model: '', approvedCapabilities: '', reviewer: '', conclusion: '',
    knownLimitations: [],
    capabilities: matrix.capabilities.map(capability => ({
      id: capability.id,
      scenarios: capability.p2Scenarios.map(id => ({
        id, result: 'pending', runIds: [], attemptIds: [], evidenceRefs: []
      }))
    }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = JSON.parse(readFileSync(resolve(root, 'docs/development/agent-platform-capabilities.v1.json'), 'utf8'))
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts
  const errors = validateMatrix(matrix, scripts)
  const evidencePath = process.argv[2] === '--template' ? undefined : process.argv[2]
  if (process.argv[2] === '--template') {
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
    else console.log(JSON.stringify(createP2Template(matrix), null, 2))
    process.exit()
  }
  if (evidencePath) errors.push(...validateP2(JSON.parse(readFileSync(resolve(evidencePath), 'utf8')), matrix))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log(evidencePath ? 'PF-07 矩阵与 P2 证据字段检查通过；证据真实性仍需人工复核' : 'PF-07 能力矩阵检查通过；P2 尚未核验')
}
