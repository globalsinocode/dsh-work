import type { SkillSubmissionService } from '../../modules/skill/skill-submission-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Skill 创建专家方案 4.3：员工在草稿卡片上提交审核、撤回、预览文件。只操作本人的提交；
 * 提交只能由员工在界面上发起（SC2），模型没有对应工具。
 */
export function registerSkillSubmissionRoutes(router: Router, submissions: SkillSubmissionService) {
  router.post(`${basePath}/skill-submissions/:submissionId/submit`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<{ versionId?: unknown }>(request)
    if (typeof body.versionId !== 'string' || !body.versionId) throw routeValidationFailed('versionId 必须是非空字符串')
    return envelope('workbench', await submissions.submit(identity.userId, context.params['submissionId'] ?? '', body.versionId), 'postgres')
  })
  router.post(`${basePath}/skill-submissions/:submissionId/withdraw`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await submissions.withdraw(identity.userId, context.params['submissionId'] ?? ''), 'postgres')
  })
  router.get(`${basePath}/skill-submissions/:submissionId/versions/:versionId/file`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const path = context.url.searchParams.get('path') ?? 'SKILL.md'
    return envelope('workbench', await submissions.readVersionFile(
      identity.userId, context.params['submissionId'] ?? '', context.params['versionId'] ?? '', path,
    ), 'postgres')
  })
}
