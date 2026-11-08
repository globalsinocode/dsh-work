import type { PublishStatus, SkillDefinition, SkillReleaseRecord, SkillVersionRecord } from '../../domain/types.ts'
import type { AdminQueryService } from './admin-query-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../../http/router.ts'
import { notFound } from '../../domain/request-errors.ts'

const basePath = '/api/admin/v1'

export function registerAdminRoutes(router: Router, service: AdminQueryService) {
  router.get(`${basePath}/session`, async (_request, context) => envelope(
    'admin',
    context.identity
      ? {
          user: context.identity.profile,
          identityProvider: context.identity.identityProvider,
          apiAudience: 'admin' as const,
          permissions: [...context.identity.permissions],
        }
      : await service.getSession(),
  ))
  router.get(`${basePath}/tasks`, async () => envelope('admin', await service.getTaskSummaries()))
  router.get(`${basePath}/runtimes`, async () => envelope('admin', await service.getRuntimes()))
  router.post(`${basePath}/runtimes/check`, async (request, context) => {
    const input = await readJsonBody<{ runtimeId: string }>(request)
    return envelope('admin', await service.checkRuntime({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/runtimes/configuration`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['updateRuntimeConfiguration']>[0], 'actor'>>(request)
    return envelope('admin', await service.updateRuntimeConfiguration({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/sessions`, async (_request, context) => envelope('admin', await service.getSessions({
    query: context.url.searchParams.get('query') ?? undefined,
    status: context.url.searchParams.get('status') ?? undefined,
    workspace: context.url.searchParams.get('workspace') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  })))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces()))
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents()))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions()))
  router.post(`${basePath}/agents`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['createAgentDraft']>[0], 'actor'>>(request)
    return envelope('admin', await service.createAgentDraft({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/agents/:agentId/draft`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['updateAgentDraft']>[0], 'actor' | 'agentId'>>(request)
    return envelope('admin', await service.updateAgentDraft({
      ...input, agentId: context.params.agentId ?? '', actor: requireRequestIdentity(context, 'admin').userId,
    }))
  })
  router.patch(`${basePath}/agents/:agentId/status`, async (request, context) => {
    const input = await readJsonBody<{ status: Extract<PublishStatus, 'published' | 'disabled'> }>(request)
    return envelope('admin', await service.setAgentStatus({
      status: input.status, agentId: context.params.agentId ?? '', actor: requireRequestIdentity(context, 'admin').userId,
    }))
  })
  router.post(`${basePath}/agents/:agentId/rollback`, async (request, context) => {
    const input = await readJsonBody<{ version: string }>(request)
    return envelope('admin', await service.rollbackAgent({
      version: input.version, agentId: context.params.agentId ?? '', actor: requireRequestIdentity(context, 'admin').userId,
    }))
  })
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills()))
  router.get(`${basePath}/skills/builtin`, async () => envelope('admin', await service.getBuiltinSkillStatus()))
  router.patch(`${basePath}/skills/builtin-coverage`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; scenarios: unknown }>(request)
    return envelope('admin', await service.setCoveredBuiltinScenarios({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  // 冒烟只提供 Skill 可见范围选择所需的角色清单（与冒烟 Agent 的 roleIds 一致），不提供身份管理。
  router.get(`${basePath}/identity/roles`, async () => envelope('admin', [
    { id: 'role-employee', code: 'employee', name: '员工', description: '', status: 'active', permissions: [], dataScopes: [], userCount: 12, system: true, updatedAt: '2026-08-27 17:42' },
    { id: 'role-supply', code: 'supply', name: '供应链', description: '', status: 'active', permissions: [], dataScopes: [], userCount: 4, system: false, updatedAt: '2026-08-27 17:42' },
    { id: 'role-manager', code: 'manager', name: '经理', description: '', status: 'active', permissions: [], dataScopes: [], userCount: 2, system: false, updatedAt: '2026-08-27 17:42' },
  ]))
  router.put(`${basePath}/skills/:skillId/visibility`, async (request, context) => {
    const input = await readJsonBody<{ roleIds: unknown; reason: unknown }>(request)
    return envelope('admin', await service.setVisibleRoles({
      skillId: context.params['skillId'] ?? '', roleIds: input.roleIds, reason: input.reason,
      actor: requireRequestIdentity(context, 'admin').userId,
    }))
  })
  // 冒烟只提供待审核的只读展示（Skill 创建专家方案 4.4）：试运行、通过与拒绝走真实服务，由 P1 覆盖。
  router.get(`${basePath}/skill-submissions`, async () => envelope('admin', [smokeSkillSubmission()]))
  router.get(`${basePath}/skill-submissions/:submissionId`, async (_request, context) => {
    if (context.params['submissionId'] !== SMOKE_SUBMISSION_ID) throw notFound('提交不存在或已撤回')
    return envelope('admin', {
      ...smokeSkillSubmission(),
      files: [{ path: 'SKILL.md', size: 186, script: false }, { path: 'scripts/report.py', size: 64, script: true }],
      compatibility: { status: 'compatible', issues: [] },
    })
  })
  router.get(`${basePath}/skill-submissions/:submissionId/versions/:versionId/file`, async (_request, context) => {
    if (context.params['submissionId'] !== SMOKE_SUBMISSION_ID) throw notFound('提交不存在或已撤回')
    const path = context.url.searchParams.get('path') ?? 'SKILL.md'
    const content = path === 'scripts/report.py'
      ? 'import openpyxl\n\nprint("按区域汇总销售日报")\n'
      : '---\nname: 周报汇总\ndescription: 每周把销售日报汇总成周报。\n---\n\n按区域汇总员工上传的一周销售日报，运行 scripts/report.py 计算环比并写一段结论。\n'
    return envelope('admin', { path, size: content.length, content })
  })
  router.get(`${basePath}/skill-versions`, async () => envelope(
    'admin',
    (await service.getSkills()).map(prototypeSkillVersion),
  ))
  router.get(`${basePath}/skill-release-records`, async () => envelope('admin', []))
  router.post(`${basePath}/skills`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['createSkill']>[0], 'actor'>>(request)
    const skill = await service.createSkill({ ...input, actor: requireRequestIdentity(context, 'admin').userId })
    return envelope('admin', { skill, version: prototypeSkillVersion(skill) })
  })
  router.patch(`${basePath}/skills`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['updateSkill']>[0], 'actor'>>(request)
    const skill = await service.updateSkill({ ...input, actor: requireRequestIdentity(context, 'admin').userId })
    return envelope('admin', { skill, version: prototypeSkillVersion(skill) })
  })
  router.post(`${basePath}/skills/test`, async (request) => {
    const input = await readJsonBody<{ skillId: string; prompt?: string }>(request)
    const skill = (await service.getSkills()).find(item => item.id === input.skillId)
    if (!skill) throw notFound(`Skill 不存在：${input.skillId}`)
    return envelope('admin', {
      id: `skill-test-${Date.now()}`,
      skillId: skill.id,
      version: skill.version,
      status: 'passed',
      resultSummary: `配置校验通过：${skill.toolIds.length} 个工具引用。`,
      testedAt: new Date().toISOString(),
    })
  })
  router.post(`${basePath}/skills/test-runs`, async (request) => {
    const input = await readJsonBody<{ skillId: string; prompt?: string }>(request)
    const skill = (await service.getSkills()).find(item => item.id === input.skillId)
    if (!skill) throw notFound(`Skill 不存在：${input.skillId}`)
    const testedAt = new Date().toISOString()
    return httpResult(202, envelope('admin', {
      runId: `skill-test-${Date.now()}`,
      skillId: skill.id,
      version: skill.version,
      status: 'passed',
      resultSummary: `配置校验通过：${skill.toolIds.length} 个工具引用。`,
      testedAt,
      steps: [{ id: 'configuration', title: '校验 Skill 配置', description: '原型模式已完成确定性配置校验。', status: 'completed', occurredAt: testedAt }],
    }))
  })
  router.get(`${basePath}/skills/:skillId/test-runs/:runId`, async (_request, context) => {
    const skill = (await service.getSkills()).find(item => item.id === context.params.skillId)
    if (!skill) throw notFound(`Skill 不存在：${context.params.skillId}`)
    const testedAt = new Date().toISOString()
    return envelope('admin', {
      runId: context.params.runId,
      skillId: skill.id,
      version: skill.version,
      status: 'passed',
      resultSummary: `配置校验通过：${skill.toolIds.length} 个工具引用。`,
      testedAt,
      steps: [{ id: 'configuration', title: '校验 Skill 配置', description: '原型模式已完成确定性配置校验。', status: 'completed', occurredAt: testedAt }],
    })
  })
  router.patch(`${basePath}/skills/status`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; status: Extract<PublishStatus, 'published' | 'disabled'> }>(request)
    const actor = requireRequestIdentity(context, 'admin').userId
    const previous = (await service.getSkills()).find(item => item.id === input.skillId)
    const skill = await service.setSkillStatus({ ...input, actor })
    const action: SkillReleaseRecord['action'] = input.status === 'disabled'
      ? 'disabled'
      : previous?.status === 'draft' ? 'published' : 'enabled'
    return envelope('admin', {
      skill,
      release: prototypeSkillRelease(skill, actor, action),
    })
  })
  router.post(`${basePath}/skills/rollback`, async (request, context) => {
    const input = await readJsonBody<{ skillId: string; version: string }>(request)
    const skill = (await service.getSkills()).find(item => item.id === input.skillId && item.version === input.version)
    if (!skill) throw new Error(`未找到指定 Skill Version：${input.skillId}@${input.version}`)
    return envelope('admin', { skill, release: prototypeSkillRelease(skill, requireRequestIdentity(context, 'admin').userId, 'rollback') })
  })
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getMcpConnectors()))
  router.get(`${basePath}/runtimes/builtin-tools`, async () => envelope('admin', await service.getBuiltinToolStatus()))
  router.post(`${basePath}/connectors/check`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string }>(request)
    return envelope('admin', await service.checkMcpConnector({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/audit-events`, async (_request, context) => envelope('admin', await service.getAuditEvents({
    query: context.url.searchParams.get('query') ?? undefined,
    status: context.url.searchParams.get('status') ?? undefined,
    category: context.url.searchParams.get('category') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? undefined),
    pageSize: Number(context.url.searchParams.get('page_size') ?? undefined),
  })))
  router.get(`${basePath}/operations/summary`, async () => envelope('admin', await service.getOperationsSummary()))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth()))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage()))
  router.get(`${basePath}/platform-status`, () => envelope('admin', service.getPlatformStatus()))
}


function prototypeSkillVersion(skill: SkillDefinition): SkillVersionRecord {
  return {
    id: `prototype-version-${skill.id}-${skill.version}`,
    skillId: skill.id,
    version: skill.version,
    name: skill.name,
    category: skill.category,
    description: skill.description,
    instructions: skill.instructions,
    toolIds: [...skill.toolIds],
    testPrompt: skill.testPrompt,
    status: skill.status,
    createdAt: skill.updatedAt,
    createdBy: skill.owner,
    summary: '当前版本',
  }
}

function prototypeSkillRelease(
  skill: SkillDefinition,
  actor: string,
  action: SkillReleaseRecord['action'],
): SkillReleaseRecord {
  return {
    id: `prototype-release-${Date.now()}`,
    skillId: skill.id,
    version: skill.version,
    action,
    actor,
    time: new Date().toISOString().slice(0, 16).replace('T', ' '),
    note: '版本状态已更新。',
  }
}

const SMOKE_SUBMISSION_ID = 'skill-submission-smoke-weekly'

function smokeSkillSubmission() {
  return {
    id: SMOKE_SUBMISSION_ID, name: '周报汇总', description: '每周把销售日报汇总成周报。',
    submitter: { id: 'U00001', displayName: '测试员工' }, source: 'conversation', sessionId: 'session-smoke-skill-creator',
    status: 'pending', versionId: 'skill-submission-version-smoke-weekly', versionNumber: 1, scriptCount: 1,
    trial: { status: 'not_started' }, submittedAt: '2026-10-30T02:00:00.000Z',
  }
}
