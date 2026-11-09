import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createP2Template, validateMatrix, validateP2 } from './pf07.mjs'

const root = resolve(import.meta.dirname, '../..')
const matrix = JSON.parse(readFileSync(resolve(root, 'docs/development/agent-platform-capabilities.v2.json'), 'utf8'))
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts

test('PF-07 matrix references every platform capability and existing test commands', () => {
  assert.deepEqual(validateMatrix(matrix, scripts), [])
  assert.match(validateMatrix({ ...matrix, capabilities: matrix.capabilities.slice(1) }, scripts).join(' '), /session-neutral-task/)
  assert.match(validateMatrix({ ...matrix, capabilities: [{ ...matrix.capabilities[0], p1: ['pnpm test:missing'] }, ...matrix.capabilities.slice(1)] }, scripts).join(' '), /未定义测试命令/)
})

test('deferred items need a reason and cannot stay inside the gate', () => {
  const item = { capability: 'controlled-memory', scenarios: ['real-recall'], reason: 'why', reentry: 'when' }
  assert.match(validateMatrix({ ...matrix, deferred: [item] }, scripts).join(' '), /同时在门禁内/)
  const unexplained = { capability: 'persistent-wait', scenarios: ['unknown-action'], reason: '', reentry: 'when' }
  assert.match(validateMatrix({ ...matrix, deferred: [unexplained] }, scripts).join(' '), /缺少移出原因/)
})

test('a capability outside the gate needs a deferred record and may return', () => {
  const deferred = matrix.deferred.filter(item => item.capability !== 'persistent-wait')
  assert.match(validateMatrix({ ...matrix, deferred }, scripts).join(' '), /缺少能力: persistent-wait/)
  const restored = { id: 'persistent-wait', package: 'PF-04', p0: ['pnpm test:m1'], p1: ['pnpm test:pf04:integration'], p2Scenarios: ['real-approval-and-resume'] }
  assert.deepEqual(validateMatrix({ ...matrix, deferred, capabilities: [...matrix.capabilities, restored] }, scripts), [])
  assert.match(validateMatrix({ ...matrix, capabilities: [...matrix.capabilities, { ...restored, id: 'other' }] }, scripts).join(' '), /能力 ID 无效/)
})

test('deferred and removed entries are validated without crashing', () => {
  assert.match(validateMatrix({ ...matrix, deferred: [{ capability: 'persistent-wait', scenarios: ['x'], reason: 42, reentry: 'when' }] }, scripts).join(' '), /缺少移出原因/)
  assert.match(validateMatrix({ ...matrix, deferred: 'none' }, scripts).join(' '), /deferred 必须是数组/)
  assert.match(validateMatrix({ ...matrix, removed: [{ capability: 'session-neutral-task', scenario: 'revocation', reason: 'why' }] }, scripts).join(' '), /仍在门禁内/)
  assert.match(validateMatrix({ ...matrix, removed: [{ capability: 'session-neutral-task', scenario: 'gone', reason: '' }] }, scripts).join(' '), /删除项.*缺少/)
})

test('only declared rejected-before-run scenarios may omit run evidence', () => {
  const record = createP2Template(matrix)
  Object.assign(record, { status: 'verified', knownLimitations: [] })
  for (const field of ['codeRevision', 'deploymentVersion', 'environment', 'executedAt', 'actor', 'dshVersion', 'adapterVersion', 'model', 'approvedCapabilities', 'reviewer', 'conclusion']) record[field] = 'value'
  for (const capability of record.capabilities) {
    const expected = matrix.capabilities.find(item => item.id === capability.id)
    for (const scenario of capability.scenarios) {
      const rejected = expected.p2RejectedBeforeRun?.includes(scenario.id)
      Object.assign(scenario, { result: 'passed', runIds: rejected ? [] : ['run-id'], attemptIds: rejected ? [] : ['attempt-id'], evidenceRefs: ['audit-ref'] })
    }
  }
  const find = (capability, id) => record.capabilities.find(item => item.id === capability).scenarios.find(item => item.id === id)
  Object.assign(find('mcp-connector', 'credential-failure'), { evidenceRefs: ['trace-id'] })
  assert.deepEqual(validateP2(record, matrix), [])
  find('mcp-connector', 'credential-failure').runIds = ['run-id']
  assert.match(validateP2(record, matrix).join(' '), /credential-failure/)
  find('mcp-connector', 'credential-failure').runIds = 'none'
  assert.match(validateP2(record, matrix).join(' '), /credential-failure/)
  find('mcp-connector', 'credential-failure').runIds = []
  find('mcp-connector', 'credential-failure').evidenceRefs = []
  assert.match(validateP2(record, matrix).join(' '), /credential-failure/)
  find('mcp-connector', 'credential-failure').evidenceRefs = ['trace-id']
  Object.assign(find('mcp-connector', 'catalog-change'), { runIds: [], attemptIds: [] })
  assert.match(validateP2(record, matrix).join(' '), /catalog-change/)
})

test('rejected-before-run entries must be matrix scenarios', () => {
  const capabilities = [{ ...matrix.capabilities[0], p2RejectedBeforeRun: ['missing'] }, ...matrix.capabilities.slice(1)]
  assert.match(validateMatrix({ ...matrix, capabilities }, scripts).join(' '), /拒绝类场景 missing/)
})

test('P2 gate rejects declarations without complete run evidence', () => {
  assert.match(validateP2(createP2Template(matrix), matrix).join(' '), /verified/)
  const record = {
    schemaVersion: 'agent-platform-p2-evidence/v1', status: 'verified',
    matrixVersion: matrix.schemaVersion, knownLimitations: [],
    codeRevision: 'revision', deploymentVersion: 'deployment', environment: 'release-test',
    executedAt: '2026-09-23T00:00:00Z', actor: 'employee', dshVersion: 'lock',
    adapterVersion: 'adapter', model: 'model', approvedCapabilities: 'approved set',
    reviewer: 'reviewer', conclusion: 'passed',
    capabilities: matrix.capabilities.map(capability => ({
      id: capability.id,
      scenarios: capability.p2Scenarios.map(id => ({
        id, result: 'passed', evidenceRefs: ['audit-ref'],
        runIds: capability.p2RejectedBeforeRun?.includes(id) ? [] : ['run-id'],
        attemptIds: capability.p2RejectedBeforeRun?.includes(id) ? [] : ['attempt-id'],
      }))
    }))
  }
  assert.deepEqual(validateP2(record, matrix), [])
  record.capabilities[0].scenarios.push({ id: 'unlisted', result: 'failed', runIds: [], attemptIds: [], evidenceRefs: [] })
  assert.match(validateP2(record, matrix).join(' '), /未定义场景 unlisted/)
  record.capabilities[0].scenarios.pop()
  record.capabilities[0].scenarios[0].evidenceRefs = []
  assert.match(validateP2(record, matrix).join(' '), /缺少通过结论/)
  record.status = 'evidence_pending'
  assert.match(validateP2(record, matrix).join(' '), /verified/)
})
