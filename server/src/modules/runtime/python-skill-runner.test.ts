import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundedUtf8Collector, buildPythonSandboxArguments, PythonSkillRunner } from './python-skill-runner.ts'

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

test('sandbox caps the size of any file the script writes', () => {
  const args = buildPythonSandboxArguments(`registry.example/python@sha256:${'a'.repeat(64)}`, '/s', '/i', '/o', 'run.py', [])
  const index = args.indexOf('--ulimit')
  assert.equal(args[index + 1], `fsize=${10 * 1024 * 1024}:${10 * 1024 * 1024}`)
  assert.ok(index < args.indexOf(`registry.example/python@sha256:${'a'.repeat(64)}`), 'docker options come before the image')
})

test('captured output keeps UTF-8 split across chunks and truncates by bytes without a broken character', () => {
  const bytes = Buffer.from('生产计划')
  const split = boundedUtf8Collector()
  split.write(bytes.subarray(0, 4))
  split.write(bytes.subarray(4))
  assert.equal(split.text(), '生产计划')
  const limited = boundedUtf8Collector(7)
  limited.write(bytes)
  limited.write(Buffer.from('ignored after the limit'))
  assert.equal(limited.text(), '生产', '7 bytes hold two 3-byte characters; the cut third is dropped')
})
