/**
 * activate_skill 的名称解析。
 *
 * 目录行写作“名称（id@版本）”，模型常把括号里的 `id@版本`、整行或去掉“（平台内置）”的名称当作 name 传入。
 * 先按名称或 id 精确匹配；没有唯一结果时，再把上述写法规范化（全角转半角、去空白与引号、不区分大小写）后匹配。
 * 带版本的写法只匹配本次 Run 锁定的版本。两种方式都必须恰好命中一个 Skill。
 */

export interface ActivatableSkill {
  readonly id: string
  readonly name?: string | undefined
  readonly version: string
}

const builtinSuffix = normalize('（平台内置）')

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '').replace(/\s+/g, '').toLowerCase()
}

function aliases(skill: ActivatableSkill): Set<string> {
  const name = skill.name ?? skill.id
  const pinned = `${skill.id}@${skill.version}`
  const forms = [name, skill.id, pinned, `${name}（${pinned}）`].map(normalize)
  const bareName = forms[0]!
  if (bareName.endsWith(builtinSuffix) && bareName.length > builtinSuffix.length) forms.push(bareName.slice(0, -builtinSuffix.length))
  return new Set(forms)
}

export function resolveSkillActivationTarget<T extends ActivatableSkill>(skills: readonly T[], requested: string): T | undefined {
  const exact = requested.trim()
  if (!exact) return undefined
  const exactMatches = skills.filter(skill => (skill.name ?? skill.id) === exact || skill.id === exact)
  if (exactMatches.length === 1) return exactMatches[0]
  if (exactMatches.length > 1) return undefined
  const key = normalize(exact)
  const matches = skills.filter(skill => aliases(skill).has(key))
  return matches.length === 1 ? matches[0] : undefined
}

/** 失败时列出可传入的名称，便于模型改用目录中的写法重试。 */
export function describeActivatableSkills(skills: readonly ActivatableSkill[]): string {
  return skills.map(skill => `${skill.name ?? skill.id}（${skill.id}）`).join('、')
}
