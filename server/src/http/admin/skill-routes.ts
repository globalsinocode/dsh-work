import type { PublishStatus, SkillDefinition } from '../../domain/types.ts'
import type { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import type { BuiltinSkillStatus } from '../../modules/skill/builtin-skills.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerSkillRoutes(router: Router, service: PostgresSkillService, builtinSkillStatus: () => Promise<BuiltinSkillStatus>) {
  router.get(`${basePath}/skills`, async (_request, context) => {
    const skills = await service.getSkills()
    // 只凭 Agent 修改权限读取时（功能规则第 13 节）只返回选择器需要的字段，不含 Skill 正文。
    return envelope('admin', context.adminView === 'selector' ? skills.map(skillSelectorView) : skills, 'postgres')
  })
  // 平台内置 Skill 随代码发布，只读展示；可改的只有已安装 Skill 的覆盖场景与 Runtime 紧急停用。
  router.get(`${basePath}/skills/builtin`, async (_request, context) => {
    const status = await builtinSkillStatus()
    // 选择器视图不含内置 Skill 正文与文件清单（功能规则第 13 节）。
    return envelope('admin', context.adminView === 'selector'
      ? { ...status, skills: status.skills.map(({ instructions: _instructions, files: _files, ...skill }) => skill) }
      : status, 'postgres')
  })
  router.patch(`${basePath}/skills/builtin-coverage`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; scenarios: unknown }>(request)
    return envelope('admin', await service.setCoveredBuiltinScenarios({
      skillId: input.skillId,
      scenarios: input.scenarios,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.put(`${basePath}/skills/:skillId/visibility`, async (request, context) => {
    const input = await readJsonBody<{ roleIds: unknown; reason: unknown }>(request)
    return envelope('admin', await service.setVisibleRoles({
      skillId: context.params['skillId'] ?? '',
      roleIds: input.roleIds,
      reason: input.reason,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.get(`${basePath}/skill-versions`, async () => envelope('admin', await service.getSkillVersions(), 'postgres'))
  router.get(`${basePath}/skill-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/skills/test`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; prompt?: string; scenario?: unknown }>(request)
    return envelope('admin', await service.testSkill({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/skills/test-runs`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; prompt?: string; scenario?: unknown }>(request)
    return httpResult(202, envelope('admin', await service.startSkillTest({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres'))
  })
  router.get(`${basePath}/skills/:skillId/test-runs/:runId`, async (_request, context) => {
    return envelope('admin', await service.getSkillTestProgress({
      skillId: context.params['skillId']!,
      runId: context.params['runId']!,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/skills/status`, async (request, context) => {
    const input = await readJsonBody<{
      skillId: string
      status: Extract<PublishStatus, 'published' | 'disabled'>
    }>(request)
    return envelope('admin', await service.setStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/skills/:skillId/draft/discard`, async (_request, context) => {
    return envelope('admin', await service.discardDraft({
      skillId: context.params['skillId'] ?? '',
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/skills/rollback`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; version: string }>(request)
    return envelope('admin', await service.rollback({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}

function skillSelectorView(skill: SkillDefinition) {
  const { id, name, version, activeVersion, category, status, description, toolIds, visibleRoleIds, installationRole, dependencies, updatedAt } = skill
  return { id, name, version, activeVersion, category, status, description, toolIds, visibleRoleIds, installationRole, dependencies, updatedAt }
}
