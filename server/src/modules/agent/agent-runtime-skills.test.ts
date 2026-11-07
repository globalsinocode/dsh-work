import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitSkillReferences } from './postgres-agent-service.ts'

test('a session-selected version replaces the pinned one and counts as selected, never both', () => {
  // mergeSkillReferences keeps one version per Skill with the session's choice winning.
  const merged = ['report@1.1.0', 'notes@1.0.0']
  assert.deepEqual(splitSkillReferences(merged, ['report@1.1.0']), { pinnedOnly: ['notes@1.0.0'], selected: ['report@1.1.0'] })
  // Pinned and also chosen in the session: refused like any direct choice when its dependencies are missing.
  assert.deepEqual(splitSkillReferences(['notes@1.0.0'], [' notes@1.0.0 ']), { pinnedOnly: [], selected: ['notes@1.0.0'] })
  assert.deepEqual(splitSkillReferences(['notes@1.0.0'], []), { pinnedOnly: ['notes@1.0.0'], selected: [] })
})
