import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeAgentMcpScope } from './agent-mcp-scope.ts'

test('MCP scope defaults to all and normalizes selected Connector IDs', () => {
  assert.deepEqual(normalizeAgentMcpScope(undefined), { mode: 'all', connectorIds: [] })
  assert.deepEqual(normalizeAgentMcpScope({ mode: 'selected', connectorIds: ['mcp-b', 'mcp-a', 'mcp-b'] }), {
    mode: 'selected', connectorIds: ['mcp-a', 'mcp-b'],
  })
  assert.deepEqual(normalizeAgentMcpScope({ mode: 'none', connectorIds: [] }), {
    mode: 'none', connectorIds: [],
  })
})

test('MCP scope rejects ambiguous or invalid selections', () => {
  for (const scope of [
    { mode: 'selected', connectorIds: [] },
    { mode: 'none', connectorIds: ['mcp-a'] },
    { mode: 'all', connectorIds: ['mcp-a'] },
    { mode: 'selected', connectorIds: [''] },
    { mode: 'selected', connectorIds: Array.from({ length: 21 }, (_, index) => `mcp-${index}`) },
    { mode: 'all', connectorIds: [], unexpected: true },
  ]) {
    assert.throws(() => normalizeAgentMcpScope(scope), { status: 422, code: 'validation_failed' })
  }
})
