/** @typedef {{ id: string; repo: keyof typeof REPOS; sourcePath: string; notes?: string }} SkillEntry */

export const BATCH = 'batch-01'
export const APPROVED_AT = '2026-10-15'

export const REPOS = {
  superpowers: {
    owner: 'obra',
    name: 'superpowers',
    commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3',
    license: 'MIT',
  },
  skills: {
    owner: 'anthropics',
    name: 'skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    license: 'mixed (doc skills: source-available)',
  },
  kwp: {
    owner: 'anthropics',
    name: 'knowledge-work-plugins',
    commit: 'e6b505348c39c6e751a70d52ff407e7b0a6bf676',
    license: 'Apache-2.0',
  },
  workbuddy: {
    owner: 'infometa',
    name: 'workbuddyskills',
    commit: 'ccbc6809c9c10c0fdcd33c3eccd3a2424cdb926e',
    license: 'none (repository)',
  },
}

/** Skill folder names under `plugins/<plugin>/skills/` to skip (connector / external account). */
export const KWP_SKIP_SKILL_NAME =
  /(?:^|\/)(?:crm|slack|calendar|gmail|outlook|hubspot|salesforce|inbox-sync|route-lead|schedule-meeting|meeting-prep|email-draft|email-triage)(?:\/|$)/i

export const KWP_PLUGINS = [
  'finance',
  'legal',
  'product-management',
  'operations',
  'sales',
  'customer-support',
  'productivity',
  'human-resources',
]

const SUPER_SKILLS = [
  'writing-plans',
  'executing-plans',
  'systematic-debugging',
  'test-driven-development',
  'requesting-code-review',
  'receiving-code-review',
  'verification-before-completion',
  'brainstorming',
  'finishing-a-development-branch',
]

const ANTH_SKILLS = ['docx', 'pdf', 'pptx', 'xlsx', 'doc-coauthoring', 'internal-comms']

const WB_SKILLS = ['deep-research', 'excalidraw-diagram', 'fbs-bookwriter']

/** @returns {SkillEntry[]} */
export function staticSkillEntries() {
  const out = []
  for (const name of SUPER_SKILLS) {
    out.push({ id: `plaza-sp-${name}`, repo: 'superpowers', sourcePath: `skills/${name}` })
  }
  for (const name of ANTH_SKILLS) {
    out.push({
      id: `plaza-anth-${name}`,
      repo: 'skills',
      sourcePath: `skills/${name}`,
      ...(name === 'docx' || name === 'pdf' || name === 'pptx' || name === 'xlsx'
        ? { notes: 'source-available; may require python_execute after import' }
        : {}),
    })
  }
  for (const name of WB_SKILLS) {
    out.push({ id: `plaza-wb-${name}`, repo: 'workbuddy', sourcePath: `skills/${name}` })
  }
  return out
}

/** @param {string} plugin @param {string} skillDir */
export function kwpSkillEntry(plugin, skillDir) {
  const slug = skillDir.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  return {
    id: `plaza-kwp-${plugin}-${slug}`,
    repo: 'kwp',
    sourcePath: `${plugin}/skills/${skillDir}`,
    notes: 'knowledge-work-plugin; treat Slack/calendar connectors as writing-only on this platform',
  }
}

export const ALLOWED_RELATIVE =
  /(?:\.(?:md|txt|json|ya?ml|csv|toml|py)|(?:^|\/)LICENSE(?:\.txt)?|(?:^|\/)scripts\/[A-Za-z0-9._/-]+)$/i

export function isAllowedRelativePath(relative) {
  if (!relative || relative.includes('..')) return false
  return ALLOWED_RELATIVE.test(relative)
}
