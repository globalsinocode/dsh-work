import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPythonSandboxArguments, PythonSkillRunner } from './python-skill-runner.ts'

test('Python Skill runner requires a digest-pinned image and builds a closed sandbox command', () => {
  assert.throws(() => new PythonSkillRunner('python:3.13'), /sha256/)
  const image = `python@sha256:${'a'.repeat(64)}`
  assert.doesNotThrow(() => new PythonSkillRunner(image))
  const args = buildPythonSandboxArguments(image, '/runtime/skill', '/runtime/input', '/runtime/output', 'scripts/check.py', ['value'])
  assert.deepEqual(args.slice(0, 13), ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m'])
  assert.ok(args.includes('type=bind,src=/runtime/skill,dst=/skill,readonly'))
  assert.ok(args.includes('type=bind,src=/runtime/input,dst=/input,readonly'))
  assert.ok(args.includes('type=bind,src=/runtime/output,dst=/output'))
  assert.deepEqual(args.slice(-5), ['python', '-I', '-B', 'scripts/check.py', 'value'])
})
