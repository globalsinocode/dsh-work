#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPROVED_AT,
  BATCH,
  KWP_PLUGINS,
  KWP_SKIP_SKILL_NAME,
  REPOS,
  kwpSkillEntry,
  staticSkillEntries,
} from './skill-plaza-manifest.mjs'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const outPath = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/SOURCE.json')

async function listKwpSkillDirs(plugin) {
  const { owner, name, commit } = REPOS.kwp
  const treePath = `${plugin}/skills`
  const url = `https://api.github.com/repos/${owner}/${name}/git/trees/${commit}:${treePath}?recursive=1`
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-work-skill-plaza' } })
  if (!res.ok) throw new Error(`KWP tree ${treePath}: ${res.status} ${await res.text()}`)
  const body = await res.json()
  const dirs = new Set()
  for (const item of body.tree ?? []) {
    if (item.type !== 'blob') continue
    const rel = item.path.replace(new RegExp(`^${treePath}/`), '')
    const m = rel.match(/^([^/]+)\/SKILL\.md$/i)
    if (!m) continue
    const skillDir = m[1]
    if (KWP_SKIP_SKILL_NAME.test(skillDir)) continue
    dirs.add(skillDir)
  }
  return [...dirs].sort()
}

const skills = [...staticSkillEntries()]
for (const plugin of KWP_PLUGINS) {
  const dirs = await listKwpSkillDirs(plugin)
  for (const dir of dirs) {
    skills.push(kwpSkillEntry(plugin, dir))
  }
}

const doc = {
  batch: BATCH,
  approvedAt: APPROVED_AT,
  fixturesRelative: 'docs/development/fixtures/skill-plaza-candidates/packages',
  zipOutputRelative: 'dist/skill-plaza-packages',
  skillCount: skills.length,
  repos: REPOS,
  kwp: { plugins: KWP_PLUGINS, skipSkillNamePattern: KWP_SKIP_SKILL_NAME.source },
  skills,
}

await writeFile(outPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`wrote ${outPath} (${skills.length} skills)`)
