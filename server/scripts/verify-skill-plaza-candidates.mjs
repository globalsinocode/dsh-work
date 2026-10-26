#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSkillPackage } from '../src/modules/skill/skill-package.ts'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const fixturesRoot = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates')
const zipDir = join(repoRoot, 'dist/skill-plaza-packages')

const source = JSON.parse(await readFile(join(fixturesRoot, 'SOURCE.json'), 'utf8'))
const zipNames = (await readdir(zipDir)).filter(n => n.endsWith('.zip')).sort()
const zipIds = new Set(zipNames.map(n => n.replace(/\.zip$/, '')))
const expectedIds = source.skills.map(s => s.id).sort()

const results = []
let parseFailures = 0

for (const skill of source.skills) {
  const zipPath = join(zipDir, `${skill.id}.zip`)
  let entry = { id: skill.id, repo: skill.repo, sourcePath: skill.sourcePath, parse: 'missing_zip' }
  if (!zipIds.has(skill.id)) {
    parseFailures++
    results.push(entry)
    continue
  }
  try {
    const bytes = new Uint8Array(await readFile(zipPath))
    const pkg = parseSkillPackage(bytes)
    entry = {
      id: skill.id,
      repo: skill.repo,
      sourcePath: skill.sourcePath,
      parse: 'ok',
      skillName: pkg.name,
      compatibility: pkg.compatibility.status,
      toolIds: pkg.toolIds,
      fileCount: pkg.files.length,
      requirements: pkg.requirements.map(r => ({ type: r.type, name: r.name, status: r.status })),
      issues: pkg.compatibility.issues.map(i => i.code),
      publish: false,
      publishBlockers: publishBlockers(pkg, skill),
    }
  } catch (err) {
    parseFailures++
    entry = {
      id: skill.id,
      repo: skill.repo,
      sourcePath: skill.sourcePath,
      parse: 'error',
      error: err instanceof Error ? err.message : String(err),
      publish: false,
      publishBlockers: ['parse_error'],
    }
  }
  results.push(entry)
}

function publishBlockers(pkg, skill) {
  const blockers = []
  if (pkg.compatibility.status === 'incompatible') blockers.push('incompatible')
  if (pkg.compatibility.status === 'needs_review') blockers.push('needs_review')
  if (pkg.files.some(f => f.path.endsWith('.py'))) blockers.push('python_execute')
  if (skill.notes?.license === 'source-available') blockers.push('source_available_license')
  if (skill.repo === 'workbuddy') blockers.push('no_repo_license')
  blockers.push('batch_01_manual_signoff')
  return blockers
}

const allowlist = {
  batch: source.batch,
  generatedAt: new Date().toISOString(),
  defaultPublish: false,
  skills: results.map(r => ({
    id: r.id,
    publish: false,
    parse: r.parse,
    compatibility: r.compatibility ?? null,
    publishBlockers: r.publishBlockers ?? ['missing_zip'],
  })),
}

const reportLines = [
  '# Skill 广场候选校验报告',
  '',
  `- **批次**：\`${source.batch}\``,
  `- **生成时间**：${allowlist.generatedAt}`,
  `- **期望包数**：${expectedIds.length}`,
  `- **ZIP 数**：${zipNames.length}`,
  `- **parse 失败/缺失**：${parseFailures}`,
  '',
  '## 结论',
  '',
  parseFailures === 0 && zipNames.length === expectedIds.length
    ? '全部 ZIP 已通过 `parseSkillPackage` 结构校验。本批次 **未发布**（`PUBLISH-ALLOWLIST.json` 中 `publish` 均为 `false`）。'
    : '存在缺失或 parse 失败项，见下表；**不得发布**直至修复。',
  '',
  '## 试运行说明',
  '',
  '- 含 `.py` 的文档技能需在受控环境执行 `python_execute` 试运行后再考虑发布。',
  '- KWP 技能若引用 Slack/日历等连接器，仅作写作流程使用，不宣称已接通外部系统。',
  '- WorkBuddy 补充包无仓库许可证，发布前需法务确认。',
  '',
  '## 明细',
  '',
  '| id | parse | compatibility | files | blockers |',
  '|----|-------|---------------|-------|----------|',
  ...results.map(r =>
    `| ${r.id} | ${r.parse} | ${r.compatibility ?? '—'} | ${r.fileCount ?? '—'} | ${(r.publishBlockers ?? []).join(', ')} |`,
  ),
  '',
]

await writeFile(join(fixturesRoot, 'PUBLISH-ALLOWLIST.json'), `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8')
await writeFile(join(fixturesRoot, 'VERIFICATION-REPORT.md'), `${reportLines.join('\n')}\n`, 'utf8')

console.log(`wrote PUBLISH-ALLOWLIST.json and VERIFICATION-REPORT.md (${results.length} skills, ${parseFailures} failures)`)
if (parseFailures || zipNames.length !== expectedIds.length) process.exit(1)
