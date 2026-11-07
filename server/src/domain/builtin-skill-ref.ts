// 平台内置 Skill 的 ID 前缀（builtin-skills-plan 5.1）。已安装 Skill 的 ID 由平台生成为 `skill-…`，
// 不会使用该前缀；Manifest 编译器、执行前复核与 Skill 模块据此区分内置 Skill，口径一致。
export const BUILTIN_SKILL_ID_PREFIX = 'dsh-work-'

export function isBuiltinSkillReference(reference: string): boolean {
  return reference.startsWith(BUILTIN_SKILL_ID_PREFIX)
}

/** 内置 Skill 注册表：只认注册表中的 ID 与版本锁登记过的版本。 */
export type KnownBuiltinSkill = (id: string, version: string) => boolean

/**
 * 执行前复核从 Manifest 重建附加 Skill 时只取已安装 Skill：内置 Skill 由平台提供，
 * 不进入 Agent 依赖闭包与空间能力授权（builtin-skills-plan 5.3）。
 * 只有注册表确认的内置 Skill 才跳过复核；前缀相同但不在注册表中的引用照常复核（fail-closed），
 * 未接线注册表时不认任何内置 Skill。
 */
export function installedSkillReferences(
  skills: ReadonlyArray<{ id: string; version: string }> | undefined,
  knownBuiltin?: KnownBuiltinSkill,
): string[] {
  return (skills ?? [])
    .filter(skill => !(isBuiltinSkillReference(skill.id) && knownBuiltin?.(skill.id, skill.version)))
    .map(skill => `${skill.id}@${skill.version}`)
}
