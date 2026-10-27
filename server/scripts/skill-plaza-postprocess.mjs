#!/usr/bin/env node
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const fixturesRoot = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates')
const packagesRoot = join(fixturesRoot, 'packages')
const superpowersCache = join(fixturesRoot, '.cache/repos/obra__superpowers')

const ANTH_WITH_OFFICE_SCHEMAS = new Set(['plaza-anth-pptx', 'plaza-anth-xlsx'])

const SDD_SCRIPT_NAMES = ['task-brief', 'sdd-workspace', 'review-package']

/** Avoid false `scripts/…` / `assets/…` path matches inside upstream prose (e.g. `transcripts/docs`). */
function sanitizePlazaSkillReferenceFalsePositives(markdown, skillId) {
  let text = markdown
    .replace(/subscripts\/superscripts/g, 'subscripts and superscripts')
    .replace(/transcripts\/threads/gi, 'transcripts and threads')
    .replace(/transcripts\/notes/gi, 'transcripts and notes')
    .replace(/transcripts\/chat/gi, 'transcripts and chat')
    .replace(/transcripts\/docs/gi, 'transcripts and docs')
    .replace(/transcripts\//gi, 'transcripts, ')
    .replace(/crm\/transcripts/gi, 'crm and transcripts')
    .replace(/crm\/email/gi, 'crm and email')
    .replace(/docs\/crm/gi, 'docs and crm')
    .replace(/docs\/email/gi, 'docs and email')
    .replace(/email\/transcripts/gi, 'email and transcripts')
  if (skillId === 'plaza-sp-executing-plans') {
    text = text.replace(/`scripts\/review-package/g, '`references/code-reviewer.md')
    text = text.replace(/scripts\/review-package/g, 'references/code-reviewer.md')
  }
  return text
}

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
  await normalizeExecutingPlanScriptFiles(outDir)
}

/** Plaza parser only accepts documented text extensions; shell helpers ship as `.txt` stubs. */
async function normalizeExecutingPlanScriptFiles(outDir) {
  const names = ['sdd-workspace', 'task-start', 'task-done', 'task-brief', 'review-package']
  let skill = await readFile(join(outDir, 'SKILL.md'), 'utf8')
  for (const name of names) {
    const scriptPath = join(outDir, 'scripts', name)
    try {
      await access(scriptPath)
    } catch {
      continue
    }
    const body = await readFile(scriptPath, 'utf8')
    await writeFile(join(outDir, 'scripts', `${name}.txt`), body)
    await rm(scriptPath, { force: true })
    skill = skill.replaceAll(new RegExp(`scripts/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\.txt)`, 'g'), `scripts/${name}.txt`)
  }
  skill = skill.replaceAll(/\.txt\.txt/g, '.txt')
  await writeFile(join(outDir, 'SKILL.md'), skill)
}

async function postProcessAnthOffice(outDir) {
  await rm(join(outDir, 'scripts/office/schemas'), { recursive: true, force: true })
}

export async function postProcessSkillPackage(skillId, outDir) {
  try {
    await access(join(outDir, 'SKILL.md'))
  } catch {
    return
  }
  const skillPath = join(outDir, 'SKILL.md')
  const sanitized = sanitizePlazaSkillReferenceFalsePositives(await readFile(skillPath, 'utf8'), skillId)
  await writeFile(skillPath, sanitized)
  if (skillId === 'plaza-sp-executing-plans') {
    await postProcessExecutingPlans(outDir)
  }
  if (ANTH_WITH_OFFICE_SCHEMAS.has(skillId)) {
    await postProcessAnthOffice(outDir)
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
