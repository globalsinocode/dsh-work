#!/usr/bin/env node
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const fixturesRoot = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates')
const packagesRoot = join(fixturesRoot, 'packages')
const superpowersCache = join(fixturesRoot, '.cache/repos/obra__superpowers')

const ANTH_WITH_OFFICE_SCHEMAS = new Set(['plaza-anth-docx', 'plaza-anth-pptx', 'plaza-anth-xlsx'])
const WB_TOOL_PATCH = new Set(['plaza-wb-deep-research', 'plaza-wb-excalidraw-diagram', 'plaza-wb-fbs-bookwriter'])

const SDD_SCRIPT_NAMES = ['task-brief', 'sdd-workspace', 'review-package']

const BOOKWRITER_STUB = `---
name: fbs-bookwriter
description: "广场精简版：福帮手长文档工作流摘要（完整包见 WorkBuddy 市场）。书籍、手册、白皮书与长篇报道的结构化写作与分层审校指引。"
version: 2.1.2-plaza-stub
allowed-tools: Read, Glob, Grep
---

# FBS BookWriter（广场精简版）

本包为 **Skill 广场待验证草稿**，仅保留核心工作流说明，不含原参考文件树与构建脚本。

## 适用场景

书籍、手册、白皮书、行业指南、长篇报道与深度专题。

## 推荐流程

1. 澄清目标读者、体裁、篇幅与交付格式（MD/HTML）。
2. 产出大纲与章节分工，确认后逐章撰写。
3. 分层审校：结构 → 事实 → 文风 → 排版。
4. 导出前做中文排版与引用检查。

## 完整能力

生产环境请使用原 WorkBuddy \`fbs-bookwriter\` 技能包。本广场版用于流程预览与 \`parseSkillPackage\` 合规校验。
`

export async function refreshPlazaMeta(outDir) {
  const files = []
  async function walk(dir, prefix = '') {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const full = join(dir, ent.name)
      if (ent.isDirectory()) await walk(full, rel)
      else files.push(rel)
    }
  }
  await walk(outDir)
  files.sort()
  const metaPath = join(outDir, '.plaza-source.json')
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  meta.files = files
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

function normalizeAllowedTools(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return markdown
  let yaml = match[1]
  // Block list form and scalar lines; last key may lack trailing newline before closing ---
  yaml = yaml.replace(/^allowed-tools:\s*\n(?:[ \t]+-\s+.+\n)+/gm, '')
  yaml = yaml.replace(/^allowed-tools:.*(?:\r?\n|$)/gm, '')
  yaml = `${yaml.trimEnd()}\nallowed-tools: Read, Glob, Grep\n`
  return markdown.replace(match[0], `---\n${yaml}\n---`)
}

async function firstExisting(paths) {
  for (const p of paths) {
    try {
      await access(p)
      return p
    } catch {
      /* next */
    }
  }
  return null
}

async function postProcessExecutingPlans(outDir) {
  const scriptsDir = join(outDir, 'scripts')
  await mkdir(scriptsDir, { recursive: true })
  const sddSource = join(superpowersCache, 'skills/subagent-driven-development/scripts')
  for (const name of SDD_SCRIPT_NAMES) {
    await copyFile(join(sddSource, name), join(scriptsDir, name))
  }
  const reviewerSrc = await firstExisting([
    join(packagesRoot, 'plaza-sp-requesting-code-review/code-reviewer.md'),
    join(superpowersCache, 'skills/requesting-code-review/code-reviewer.md'),
  ])
  if (reviewerSrc) {
    await mkdir(join(outDir, 'references'), { recursive: true })
    await copyFile(reviewerSrc, join(outDir, 'references/code-reviewer.md'))
  }
  for (const scriptName of ['task-start', 'task-done']) {
    const scriptPath = join(scriptsDir, scriptName)
    try {
      await access(scriptPath)
    } catch {
      continue
    }
    let text = await readFile(scriptPath, 'utf8')
    text = text.replace(
      'sdd="$(cd "$(dirname "$0")/../../subagent-driven-development/scripts" && pwd)"',
      'sdd="$(cd "$(dirname "$0")" && pwd)"',
    )
    await writeFile(scriptPath, text)
  }
  let skill = await readFile(join(outDir, 'SKILL.md'), 'utf8')
  skill = skill.replaceAll('../subagent-driven-development/scripts/', 'scripts/')
  await writeFile(join(outDir, 'SKILL.md'), skill)
}

async function postProcessAnthOffice(outDir) {
  await rm(join(outDir, 'scripts/office/schemas'), { recursive: true, force: true })
}

async function postProcessBookwriterStub(outDir) {
  for (const ent of await readdir(outDir, { withFileTypes: true })) {
    if (ent.name === '.plaza-source.json') continue
    const full = join(outDir, ent.name)
    if (ent.isDirectory()) await rm(full, { recursive: true, force: true })
    else await rm(full, { force: true })
  }
  await writeFile(join(outDir, 'SKILL.md'), BOOKWRITER_STUB)
}

export async function postProcessSkillPackage(skillId, outDir) {
  try {
    await access(join(outDir, 'SKILL.md'))
  } catch {
    return
  }
  if (skillId === 'plaza-sp-executing-plans') {
    await postProcessExecutingPlans(outDir)
  }
  if (ANTH_WITH_OFFICE_SCHEMAS.has(skillId)) {
    await postProcessAnthOffice(outDir)
  }
  if (skillId === 'plaza-wb-fbs-bookwriter') {
    await postProcessBookwriterStub(outDir)
  } else if (WB_TOOL_PATCH.has(skillId)) {
    const skill = normalizeAllowedTools(await readFile(join(outDir, 'SKILL.md'), 'utf8'))
    await writeFile(join(outDir, 'SKILL.md'), skill)
  }
  await refreshPlazaMeta(outDir)
}

export async function postProcessAllPackages(skillIds) {
  for (const id of skillIds) {
    await postProcessSkillPackage(id, join(packagesRoot, id))
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const source = JSON.parse(await readFile(join(fixturesRoot, 'SOURCE.json'), 'utf8'))
  const ids = source.skills.map(s => s.id)
  console.log(`postprocess ${ids.length} packages…`)
  for (const id of ids) {
    await postProcessSkillPackage(id, join(packagesRoot, id))
    console.log(`  ${id}`)
  }
}
