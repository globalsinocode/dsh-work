import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createP2Template, validateMatrix, validateP2 } from './pf07.mjs'

const root = resolve(import.meta.dirname, '../..')
const matrix = JSON.parse(readFileSync(resolve(root, 'docs/development/agent-platform-capabilities.v1.json'), 'utf8'))
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts

test('PF-07 matrix references every platform capability and existing test commands', () => {
  assert.deepEqual(validateMatrix(matrix, scripts), [])
  assert.match(validateMatrix({ ...matrix, capabilities: matrix.capabilities.slice(1) }, scripts).join(' '), /session-neutral-task/)
  assert.match(validateMatrix({ ...matrix, capabilities: [{ ...matrix.capabilities[0], p1: ['pnpm test:missing'] }, ...matrix.capabilities.slice(1)] }, scripts).join(' '), /未定义测试命令/)
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
        id, result: 'passed', runIds: ['run-id'], attemptIds: ['attempt-id'], evidenceRefs: ['audit-ref']
      }))
    }))
  }
  assert.deepEqual(validateP2(record, matrix), [])
  record.capabilities[0].scenarios[0].evidenceRefs = []
  assert.match(validateP2(record, matrix).join(' '), /缺少通过结论/)
  record.status = 'evidence_pending'
  assert.match(validateP2(record, matrix).join(' '), /verified/)
})
