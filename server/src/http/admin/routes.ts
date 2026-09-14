import type { PublishStatus, SkillDefinition, SkillReleaseRecord, SkillVersionRecord } from '../../domain/types.ts'
import type { AdminQueryService } from '../../modules/admin/application/admin-query-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

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
  router.get(`${basePath}/sessions`, async () => envelope('admin', await service.getSessions()))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces()))
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents()))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions()))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getAgentReleaseRecords()))
  router.post(`${basePath}/agents`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['createAgentDraft']>[0], 'actor'>>(request)
    return envelope('admin', await service.createAgentDraft({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/agents/draft`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['updateAgentDraft']>[0], 'actor'>>(request)
    return envelope('admin', await service.updateAgentDraft({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/agents/test`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; prompt: string }>(request)
    requireRequestIdentity(context, 'admin')
    if (input.prompt.trim().length < 4) throw new Error('测试问题至少需要 4 个字符')
    const agent = (await service.getAgents()).find(item => item.id === input.agentId)
    if (!agent) throw new Error(`Agent 不存在：${input.agentId}`)
    if (agent.status !== 'draft') throw new Error('当前 Agent 没有待测试的草稿版本')
    return envelope('admin', {
      id: `agent-test-${Date.now()}`,
      agentId: agent.id,
      version: agent.version,
      status: 'passed',
      resultSummary: `配置校验通过：${agent.skills.length} 个 Skill、${agent.tools.length} 个工具引用。`,
      testedAt: new Date().toISOString(),
    })
  })
  router.patch(`${basePath}/agents/status`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; status: Extract<PublishStatus, 'published' | 'disabled'> }>(request)
    return envelope('admin', await service.setAgentStatus({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/agents/rollback`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; version: string }>(request)
    return envelope('admin', await service.rollbackAgent({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills()))
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
    if (!skill) throw new Error(`Skill 不存在：${input.skillId}`)
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
    if (!skill) throw new Error(`Skill 不存在：${input.skillId}`)
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
    if (!skill) throw new Error(`Skill 不存在：${context.params.skillId}`)
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
  router.get(`${basePath}/tools`, async () => envelope('admin', await service.getTools()))
  router.get(`${basePath}/tools/catalog`, async () => envelope('admin', await service.getToolCatalog()))
  router.post(`${basePath}/tools`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<AdminQueryService['addTool']>[0], 'actor'>>(request)
    return envelope('admin', await service.addTool({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/tools/status`, async (request, context) => {
    const input = await readJsonBody<{ toolId: string; status: 'available' | 'disabled' }>(request)
    return envelope('admin', await service.setToolStatus({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors()))
  router.post(`${basePath}/connectors/check`, async (request, context) => {
    const input = await readJsonBody<{ connectorId: string }>(request)
    return envelope('admin', await service.checkConnector({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/tools/permissions`, async (request, context) => {
    const input = await readJsonBody<Parameters<AdminQueryService['updateToolPermissions']>[0]>(request)
    requireRequestIdentity(context, 'admin')
    return envelope('admin', await service.updateToolPermissions(input))
  })
  router.get(`${basePath}/audit-events`, async () => envelope('admin', await service.getAuditEvents()))
  router.get(`${basePath}/operations/summary`, async () => envelope('admin', await service.getOperationsSummary()))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth()))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage()))
  router.get(`${basePath}/model-usage`, async () => envelope('admin', await service.getModelUsage()))
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
