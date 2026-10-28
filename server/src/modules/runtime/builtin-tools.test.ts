import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentBuiltinToolNames, builtinTool, executionToolNames, invalidSkillToolReferences, isDshBuiltinTool,
  normalizeDisabledTools, skillToolName, unavailableSkillTools,
} from './builtin-tools.ts'

// 执行隔离阶段 2：bash 由平台在执行容器可用时装配，不进入 Agent 快照，也不能由 Skill 声明。
test('bash is a DSH tool assembled only when the execution container is available', () => {
  const bash = builtinTool('bash')
  assert.equal(bash?.source, 'dsh')
  assert.equal(bash?.risk, 'medium')
  assert.equal(bash?.assembly, 'execution-container')
  assert.equal(isDshBuiltinTool('bash'), true, 'Runtime emergency disable applies to bash')
  assert.deepEqual(normalizeDisabledTools(['bash']), ['bash'])
  assert.deepEqual(executionToolNames(), ['bash'])
  for (const webSearchEnabled of [false, true]) {
    assert.equal(agentBuiltinToolNames({ webSearchEnabled }).includes('bash'), false)
  }
})

test('Skills cannot declare bash: allowed-tools Bash stays an unsupported requirement', () => {
  assert.equal(skillToolName('Bash'), undefined)
  assert.equal(skillToolName('Read'), 'read')
  assert.deepEqual(invalidSkillToolReferences(['bash@1.0.0', 'read@1.0.0']), ['bash@1.0.0'])
  assert.deepEqual(unavailableSkillTools(['bash@1.0.0'], { webSearchEnabled: true }), ['bash@1.0.0（平台不提供该工具）'])
})
