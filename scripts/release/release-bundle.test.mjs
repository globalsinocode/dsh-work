import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { missingBundleFiles, serverConfigFiles, uncoveredConfigFiles } from './release-bundle.mjs'

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-release-bundle-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const config = {
  'server/config/dsh/runtime-lock.json': '{}',
  'server/config/dsh/dsh-work-tool-policy.test.js': '',
  'server/config/builtin-skills/file-analysis/SKILL.md': '',
  'server/config/agent-presets/skill-creator/preset.json': '{}',
  'server/config/agent-presets/skill-creator/SOUL.md': '',
  'server/config/dsh/.DS_Store': '',
}

test('server config files exclude tests and hidden files', () => {
  const root = fixture(config)
  try {
    assert.deepEqual(serverConfigFiles(root), [
      'server/config/agent-presets/skill-creator/SOUL.md',
      'server/config/agent-presets/skill-creator/preset.json',
      'server/config/builtin-skills/file-analysis/SKILL.md',
      'server/config/dsh/runtime-lock.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a config directory the release script does not copy is reported (v2026.11.02-01 missed agent-presets)', () => {
  const root = fixture({
    ...config,
    'scripts/release/build-release.sh': [
      'cp "${project_root}/server/config/dsh/runtime-lock.json" "${bundle}/server/config/dsh/"',
      'cp -R "${project_root}/server/config/builtin-skills" "${bundle}/server/config/builtin-skills"',
    ].join('\n'),
  })
  try {
    assert.deepEqual(uncoveredConfigFiles(root), [
      'server/config/agent-presets/skill-creator/SOUL.md',
      'server/config/agent-presets/skill-creator/preset.json',
    ])
    writeFileSync(join(root, 'scripts/release/build-release.sh'), [
      'cp "${project_root}/server/config/dsh/runtime-lock.json" "${bundle}/server/config/dsh/"',
      'cp -R "${project_root}/server/config/builtin-skills" "${bundle}/server/config/builtin-skills"',
      'cp -R "${project_root}/server/config/agent-presets" "${bundle}/server/config/agent-presets"',
    ].join('\n'))
    assert.deepEqual(uncoveredConfigFiles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a commented-out copy line does not count as covered', () => {
  const root = fixture({
    ...config,
    'scripts/release/build-release.sh': [
      'cp "${project_root}/server/config/dsh/runtime-lock.json" "${bundle}/server/config/dsh/"',
      'cp -R "${project_root}/server/config/builtin-skills" "${bundle}/server/config/builtin-skills"',
      '# cp -R "${project_root}/server/config/agent-presets" "${bundle}/server/config/agent-presets"',
    ].join('\n'),
  })
  try {
    assert.equal(uncoveredConfigFiles(root).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the bundle check lists config files missing from a built bundle', () => {
  const root = fixture(config)
  const bundle = fixture({ 'server/config/dsh/runtime-lock.json': '{}', 'server/config/builtin-skills/file-analysis/SKILL.md': '' })
  try {
    assert.deepEqual(missingBundleFiles(root, bundle), [
      'server/config/agent-presets/skill-creator/SOUL.md',
      'server/config/agent-presets/skill-creator/preset.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(bundle, { recursive: true, force: true })
  }
})

test('the repository release script covers every server config file', () => {
  assert.deepEqual(uncoveredConfigFiles(join(import.meta.dirname, '../..')), [])
})
