import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RequestError } from '../../domain/request-errors.ts'
import { parseCreateAgentDraftInput, parseUpdateAgentDraftInput } from './agent-draft-input.ts'

const createDraft = {
  id: 'agent-draft',
  name: '',
  description: '',
  visibility: '',
  welcomeMessage: '',
  systemPrompt: '',
  changeSummary: '',
  roleIds: ['role-employee'],
  dataScopes: ['enterprise:authorized'],
  examplePrompts: [''],
  skills: ['skill-document@1.0.0'],
  tools: ['tool-runtime-file-read@1.0.0'],
  maxOutputBytes: 1,
  maxToolCalls: 1,
  timeoutSeconds: 1,
}

const updateDraft = {
  agentId: 'agent-draft',
  name: createDraft.name,
  description: createDraft.description,
  visibility: createDraft.visibility,
  welcomeMessage: createDraft.welcomeMessage,
  systemPrompt: createDraft.systemPrompt,
  changeSummary: createDraft.changeSummary,
  roleIds: createDraft.roleIds,
  dataScopes: createDraft.dataScopes,
  examplePrompts: createDraft.examplePrompts,
  skills: createDraft.skills,
  tools: createDraft.tools,
  maxOutputBytes: createDraft.maxOutputBytes,
  maxToolCalls: createDraft.maxToolCalls,
  timeoutSeconds: createDraft.timeoutSeconds,
  expectedRevision: 'revision-1',
}

const createStringFields = [
  'id', 'name', 'description', 'visibility', 'welcomeMessage', 'systemPrompt', 'changeSummary',
] as const
const updateStringFields = ['agentId', ...createStringFields.filter(field => field !== 'id'), 'expectedRevision'] as const
const arrayFields = ['roleIds', 'dataScopes', 'examplePrompts', 'skills', 'tools'] as const
const quotaFields = ['maxOutputBytes', 'maxToolCalls', 'timeoutSeconds'] as const
const optionalArrayFields = ['executionRoleIds', 'executionDataScopes'] as const
const leaked = 'secret-leak-value'

function assertInvalid(run: () => void, field: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RequestError, `expected RequestError, got ${error instanceof Error ? error.name : typeof error}`)
    assert.equal(error.status, 422)
    assert.equal(error.code, 'invalid_request')
    assert.match(error.message, new RegExp(field))
    assert.equal(error.message.includes(leaked), false)
    assert.equal(error instanceof TypeError, false)
    return true
  })
}

test('create parser accepts a structurally valid draft, including blank strings and omitted compatibility fields', () => {
  const parsed = parseCreateAgentDraftInput(createDraft)
  assert.equal(parsed.id, createDraft.id)
  assert.equal(parsed.name, '')
  assert.equal(parsed.description, '')
  assert.equal(parsed.welcomeMessage, '')
  assert.equal(parsed.systemPrompt, '')
  assert.equal(parsed.changeSummary, '')
  assert.deepEqual(parsed.roleIds, createDraft.roleIds)
  assert.deepEqual(parsed.examplePrompts, [''])
  assert.equal(parsed.maxOutputBytes, 1)
  assert.equal(parsed.maxToolCalls, 1)
  assert.equal(parsed.timeoutSeconds, 1)
  assert.equal(parsed.workInstructions, undefined)
  assert.equal(parsed.executionRoleIds, undefined)
  assert.equal(parsed.executionDataScopes, undefined)
  assert.equal(parsed.owner, '')
  assert.equal(parsed.department, '')
  assert.equal(parsed.delegationPolicy, undefined)
  assert.equal(parsed.mcpScope, undefined)
})

test('update parser accepts a structurally valid draft and keeps expectedRevision', () => {
  const parsed = parseUpdateAgentDraftInput(updateDraft)
  assert.equal(parsed.agentId, updateDraft.agentId)
  assert.equal(parsed.expectedRevision, 'revision-1')
  assert.equal(parsed.name, '')
  assert.deepEqual(parsed.tools, updateDraft.tools)
  assert.equal(parsed.workInstructions, undefined)
})

test('parsers accept optional strings and string arrays, and pass delegation and MCP scope through', () => {
  const delegationPolicy = { allowedAgentVersionIds: ['version-1'], maxDepth: 1, maxParallel: 1, timeoutSeconds: 30 }
  const mcpScope = { mode: 'none' as const, connectorIds: [] as string[] }
  const created = parseCreateAgentDraftInput({
    ...createDraft,
    owner: '不会采用客户端负责人',
    department: '不会采用客户端部门',
    workInstructions: null,
    executionRoleIds: ['role-employee'],
    executionDataScopes: [],
    delegationPolicy,
    mcpScope,
  })
  assert.equal(created.workInstructions, null)
  assert.deepEqual(created.executionRoleIds, ['role-employee'])
  assert.deepEqual(created.executionDataScopes, [])
  assert.equal(created.owner, '不会采用客户端负责人')
  assert.equal(created.department, '不会采用客户端部门')
  assert.deepEqual(created.delegationPolicy, delegationPolicy)
  assert.deepEqual(created.mcpScope, mcpScope)

  const updated = parseUpdateAgentDraftInput({
    ...updateDraft,
    workInstructions: '核对输入并确认结果后回复用户。',
    executionRoleIds: ['role-employee'],
    executionDataScopes: null,
  })
  assert.equal(updated.workInstructions, '核对输入并确认结果后回复用户。')
})

test('parsers reject a non-object body', () => {
  for (const value of [null, [], 'draft', 1]) {
    assertInvalid(() => parseCreateAgentDraftInput(value), '请求体')
    assertInvalid(() => parseUpdateAgentDraftInput(value), '请求体')
  }
})

test('create parser rejects undefined, objects, and non-string array items', () => {
  for (const field of createStringFields) {
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: undefined }), field)
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: { leak: leaked } }), field)
  }
  for (const field of arrayFields) {
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: undefined }), field)
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: { leak: leaked } }), field)
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: ['ok', { leak: leaked }] }), field)
  }
  for (const field of quotaFields) {
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: undefined }), field)
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: { leak: leaked } }), field)
  }
})

test('update parser rejects undefined, objects, and non-string array items', () => {
  for (const field of updateStringFields) {
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: undefined }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: { leak: leaked } }), field)
  }
  for (const field of arrayFields) {
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: undefined }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: { leak: leaked } }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: ['ok', { leak: leaked }] }), field)
  }
  for (const field of quotaFields) {
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: undefined }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: { leak: leaked } }), field)
  }
  for (const value of ['', '   ']) {
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, expectedRevision: value }), 'expectedRevision')
  }
})

test('optional fields may be omitted, and illegal values are rejected without echoing the payload', () => {
  assert.doesNotThrow(() => parseCreateAgentDraftInput({ ...createDraft, workInstructions: undefined }))
  assert.doesNotThrow(() => parseUpdateAgentDraftInput({ ...updateDraft, workInstructions: undefined }))
  assert.equal(parseCreateAgentDraftInput({ ...createDraft, workInstructions: null }).workInstructions, null)
  assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, workInstructions: { leak: leaked } }), 'workInstructions')
  assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, workInstructions: { leak: leaked } }), 'workInstructions')
  assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, workInstructions: 1 }), 'workInstructions')

  for (const field of optionalArrayFields) {
    assert.doesNotThrow(() => parseCreateAgentDraftInput({ ...createDraft, [field]: undefined }))
    assert.doesNotThrow(() => parseCreateAgentDraftInput({ ...createDraft, [field]: null }))
    assert.doesNotThrow(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: undefined }))
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: { leak: leaked } }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: { leak: leaked } }), field)
    assertInvalid(() => parseCreateAgentDraftInput({ ...createDraft, [field]: ['ok', { leak: leaked }] }), field)
    assertInvalid(() => parseUpdateAgentDraftInput({ ...updateDraft, [field]: [leaked, 1] }), field)
  }
})

test('quota fields must be positive safe integers and do not copy business bounds', () => {
  for (const parse of [parseCreateAgentDraftInput, parseUpdateAgentDraftInput]) {
    const base = parse === parseCreateAgentDraftInput ? createDraft : updateDraft
    for (const field of quotaFields) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', true]) {
        assertInvalid(() => parse({ ...base, [field]: value }), field)
      }
    }
    assert.doesNotThrow(() => parse({ ...base, maxOutputBytes: 1, maxToolCalls: Number.MAX_SAFE_INTEGER, timeoutSeconds: 1 }))
  }
})
