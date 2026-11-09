import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const expectedIds = new Set([
  'session-neutral-task', 'external-action', 'cumulative-budget', 'mcp-connector', 'persistent-wait', 'controlled-memory'
])
const filled = value => typeof value === 'string' && value.trim() !== ''
const requiredEvidence = [
  'matrixVersion', 'codeRevision', 'deploymentVersion', 'environment', 'executedAt', 'actor',
  'dshVersion', 'adapterVersion', 'model', 'approvedCapabilities', 'reviewer', 'conclusion'
]

export function validateMatrix(matrix, scripts) {
  const errors = []
  if (matrix?.schemaVersion !== 'agent-platform-capabilities/v2') errors.push('能力矩阵版本无效')
  if (!Array.isArray(matrix?.capabilities)) return [...errors, '能力列表缺失']
  const seen = new Set()
  for (const capability of matrix.capabilities) {
    if (!expectedIds.has(capability.id) || seen.has(capability.id)) errors.push(`能力 ID 无效或重复: ${capability.id}`)
    seen.add(capability.id)
    if (!/^PF-0[1-5]$/.test(capability.package)) errors.push(`${capability.id}: 实施包无效`)
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
    for (const id of capability.p2RejectedBeforeRun ?? []) {
      if (!capability.p2Scenarios?.includes(id)) errors.push(`${capability.id}: 拒绝类场景 ${id} 不在 P2 场景中`)
    }
  }
  if (matrix.deferred !== undefined && !Array.isArray(matrix.deferred)) return [...errors, 'deferred 必须是数组']
  if (matrix.removed !== undefined && !Array.isArray(matrix.removed)) return [...errors, 'removed 必须是数组']
  const deferredIds = new Set((matrix.deferred ?? []).map(item => item?.capability))
  // 能力可以回到门禁；不在门禁内时必须有 deferred 记录说明原因。
  for (const id of expectedIds) if (!seen.has(id) && !deferredIds.has(id)) errors.push(`缺少能力: ${id}`)
  for (const item of matrix.removed ?? []) {
    const label = `删除项 ${item?.capability}/${item?.scenario}`
    if (!filled(item?.capability) || !filled(item?.scenario) || !filled(item?.reason)) errors.push(`${label}: 缺少能力、场景或原因`)
    if (matrix.capabilities.find(capability => capability.id === item?.capability)?.p2Scenarios?.includes(item?.scenario)) {
      errors.push(`${label}: 场景仍在门禁内`)
    }
  }
  for (const item of matrix.deferred ?? []) {
    const label = `移出项 ${item?.capability}`
    if (!filled(item?.reason) || !filled(item?.reentry)) errors.push(`${label}: 缺少移出原因或恢复条件`)
    if (!Array.isArray(item?.scenarios) || !item.scenarios.length) { errors.push(`${label}: 缺少场景`); continue }
    const active = matrix.capabilities.find(capability => capability.id === item.capability)
    for (const scenario of item.scenarios) {
      if (active?.p2Scenarios?.includes(scenario)) errors.push(`${label}: 场景 ${scenario} 同时在门禁内`)
    }
  }
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
      if (!expected.p2Scenarios.includes(scenario.id)) errors.push(`${expected.id}: 未定义场景 ${scenario.id}`)
      scenarios.set(scenario.id, scenario)
    }
    for (const id of expected.p2Scenarios) {
      const scenario = scenarios.get(id)
      // 创建 Run 之前就拒绝的场景，“没有 Run”正是要验证的结果，仍须有 traceId 或 execution 等证据引用。
      const rejectedBeforeRun = expected.p2RejectedBeforeRun?.includes(id)
      if (!scenario || scenario.result !== 'passed' || !Array.isArray(scenario.evidenceRefs) ||
          !scenario.evidenceRefs.length || scenario.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) ||
          !Array.isArray(scenario.runIds) || !Array.isArray(scenario.attemptIds) ||
          (rejectedBeforeRun ? scenario.runIds.length > 0 || scenario.attemptIds.length > 0
            : !scenario.runIds.length || !scenario.attemptIds.length)) {
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
  const matrix = JSON.parse(readFileSync(resolve(root, 'docs/development/agent-platform-capabilities.v2.json'), 'utf8'))
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
