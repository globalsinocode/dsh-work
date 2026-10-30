import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentBuiltinToolNames, agentRecommendationToolNames, builtinTool, executionToolNames, invalidSkillToolReferences, isDshBuiltinTool,
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

// 推荐方案 4.1：推荐工具只在开启开关的个人对话中装配，Skill 不能声明。
test('agent recommendation tools assemble only for enabled personal conversations', () => {
  assert.deepEqual(agentRecommendationToolNames({ enabled: true, personalConversation: true }), ['list_colleague_agents', 'recommend_agents'])
  assert.deepEqual(agentRecommendationToolNames({ enabled: true, personalConversation: false }), [])
  assert.deepEqual(agentRecommendationToolNames({ enabled: false, personalConversation: true }), [])
  for (const name of ['list_colleague_agents', 'recommend_agents']) {
    assert.equal(builtinTool(name)?.assembly, 'personal-conversation')
    assert.equal(isDshBuiltinTool(name), false, 'platform tools are not emergency-disabled as DSH tools')
    assert.deepEqual(invalidSkillToolReferences([`${name}@1.0.0`]), [`${name}@1.0.0`])
  }
  assert.equal(agentBuiltinToolNames({ webSearchEnabled: true }).includes('list_colleague_agents'), false)
})
