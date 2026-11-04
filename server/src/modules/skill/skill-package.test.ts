import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { parseSkillBundle, parseSkillPackage, scanPythonImports, toSkillPackageArtifact } from './skill-package.ts'
import { buildSkillInstallationPlan, missingPythonDependencies, normalizePythonPackageName } from './skill-installation-plan.ts'
import { continueSkillSource, isPublicAddress, parseSkillSource } from './skill-source.ts'
import { SkillArtifactStore } from './skill-artifact-store.ts'
import { LocalObjectStorage } from '../../infrastructure/storage/local-object-storage.ts'

export const sampleSkill = '---\nname: test-skill\ndescription: Read an exact reference file and report its value.\n---\nRead references/example.txt and report the exact value without inventing data.\n'
test('parses an existing Skill and preserves immutable UTF-8 resources', () => {
  const bytes = zipSync({ 'bundle/SKILL.md': strToU8(sampleSkill), 'bundle/references/example.txt': strToU8('marker-42') })
  const pkg = parseSkillPackage(bytes)
  assert.equal(pkg.name, 'test-skill')
  assert.equal(pkg.files[1]?.content, 'marker-42')
  assert.deepEqual(pkg.toolIds, ['read@1.0.0'])
  assert.deepEqual(parseSkillPackage(strToU8(sampleSkill.replace('Read references/example.txt and report the exact value without inventing data.', 'Summarize the supplied user text faithfully without inventing any facts.'))).toolIds, [])
  assert.equal(pkg.sha256, parseSkillPackage(bytes).sha256)
})
test('maps allowed-tools to built-in tool references and keeps unknown tools unsupported', () => {
  const skill = sampleSkill.replace('description:', 'allowed-tools: [Read, WebSearch, str_replace_editor, Bash]\ndescription:')
  const pkg = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(skill), 'references/example.txt': strToU8('marker') }))
  assert.deepEqual(pkg.toolIds, ['read@1.0.0', 'web_search@1.0.0', 'str_replace_editor@1.0.0'])
  assert.deepEqual(pkg.requirements.filter(item => item.type === 'tool').map(item => [item.name, item.status]), [['Bash', 'unsupported']])
})
test('persists Skill bodies as an immutable folder and keeps only an index descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-store-'))
  try {
    const pkg = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'references/example.txt': strToU8('folder-marker') }))
    const store = new SkillArtifactStore(new LocalObjectStorage(root, { fileMode: 0o400 }))
    const artifact = await store.put(pkg)
    assert.equal(JSON.stringify(artifact).includes('folder-marker'), false)
    assert.equal(await readFile(join(root, artifact.artifactRef, 'references/example.txt'), 'utf8'), 'folder-marker')
    assert.equal((await store.read(artifact)).instructions, pkg.instructions)
    await assert.rejects(async () => {
      const changed = { ...artifact, files: artifact.files.map(file => file.path === 'references/example.txt' ? { ...file, sha256: '0'.repeat(64) } : file) }
      await store.read(changed)
    }, /修改/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('rejects legacy artifact references (symbol-edged package segments)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-store-'))
  try {
    const store = new SkillArtifactStore(new LocalObjectStorage(root, { fileMode: 0o400 }))
    const pkg = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'references/example.txt': strToU8('folder-marker') }))
    // B-02 唯一引用规则：旧版生成器未清理首尾符号的持久化引用（中文名 →
    // packages/____/<sha>）读写同口径拒绝，越界与遍历段一并覆盖。
    for (const segment of ['____', '-degenerate', 'degenerate.', '.hidden', '..', '.']) {
      const artifact = toSkillPackageArtifact(pkg, `packages/${segment}/${pkg.sha256}`)
      await assert.rejects(store.read(artifact), /引用无效/, `artifact_ref segment ${segment}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('truncates the package segment before stripping edge symbols', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-store-'))
  try {
    const store = new SkillArtifactStore(new LocalObjectStorage(root, { fileMode: 0o400 }))
    // 63 个 a + '-report'：先清理后截断会留下结尾 '-'，被规范形式拒绝；先截断后清理得到合法引用。
    const longName = `${'a'.repeat(63)}-report`
    const pkg = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill.replace('test-skill', longName)), 'references/example.txt': strToU8('marker') }))
    const artifact = await store.put(pkg)
    assert.match(artifact.artifactRef, /^packages\/a{63}\/[a-f0-9]{64}$/)

    // 全非字母数字的名称（如中文名）回退为 skill 段，新写入仍符合规范形式。
    const zh = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill.replace('test-skill', '财务分析')), 'references/example.txt': strToU8('marker') }))
    const zhArtifact = await store.put(zh)
    assert.match(zhArtifact.artifactRef, /^packages\/skill\/[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('rejects unsafe paths, executable shell files and ambiguous packages', () => {
  const invalidPackages: Zippable[] = [
    { '../SKILL.md': strToU8(sampleSkill) },
    { 'SKILL.md': strToU8(sampleSkill), 'references': strToU8('conflict'), 'references/example.txt': strToU8('marker') },
    { 'SKILL.md': strToU8(sampleSkill), 'scripts/install.sh': strToU8('echo no') },
    { 'a/SKILL.md': strToU8(sampleSkill), 'b/SKILL.md': strToU8(sampleSkill) },
  ]
  for (const files of invalidPackages) assert.throws(() => parseSkillPackage(zipSync(files)), /Skill 包校验失败/)
  assert.throws(() => parseSkillPackage(strToU8('no metadata')), /SKILL.md/)
  assert.throws(() => parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'huge.txt': new Uint8Array(33 * 1024 * 1024) })), /大小/)
  assert.throws(() => parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'link': [strToU8('target'), { attrs: 0xa1ff0000 }] })), /链接/)
})
test('parses only supported source commands, never interprets shell', () => {
  assert.equal(parseSkillSource('npx skills add vercel-labs/agent-skills --skill web-design-guidelines')?.selected, 'web-design-guidelines')
  assert.equal(parseSkillSource('npx skills@latest add mattpocock/skills --skill=grill-me')?.selected, 'grill-me')
  assert.equal(parseSkillSource(String.raw`npx skills\@latest add mattpocock/skills --skill=grill-me`)?.repository, 'mattpocock/skills')
  assert.equal(parseSkillSource('npx skills@1.2.3 add mattpocock/skills --skill=grill-me')?.selected, 'grill-me')
  assert.equal(parseSkillSource('curl -fsSL https://example.org/skill.zip')?.url, 'https://example.org/skill.zip')
  assert.deepEqual(parseSkillSource('帮我安装 mattpocock/skills 里的 grill-me'), { url: 'https://github.com/mattpocock/skills', repository: 'mattpocock/skills', ref: 'HEAD', selected: 'grill-me' })
  assert.equal(parseSkillSource('安装这个 Skill：https://github.com/owner/repo/tree/main/skills/demo')?.directory, 'skills/demo')
  assert.equal(parseSkillSource('创建一个新的 Skill'), null)
  assert.equal(parseSkillSource('不要安装 mattpocock/skills 里的 grill-me'), null)
  for (const text of ['npx arbitrary install', 'npx skills@latest add', 'npx skills@next add owner/repo --skill demo', 'npx skills@latest add owner/repo --skill=', 'npx skills@latest add owner/repo --skill demo --yes', 'curl https://example.org/install | sh', 'curl -H "Authorization: bearer value" https://example.org/a', 'curl -o /tmp/a https://example.org/a', 'https://user:password@example.org/a', 'http://example.org/a', 'https://example.org/a?token=private']) assert.throws(() => parseSkillSource(text), /来源无效/)
  for (const ip of ['127.0.0.1', '10.2.3.4', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false)
  assert.equal(isPublicAddress('8.8.8.8'), true)
})

test('selects by metadata name without validating unrelated Skill compatibility', () => {
  const repo = {
    'repo/good/SKILL.md': strToU8(sampleSkill),
    'repo/good/references/example.txt': strToU8('expected'),
    'repo/bash/SKILL.md': strToU8(sampleSkill.replace('test-skill', 'bash-skill').replace('description:', 'allowed-tools: [Bash]\ndescription:')),
    'repo/bash/references/example.txt': strToU8('bash-marker'),
    'repo/deps/SKILL.md': strToU8(sampleSkill.replace('test-skill', 'deps-skill').replace('description:', 'dependencies: [pip]\ndescription:')),
    'repo/deps/references/example.txt': strToU8('deps-marker'),
    'repo/broken/SKILL.md': strToU8('---\nname: [broken\n---\ninvalid'),
  }
  assert.equal(parseSkillPackage(zipSync(repo), 'test-skill').name, 'test-skill')
  assert.equal(parseSkillPackage(zipSync(repo), 'bash-skill').compatibility.status, 'incompatible')
  assert.equal(parseSkillPackage(zipSync(repo), 'deps-skill').compatibility.status, 'incompatible')
  assert.throws(() => parseSkillPackage(zipSync({ ...repo, 'repo/duplicate/SKILL.md': strToU8(sampleSkill) }), 'test-skill'), /多个 Skill/)
})

test('resolves delegated Skills from the same archive and detects Python sandbox requirements', () => {
  const delegate = '---\nname: grill-me\ndescription: Delegate an interview to the grilling Skill.\n---\nCall the Skill tool with "grilling" and follow its instructions exactly.\n'
  const dependency = sampleSkill.replace('test-skill', 'grilling')
  const bundle = parseSkillBundle(zipSync({ 'repo/grill-me/SKILL.md': strToU8(delegate), 'repo/grilling/SKILL.md': strToU8(dependency), 'repo/grilling/references/example.txt': strToU8('marker') }), 'grill-me')
  assert.deepEqual(bundle.packages.map(pkg => pkg.name), ['grill-me', 'grilling'])
  assert.deepEqual(bundle.edges, [{ from: 'grill-me', to: 'grilling', type: 'skill' }])
  assert.equal(bundle.root.compatibility.status, 'compatible')
  const scripted = parseSkillPackage(zipSync({ 'SKILL.md': strToU8(sampleSkill), 'references/example.txt': strToU8('marker'), 'scripts/check.py': strToU8('print("ok")') }))
  assert.equal(scripted.compatibility.status, 'needs_review')
  assert.ok(scripted.toolIds.includes('python_execute@1.0.0'))
  const scriptedBundle = { root: scripted, packages: [scripted], edges: [] }
  assert.equal(buildSkillInstallationPlan(scriptedBundle, { pythonSandboxAvailable: false }).compatibility.status, 'incompatible')
  assert.equal(buildSkillInstallationPlan(scriptedBundle, { pythonSandboxAvailable: true }).compatibility.status, 'compatible')

  // 1b② (plan 4.8): scripts that hard-code the per-call sandbox mounts need review; env variables are fine.
  const fixedPaths = parseSkillPackage(zipSync({
    'SKILL.md': strToU8(sampleSkill), 'references/example.txt': strToU8('marker'),
    'scripts/check.py': strToU8('import os\nopen("/input/data.csv").read()\nopen(os.path.join("/output", "r.md"), "w")\n'),
    'scripts/ok.py': strToU8('import os\nout = os.environ["DSH_OUTPUT_DIR"]\nprint("/inputs are fine in text")\n'),
  }))
  const reviewed = buildSkillInstallationPlan({ root: fixedPaths, packages: [fixedPaths], edges: [] }, { pythonSandboxAvailable: true })
  assert.equal(reviewed.compatibility.status, 'needs_review')
  const issue = reviewed.compatibility.issues.find(item => item.code === 'python_fixed_sandbox_paths')
  assert.ok(issue)
  assert.match(issue.message, /scripts\/check\.py/)
  assert.doesNotMatch(issue.message, /scripts\/ok\.py/)
  assert.match(issue.message, /DSH_SKILL_DIR、DSH_INPUT_DIR、DSH_OUTPUT_DIR/)
})

test('Python package requirements match by normalized name', () => {
  assert.equal(normalizePythonPackageName(' Python_Docx '), 'python-docx')
  assert.equal(normalizePythonPackageName('ruamel.yaml'), 'ruamel-yaml')
})

test('continues only an explicit selection from a known source', () => {
  const previous = parseSkillSource('https://github.com/owner/repo')!
  for (const message of ['选上一个仓库中的 wanted', '选择 wanted', '--skill wanted', '请安装上述来源的 wanted']) {
    assert.deepEqual(continueSkillSource(message, previous), { ...previous, selected: 'wanted' })
  }
  assert.equal(continueSkillSource('谢谢', previous), null)
  assert.equal(continueSkillSource('不要安装 wanted', previous), null)
  assert.equal(continueSkillSource('选择 wanted', null), null)
})

const pythonIndex = { stdlib: ['csv', 'os', 'sys', 'datetime', 'json'], modules: { pandas: ['pandas'], openpyxl: ['openpyxl'], docx: ['python-docx'] } }
const scripted = (script: string, extra: Record<string, string> = {}) => parseSkillPackage(zipSync({
  'SKILL.md': strToU8(sampleSkill), 'references/example.txt': strToU8('marker'), 'scripts/run.py': strToU8(script),
  ...Object.fromEntries(Object.entries(extra).map(([path, content]) => [path, strToU8(content)])),
}))
const planFor = (pkg: ReturnType<typeof parseSkillPackage>, pythonModules: typeof pythonIndex | null = pythonIndex) =>
  buildSkillInstallationPlan({ root: pkg, packages: [pkg], edges: [] }, { pythonSandboxAvailable: true, pythonPackages: ['pandas', 'openpyxl', 'python-docx'], pythonModules })

test('undeclared third-party imports become dependencies checked against the execution image', () => {
  const pkg = scripted('import os, csv\nimport pandas as pd\nfrom docx import Document\nfrom helpers import util\n"""\nimport fake\n"""\n', { 'scripts/helpers.py': 'import json\n' })
  assert.deepEqual(pkg.requirements.filter(item => item.name.startsWith('python-import:')).map(item => item.name).sort(),
    ['python-import:csv', 'python-import:docx', 'python-import:json', 'python-import:os', 'python-import:pandas'], 'parsing scans imports but skips local modules and strings')
  const plan = planFor(pkg)
  assert.equal(plan.compatibility.status, 'compatible')
  const root = plan.packages[0]!
  assert.deepEqual(root.requirements.filter(item => item.name.startsWith('python-')).map(item => [item.name, item.status]).sort(),
    [['python-package:pandas', 'resolved'], ['python-package:python-docx', 'resolved'], ['python-runtime', 'resolved']])
  assert.match(root.requirements.find(item => item.name === 'python-package:python-docx')!.evidence, /由 import 识别：docx/)
})

test('a required import the image cannot satisfy makes the plan incompatible; an optional one only warns', () => {
  const missing = planFor(scripted('import sklearn\n'))
  assert.equal(missing.compatibility.status, 'incompatible')
  assert.match(missing.compatibility.issues.map(issue => issue.message).join('\n'), /执行镜像中没有 Python 模块 sklearn（scripts\/run\.py 中 import）/)
  const optional = planFor(scripted('try:\n    import xlrd\nexcept ImportError:\n    xlrd = None\n'))
  assert.equal(optional.compatibility.status, 'needs_review')
  assert.ok(optional.compatibility.issues.some(issue => issue.code === 'python_optional_import_unavailable' && /xlrd/.test(issue.message)))
  // A declared distribution covers its import; nothing is added twice.
  const declared = planFor(scripted('import pandas\n', { 'requirements.txt': 'pandas\n' }))
  assert.deepEqual(declared.packages[0]!.requirements.filter(item => item.name.startsWith('python-package:')).map(item => item.name), ['python-package:pandas'])
  // Without the image's module index imports wait for review instead of passing silently.
  assert.equal(planFor(scripted('import pandas\n'), null).packages[0]!.requirements.find(item => item.name === 'python-import:pandas')?.status, 'needs_review')
})

test('stored versions report what the current image lacks, including undeclared imports', () => {
  const files = [{ path: 'scripts/run.py', content: 'import pandas\nimport sklearn\ntry:\n    import xlrd\nexcept ImportError:\n    pass\n' }]
  const requirements = [{ type: 'external' as const, name: 'python-package:openpyxl', status: 'resolved' as const, evidence: 'requirements.txt' }]
  assert.deepEqual(missingPythonDependencies({ requirements, files, packages: ['pandas'], modules: pythonIndex }), ['openpyxl', '模块 sklearn'])
  assert.deepEqual(missingPythonDependencies({ requirements, files, packages: ['pandas', 'openpyxl'], modules: null }), [], 'without the module index only declared packages are checked')
})

test('import scanning reads Python like the tokenizer: strings, comments, continuations and try blocks', () => {
  const source = [
    '"""Usage: import fake1"""',
    'x = "quoted \\"\\"\\" inside"  # comment with """ quotes',
    'import numpy as np; import pandas as pd',
    'from openpyxl import (', '    Workbook,', '    load_workbook)',
    'import os, \\', '    sys',
    'def main():', '    import docx',
    'if __name__ == "__main__":', '    import yaml',
    'try:', '    import xlrd', 'except ImportError:', '    import xlwt', 'else:', '    pass',
    'import requests',
    "s = '''", 'import fake2', "'''",
  ].join('\n')
  const found = scanPythonImports([{ path: 'scripts/run.py', content: source }, { path: 'references/example.py', content: 'import tensorflow\n' }])
  assert.deepEqual(found.map(item => `${item.module}${item.optional ? '?' : ''}`),
    ['docx', 'numpy', 'openpyxl', 'os', 'pandas', 'requests', 'sys', 'xlrd?', 'xlwt?', 'yaml'],
    'function and __main__ imports are required; only try/except imports are optional; examples and strings are ignored')
})

test('a declared package covers its import even when the names differ, and link checks stay for review', () => {
  const pkg = scripted('import docx\n', { 'requirements.txt': 'python-docx\n' })
  const plan = buildSkillInstallationPlan({ root: pkg, packages: [pkg], edges: [] }, { pythonSandboxAvailable: true, pythonPackages: [], pythonModules: { stdlib: [], modules: {} } })
  assert.deepEqual(plan.compatibility.issues.filter(issue => issue.severity === 'error').map(issue => issue.message), ['test-skill：平台暂不支持依赖：python-package:python-docx'], 'one error for the declared package, none for its import')
  const linked = scripted('import sklearn\n')
  const deferred = buildSkillInstallationPlan({ root: linked, packages: [linked], edges: [] }, { pythonSandboxAvailable: true, pythonPackages: [], pythonModules: { stdlib: [], modules: {} }, deferRuntimeRequirements: true })
  assert.equal(deferred.compatibility.status, 'needs_review')
  assert.deepEqual(missingPythonDependencies({ requirements: [{ type: 'external', name: 'python-package:python-docx', status: 'resolved', evidence: 'requirements.txt' }], files: [{ path: 'scripts/run.py', content: 'import docx\n' }], packages: [], modules: { stdlib: [], modules: {} } }), ['python-docx'])
})

test('CRLF continuations and suites on the header line are scanned too', () => {
  const source = 'import os, \\\r\n    pandas\r\nif x: import yaml\r\ntry: import xlrd\r\nexcept ImportError: import xlwt\r\nd = {1: 2}; import numpy\r\n'
  assert.deepEqual(scanPythonImports([{ path: 'scripts/run.py', content: source }]).map(item => `${item.module}${item.optional ? '?' : ''}`),
    ['numpy', 'os', 'pandas', 'xlrd?', 'xlwt?', 'yaml'])
})
