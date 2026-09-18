import type { CreateSkillInput, PublishStatus, UpdateSkillInput } from '../../domain/types.ts'
import type { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerSkillRoutes(router: Router, service: PostgresSkillService) {
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills(), 'postgres'))
  router.get(`${basePath}/skill-versions`, async () => envelope('admin', await service.getSkillVersions(), 'postgres'))
  router.get(`${basePath}/skill-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/skills`, async (request, context) => {
    const input = await readJsonBody<Omit<CreateSkillInput, 'actor'>>(request)
    return httpResult(201, envelope('admin', await service.createSkill({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres'))
  })
  router.patch(`${basePath}/skills`, async (request, context) => {
    const input = await readJsonBody<Omit<UpdateSkillInput, 'actor'>>(request)
    return envelope('admin', await service.updateSkill({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
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
  router.post(`${basePath}/skills/rollback`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; version: string }>(request)
    return envelope('admin', await service.rollback({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
