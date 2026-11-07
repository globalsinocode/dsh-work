import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { configurationFingerprint, type AgentFingerprintSource } from '../agent/postgres-agent-service.ts'
import { normalizeDraftDirectory, readDraftDirectory } from './skill-submission-service.ts'
import { parseSkillDirectoryFiles } from './skill-package.ts'

let workspace: string

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'skill-draft-'))
  await mkdir(join(workspace, 'drafts', 'weekly', 'scripts'), { recursive: true })
  await writeFile(join(workspace, 'drafts', 'weekly', 'SKILL.md'), '---\nname: 周报汇总\ndescription: 汇总一周的销售日报。\n---\n\n按区域汇总日报，运行 scripts/report.py 计算环比。\n')
  await writeFile(join(workspace, 'drafts', 'weekly', 'scripts', 'report.py'), 'print("ok")\n')
  await mkdir(join(workspace, 'output'), { recursive: true })
})

after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

test('草稿目录只接受工作区内、不在 output/input/skills 下的相对路径', () => {
  assert.equal(normalizeDraftDirectory(' ./drafts/weekly/ '), 'drafts/weekly')
  for (const value of ['', '/tmp/x', '../x', 'drafts/../../x', 'output/skill', 'input/a', 'skills/b', 42]) {
    assert.throws(() => normalizeDraftDirectory(value), { code: 'TOOL_PRECONDITION_FAILED' }, String(value))
  }
})

test('读取草稿目录的普通文件，并按 ZIP 安装同一包规则解析', async () => {
  const files = await readDraftDirectory(workspace, 'drafts/weekly')
  assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'scripts/report.py'])
  const pkg = parseSkillDirectoryFiles(files)
  assert.equal(pkg.name, '周报汇总')
  assert.ok(pkg.toolIds.includes('python_execute@1.0.0'), '含脚本的包声明 python_execute')
  assert.equal(pkg.archiveSha256, pkg.sha256)
})

test('草稿目录不存在、含符号链接或目录本身是链接时拒绝', async () => {
  await assert.rejects(readDraftDirectory(workspace, 'drafts/missing'), /工作区中没有这个目录/)
  await mkdir(join(workspace, 'drafts', 'linked'), { recursive: true })
  await symlink('/etc/hosts', join(workspace, 'drafts', 'linked', 'hosts.txt'))
  await assert.rejects(readDraftDirectory(workspace, 'drafts/linked'), /不允许符号链接/)
  await symlink(join(workspace, 'output'), join(workspace, 'drafts', 'escape'))
  await assert.rejects(readDraftDirectory(workspace, 'drafts/escape'), /不是真实目录/)
})

test('可创建 Skill 开关关闭时不进入验证指纹，开启时改变指纹', () => {
  const base = {
    versionId: 'v1', name: '助手', description: '说明', welcomeMessage: '', systemPrompt: '你是助手。',
    roleIds: [], dataScopes: [], tools: [],
    examplePrompts: [], skills: [], webSearchEnabled: false, projectTasksEnabled: false,
    agentRecommendationEnabled: false, maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  }
  const before = configurationFingerprint(base as unknown as AgentFingerprintSource)
  assert.equal(configurationFingerprint({ ...base, skillCreationEnabled: false } as AgentFingerprintSource), before)
  assert.notEqual(configurationFingerprint({ ...base, skillCreationEnabled: true } as AgentFingerprintSource), before)
})
