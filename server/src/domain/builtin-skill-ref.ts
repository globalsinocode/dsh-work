// 平台内置 Skill 的 ID 前缀（builtin-skills-plan 5.1）。已安装 Skill 的 ID 由平台生成为 `skill-…`，
// 不会使用该前缀；Manifest 编译器、执行前复核与 Skill 模块据此区分内置 Skill，口径一致。
export const BUILTIN_SKILL_ID_PREFIX = 'dsh-work-'

export function isBuiltinSkillReference(reference: string): boolean {
  return reference.startsWith(BUILTIN_SKILL_ID_PREFIX)
}

/**
 * 执行前复核从 Manifest 重建附加 Skill 时只取已安装 Skill：内置 Skill 由平台提供，
 * 不进入 Agent 依赖闭包与空间能力授权（builtin-skills-plan 5.3）。
 */
export function installedSkillReferences(skills: ReadonlyArray<{ id: string; version: string }> | undefined): string[] {
  return (skills ?? []).filter(skill => !isBuiltinSkillReference(skill.id)).map(skill => `${skill.id}@${skill.version}`)
}
