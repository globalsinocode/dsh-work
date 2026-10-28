import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandEnvironment } from './docker-execution-backend.ts'
import type { ContainerCommand, ContainerCommandResult } from './execution-backend.ts'
import { ExecutionContainerPythonRunner, skillDirectory } from './execution-container-python.ts'
import type { RuntimeManifest } from './runtime-types.ts'

function manifest(): RuntimeManifest {
  return {
    attempt_id: 'attempt-py',
    agent_configuration: {
      skill_instructions: [{ id: 'skill-report', name: 'report', version: '1.0.0', files: [{ path: 'scripts/build.py', sha256: 'a'.repeat(64), size: 10 }] }],
    },
  } as unknown as RuntimeManifest
}

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-py-container-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'workspace')
  await mkdir(join(directory, 'output'), { recursive: true })
  return directory
}

test('runs the declared entry in the Attempt container from the Skill directory, with path variables', async t => {
  const directory = await workspace(t)
  await writeFile(join(directory, 'output', 'existing.md'), '# kept as is\n')
  const calls: Array<{ attemptId: string; workspace: string; command: ContainerCommand }> = []
  const runner = new ExecutionContainerPythonRunner({
    async exec(attemptId, workspaceDirectory, command): Promise<ContainerCommandResult> {
      calls.push({ attemptId, workspace: workspaceDirectory, command })
      // What the script would do: write a new output; an untouched file is not reported.
      await writeFile(join(workspaceDirectory, 'output', 'report.xlsx'), 'PK-workbook')
      await mkdir(join(workspaceDirectory, 'output', 'nested'))
      return { exitCode: 0, stdout: 'done', stderr: '', truncated: false, timedOut: false }
    },
  })
  const result = await runner.execute({ skill: 'report', entry: 'scripts/build.py', args: ['--region', '华东'] }, manifest(), directory, new AbortController().signal)

  const [call] = calls
  assert.equal(call?.attemptId, 'attempt-py')
  assert.equal(call?.workspace, directory)
  assert.deepEqual(call?.command.argv, ['python3', '-I', '-B', 'scripts/build.py', '--region', '华东'])
  const skillDir = skillDirectory(directory, 'skill-report')
  assert.equal(call?.command.cwd, skillDir)
  assert.deepEqual(call?.command.env, { DSH_SKILL_DIR: skillDir, DSH_INPUT_DIR: join(directory, 'input'), DSH_OUTPUT_DIR: join(directory, 'output') })
  assert.equal(call?.command.mayLeaveProcesses, true)
  assert.ok((call?.command.timeoutMs ?? 0) <= 300_000)
  assert.deepEqual(result, { exitCode: 0, stdout: 'done', stderr: '', artifacts: [{ name: 'report.xlsx', size: 11 }] })
})

test('refuses entries the locked Skill does not declare, and reports timeouts and platform stops', async t => {
  const directory = await workspace(t)
  const runner = new ExecutionContainerPythonRunner({
    async exec(): Promise<ContainerCommandResult> {
      return { exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true }
    },
  })
  await assert.rejects(runner.execute({ skill: 'report', entry: 'scripts/other.py' }, manifest(), directory, new AbortController().signal), /未在当前 Run 的锁定 Skill 中声明/)
  await assert.rejects(runner.execute({ skill: 'report', entry: '../escape.py' }, manifest(), directory, new AbortController().signal), /入口文件无效/)
  const timedOut = await runner.execute({ skill: 'report', entry: 'scripts/build.py' }, manifest(), directory, new AbortController().signal)
  assert.equal(timedOut.exitCode, 124)
  assert.match(timedOut.stderr, /执行超时/)

  const stopped = await new ExecutionContainerPythonRunner({
    async exec(): Promise<ContainerCommandResult> {
      return { exitCode: null, stdout: '', stderr: '命令已终止：工作区已用 2.5 GB', truncated: false, timedOut: false, limit: 'workspace' }
    },
  }).execute({ skill: 'report', entry: 'scripts/build.py' }, manifest(), directory, new AbortController().signal)
  assert.equal(stopped.exitCode, 137)
  assert.match(stopped.stderr, /工作区已用/)
})

test('per-command variables are limited to the python_execute paths', () => {
  assert.deepEqual(commandEnvironment({ env: { DSH_OUTPUT_DIR: '/runtime/ws/output' } }), ['-e', 'DSH_OUTPUT_DIR=/runtime/ws/output'])
  assert.deepEqual(commandEnvironment({}), [])
  assert.throws(() => commandEnvironment({ env: { PATH: '/evil' } }), /环境变量无效/)
  assert.throws(() => commandEnvironment({ env: { DSH_INPUT_DIR: 'relative' } }), /环境变量无效/)
  assert.throws(() => commandEnvironment({ env: { DSH_SKILL_DIR: '/ws\nPATH=/evil' } }), /环境变量无效/)
})
