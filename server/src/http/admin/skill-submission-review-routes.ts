import type { SkillSubmissionReviewService } from '../../modules/skill/skill-submission-review-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

/**
 * Skill 创建专家方案 4.4：平台管理员审核员工 Skill 提交。读接口要求管理读权限，写接口由服务再核对平台管理员；
 * 试运行由管理员在详情中发起并记在其名下，通过时沿用现有发布门禁。
 */
export function registerSkillSubmissionReviewRoutes(router: Router, reviews: SkillSubmissionReviewService) {
  router.get(`${basePath}/skill-submissions`, async () => envelope('admin', await reviews.listPending(), 'postgres'))
  router.get(`${basePath}/skill-submissions/:submissionId`, async (_request, context) => {
    return envelope('admin', await reviews.getDetail(context.params['submissionId'] ?? ''), 'postgres')
  })
  router.get(`${basePath}/skill-submissions/:submissionId/versions/:versionId/file`, async (_request, context) => {
    const path = context.url.searchParams.get('path') ?? 'SKILL.md'
    return envelope('admin', await reviews.readVersionFile(
      context.params['submissionId'] ?? '', context.params['versionId'] ?? '', path,
    ), 'postgres')
  })
  router.post(`${basePath}/skill-submissions/:submissionId/test-runs`, async (request, context) => {
    const body = await readJsonBody<{ versionId?: unknown }>(request)
    if (typeof body.versionId !== 'string' || !body.versionId) throw routeValidationFailed('versionId 必须是非空字符串')
    return httpResult(202, envelope('admin', await reviews.startTrial(
      requireRequestIdentity(context, 'admin').userId, context.params['submissionId'] ?? '', body.versionId,
    ), 'postgres'))
  })
  router.get(`${basePath}/skill-submissions/:submissionId/test-runs/:runId`, async (_request, context) => {
    return envelope('admin', await reviews.getTrialProgress(
      requireRequestIdentity(context, 'admin').userId, context.params['submissionId'] ?? '', context.params['runId'] ?? '',
    ), 'postgres')
  })
  router.post(`${basePath}/skill-submissions/:submissionId/approve`, async (request, context) => {
    const body = await readJsonBody<{ versionId?: unknown; visibleRoleIds?: unknown }>(request)
    return envelope('admin', await reviews.approve(requireRequestIdentity(context, 'admin').userId, context.params['submissionId'] ?? '', body), 'postgres')
  })
  router.post(`${basePath}/skill-submissions/:submissionId/reject`, async (request, context) => {
    const body = await readJsonBody<{ versionId?: unknown; note?: unknown }>(request)
    return envelope('admin', await reviews.reject(requireRequestIdentity(context, 'admin').userId, context.params['submissionId'] ?? '', body), 'postgres')
  })
}
