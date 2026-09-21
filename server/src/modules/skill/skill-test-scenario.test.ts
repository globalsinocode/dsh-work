import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import { evaluateAttemptEvidence } from './skill-test-evidence.ts'

function fixture() {
  const manifest = { agent_configuration: { skill_instructions: [
    { id: 'root', version: '1.0.0' },
    { id: 'spreadsheet', version: '1.0.0', files: [{ path: 'scripts/calc.py', size: 1, sha256: 'a'.repeat(64) }] },
  ] }, test_scenario: { id: 'text-case', requiredSkills: ['root@1.0.0'], requiredPythonEntries: [],
    assertions: [{ kind: 'reply_json_equals', path: ['total'], expected: 12 }] } } as unknown as RuntimeManifest
  return { attemptId: 'attempt-current', runStatus: 'succeeded', attemptStatus: 'succeeded', manifest,
    activations: [{ attemptId: 'attempt-current', skillId: 'root', skillVersion: '1.0.0' }],
    pythonExecutions: [] as Array<{ attemptId: string; skillId: string; entry: string; succeeded: boolean }>,
    events: [{ attemptId: 'attempt-current', eventType: 'assistant.completed', displayMessage: '{"total":12}' }],
  }
}
test('8b RED: a declared text scenario does not require its unrelated Python branch', () => {
  assert.equal(evaluateAttemptEvidence(fixture()).passed, true)
})
test('8b RED: execution traces and a nonempty answer do not pass an incorrect numeric assertion', () => {
  const input = fixture()
  input.activations.push({ attemptId: 'attempt-current', skillId: 'spreadsheet', skillVersion: '1.0.0' })
  input.pythonExecutions.push({ attemptId: 'attempt-current', skillId: 'spreadsheet', entry: 'scripts/calc.py', succeeded: true })
  input.events[0]!.displayMessage = '{"total":13}'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})

test('missing or previous-Attempt activation and wrong versions are not accepted', () => {
  const input = fixture()
  input.activations[0]!.attemptId = 'attempt-old'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
  input.activations[0]!.attemptId = input.attemptId
  input.activations[0]!.skillVersion = '0.9.0'
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('legacy calls without a scenario retain whole-bundle activation and Python checks', () => {
  const input = fixture()
  delete input.manifest.test_scenario
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})
test('missing fields, malformed JSON and string numbers fail strict JSON assertions', () => {
  const input = fixture()
  for (const reply of ['{}', '{"total":"12"}', '```json\n{"total":12}\n```', '{broken']) {
    input.events[0]!.displayMessage = reply
    assert.equal(evaluateAttemptEvidence(input).passed, false)
  }
})
test('assertion-free scenarios explicitly report execution-only validation', () => {
  const input = fixture()
  input.manifest.test_scenario!.assertions = []
  const evidence = evaluateAttemptEvidence(input)
  assert.equal(evidence.passed, true)
  assert.equal(evidence.validationLevel, 'execution')
})
test('arbitrary evaluators, unknown references and undeclared Python entries are rejected', () => {
  const input = fixture()
  const invalids = [
    { ...input.manifest.test_scenario, evaluator: 'process.exit(0)' },
    { ...input.manifest.test_scenario, requiredSkills: ['root@0.9.0'] },
    { ...input.manifest.test_scenario, requiredPythonEntries: [{ skill: 'spreadsheet@1.0.0', entry: '../calc.py' }] },
    { ...input.manifest.test_scenario, assertions: [{ kind: 'reply_json_equals', path: ['__proto__'], expected: null }] },
    { ...input.manifest.test_scenario, assertions: [{ kind: 'regex', value: '.*' }] },
  ]
  for (const scenario of invalids) {
    input.manifest.test_scenario = scenario as RuntimeManifest['test_scenario']
    assert.throws(() => evaluateAttemptEvidence(input), /场景无效/)
  }
})
test('the root and the selected Python dependency are always mandatory', () => {
  const input = fixture()
  input.manifest.test_scenario!.requiredSkills = []
  input.manifest.test_scenario!.requiredPythonEntries = [{ skill: 'spreadsheet@1.0.0', entry: 'scripts/calc.py' }]
  assert.equal(evaluateAttemptEvidence(input).passed, false)
  input.activations.push({ attemptId: input.attemptId, skillId: 'spreadsheet', skillVersion: '1.0.0' })
  input.pythonExecutions.push({ attemptId: input.attemptId, skillId: 'spreadsheet', entry: 'scripts/calc.py', succeeded: true })
  assert.equal(evaluateAttemptEvidence(input).passed, true)
  input.activations.shift()
  assert.equal(evaluateAttemptEvidence(input).passed, false)
})

test('scenario expectations are immutable Manifest input and only accepted for trial purpose', async () => {
  const { compileRuntimeManifest } = await import('../runtime/manifest-compiler.ts')
  const input = fixture()
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', purpose: 'admin-skill-test', run_id: 'run-scenario', attempt_id: input.attemptId,
    task_id: 'task-scenario',
    session_id: 'admin-session-scenario', workspace_id: '', agent_version_id: null,
    agent_configuration: { system_prompt: 'A deterministic scenario test system instruction.', skill_instructions: [
      { id: 'root', version: '1.0.0', instructions: 'Follow the declared test input and report the exact result.' },
    ] },
    user_context: { user_id: 'test-admin', tenant_id: 'test-tenant', role_ids: [] },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'deny' },
    skills: [{ id: 'root', version: '1.0.0' }], tools: [], data_scopes: [], knowledge_context: [],
    input: { message: 'Calculate a fixture total', file_mounts: [] },
    budget: { scope_task_id: 'task-scenario', cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null }, reservation: { duration_ms: 30000, tool_calls: 8, output_bytes: 4096 }, enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' } },
    limits: { timeout_seconds: 30, max_output_bytes: 4096, max_tool_calls: 8 },
    created_at: new Date().toISOString(), test_scenario: input.manifest.test_scenario,
  }
  const compiled = compileRuntimeManifest(manifest)
  manifest.test_scenario!.assertions = []
  assert.notEqual(compiled.sha256, compileRuntimeManifest(manifest).sha256)
  assert.equal(compiled.manifest.test_scenario!.assertions.length, 1)
  delete manifest.purpose
  assert.throws(() => compileRuntimeManifest(manifest), /purpose/)
})
test('C9 permits a text-only trial despite optional Python catalog entries, not a required Python trial', async () => {
  const { CapabilityGuardedRuntime } = await import('../runtime/execution-capabilities.ts')
  const input = fixture()
  input.manifest.tools = [{ id: 'python_execute', version: '1.0.0' }]
  const runtime = new CapabilityGuardedRuntime({} as import('../runtime/runtime-types.ts').AgentRuntimePort, { status: 'unavailable' })
  await runtime.assertAvailable(input.manifest)
  input.manifest.test_scenario!.requiredPythonEntries = [{ skill: 'spreadsheet@1.0.0', entry: 'scripts/calc.py' }]
  await assert.rejects(runtime.assertAvailable(input.manifest), { code: 'PYTHON_UNAVAILABLE' })
})
