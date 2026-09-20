import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertDraftCopyFields, assertDraftCopyPlan, DRAFT_COPY_FIELDS } from './agent-draft-copy-policy.ts'
import type { AgentDefinition, UpdateAgentDraftInput } from '../../domain/types.ts'
const before = { id: 'a', status: 'draft', name: 'n', description: 'd', welcomeMessage: 'w', examplePrompts: ['e'],
  owner: 'u', department: 'd', visibility: 'all', roleIds: ['r'], dataScopes: ['s'], systemPrompt: 'system', maxOutputBytes: 4096, maxToolCalls: 20,
  timeoutSeconds: 60, skills: ['s@1'], tools: ['t@1'] } as AgentDefinition
const after = { ...before, agentId: 'a', name: 'new', changeSummary: 'copy' } as unknown as Omit<UpdateAgentDraftInput, 'actor'>
test('risk policy has a closed display-only field list', () => {
  assert.deepEqual(DRAFT_COPY_FIELDS, ['name', 'description', 'welcomeMessage', 'examplePrompts'])
  for (const field of DRAFT_COPY_FIELDS) assert.doesNotThrow(() => assertDraftCopyFields({ [field]: 'x' }))
  for (const field of ['systemPrompt', 'instructions', 'tools', 'skills', 'roleIds', 'dataScopes', 'status', 'owner', 'visibility', '__proto__', 'confirmationMode']) {
    assert.throws(() => assertDraftCopyFields(Object.fromEntries([['name', 'x'], [field, 'x']])))
  }
  assert.throws(() => assertDraftCopyFields({}))
})
test('complete normalized diff cannot smuggle a protected field or change object identity', () => {
  assert.doesNotThrow(() => assertDraftCopyPlan(before, after))
  for (const field of ['systemPrompt', 'roleIds', 'dataScopes', 'tools', 'skills', 'maxOutputBytes', 'owner', 'department', 'visibility']) {
    assert.throws(() => assertDraftCopyPlan(before, { ...after, [field]: 'injected' }))
  }
  assert.throws(() => assertDraftCopyPlan(before, { ...after, agentId: 'different' }))
  assert.throws(() => assertDraftCopyPlan({ ...before, status: 'published' }, after))
  assert.throws(() => assertDraftCopyPlan(before, { ...after, name: before.name }))
})
