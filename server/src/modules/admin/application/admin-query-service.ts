import { randomUUID } from 'node:crypto'

import type { PrototypeRepository } from '../../../infrastructure/prototype/prototype-repository.ts'
import type {
  AgentDefinition,
  AgentDraftConfiguration,
  AgentVersionRecord,
  ConnectorConfiguration,
  CreateAgentDraftInput,
  CreateSkillInput,
  ManagedWorkspaceDefinition,
  OperationsSummary,
  PublishStatus,
  SessionDefinition,
  SkillConfiguration,
  SkillDefinition,
  ToolDefinition,
  AddToolInput,
  UpdateAgentDraftInput,
  UpdateRuntimeConfigurationInput,
  UpdateSkillInput,
} from '../../../domain/types.ts'
import {
  assertDshToolApprovalPolicy,
  catalogEntryToToolDefinition,
  dshBuiltInToolCatalog,
  normalizeToolPolicyInput,
  publicCatalogCandidate,
} from '../../tool/dsh-built-in-tool-catalog.ts'

export interface PlatformStatus {
  architecture: 'node-modular-monolith'
  persistence: 'prototype-memory'
  sso: 'mock'
  dshRuntime: 'not-connected'
  database: 'not-configured'
  artifactStorage: 'not-configured'
}

export class AdminQueryService {
  private readonly repository: PrototypeRepository

  constructor(repository: PrototypeRepository) {
    this.repository = repository
  }

  getSession() {
    return this.repository.read('users').then((users) => ({
      user: users.platform_admin,
      identityProvider: 'prototype-sso' as const,
      apiAudience: 'admin' as const,
    }))
  }

  async getTaskSummaries() {
    const tasks = await this.repository.read('tasks')
    return tasks.map(({ id, status }) => ({ id, status }))
  }

  getRuntimes() {
    return this.repository.read('runtimes')
  }

  async checkRuntime(input: { runtimeId: string; actor: string }) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    const runtimes = await this.repository.read('runtimes')
    const runtime = runtimes.find((item) => item.id === input.runtimeId)
    if (!runtime) throw new Error(`Runtime 不存在：${input.runtimeId}`)
    if (runtime.status === 'offline') {
      return this.repository.updateRuntime(input.runtimeId, {
        checkedAt: '刚刚',
        healthMessage: runtime.mode === 'prototype'
          ? '执行服务当前不可用。'
          : '健康检查失败：目标 DSH Worker 尚未安装或注册。',
      })
    }
    return this.repository.updateRuntime(input.runtimeId, {
      lastHeartbeat: '刚刚',
      checkedAt: '刚刚',
    })
  }

  async updateRuntimeConfiguration(input: UpdateRuntimeConfigurationInput) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    if (!Number.isInteger(input.maxConcurrentWorkers) || input.maxConcurrentWorkers < 1 || input.maxConcurrentWorkers > 128) {
      throw new Error('最大并发 Worker 数必须是 1～128 之间的整数')
    }
    if (!Number.isInteger(input.attemptTimeoutMinutes) || input.attemptTimeoutMinutes < 1 || input.attemptTimeoutMinutes > 60) {
      throw new Error('单次执行超时时间必须是 1～60 分钟之间的整数')
    }
    if (!['accepting', 'draining', 'disabled'].includes(input.schedulingStatus)) {
      throw new Error('Runtime 调度状态无效')
    }

    const runtimes = await this.repository.read('runtimes')
    const runtime = runtimes.find((item) => item.id === input.runtimeId)
    if (!runtime) throw new Error(`Runtime 不存在：${input.runtimeId}`)
    if (input.maxConcurrentWorkers < runtime.activeWorkers) {
      throw new Error(`最大并发 Worker 数不能小于当前活动 Worker 数 ${runtime.activeWorkers}`)
    }

    return this.repository.updateRuntime(input.runtimeId, {
      maxConcurrentWorkers: input.maxConcurrentWorkers,
      attemptTimeoutMinutes: input.attemptTimeoutMinutes,
      schedulingStatus: input.schedulingStatus,
    })
  }

  async getSessions(): Promise<SessionDefinition[]> {
    const tasks = await this.repository.read('tasks')
    const traceByRun: Record<string, string> = {
      'run-260828-002': 'tr_92af80d18d',
      'run-260828-001': 'tr_abe490071c',
      'run-260826-008': 'tr_6a7c31e02d',
    }
    return tasks.map((task) => ({
      id: task.sessionId,
      title: task.title,
      user: task.owner,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      agentId: task.agentVersion.split('@')[0] || 'dsh-work-assistant',
      agentName: 'dsh-work Assistant',
      agentVersion: task.agentVersion.split('@')[1] || '—',
      runId: task.id,
      status: task.status,
      runCount: 1,
      messageCount: task.messages.length,
      tokenUsage: task.tokenUsage ?? 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      traceId: traceByRun[task.id] ?? `trace-${task.id.replace(/^run-/, '')}`,
    }))
  }

  async getManagedWorkspaces(): Promise<ManagedWorkspaceDefinition[]> {
    const workspaces = await this.repository.read('workspaces')
    return workspaces
      .filter((workspace) => workspace.type === 'team')
      .map((workspace) => {
        const supplyWorkspace = workspace.id === 'ws-supply'
        return {
          id: workspace.id,
          name: workspace.name,
          description: workspace.description,
          type: 'team' as const,
          creator: workspace.members[0] ?? workspace.owner,
          memberCount: workspace.memberCount,
          sessionCount: workspace.sessionCount,
          artifactCount: workspace.artifactCount,
          fileCount: workspace.files.length,
          createdAt: supplyWorkspace ? '2026-08-01' : '2026-08-05',
          updatedAt: workspace.updatedAt,
        }
      })
  }

  getAgents() {
    return this.repository.read('agents')
  }

  getAgentVersions() {
    return this.repository.read('agentVersions')
  }

  getAgentReleaseRecords() {
    return this.repository.read('agentReleaseRecords')
  }

  async createAgentDraft(input: CreateAgentDraftInput) {
    const creatorName = input.actor.trim()
    if (!creatorName) throw new Error('创建人不能为空')

    const users = await this.repository.read('users')
    const creator = Object.values(users).find((user) => user.name === creatorName)
    const normalizedInput: CreateAgentDraftInput = {
      ...input,
      actor: creatorName,
      owner: creatorName,
      department: creator?.department ?? input.department,
      welcomeMessage: normalizeWelcomeMessage(input),
    }
    assertDraftConfiguration(normalizedInput)

    const timestamp = prototypeTimestamp()
    const version = '0.1.0'
    const { actor, changeSummary, ...configuration } = normalizedInput
    const agent: AgentDefinition = {
      ...configuration,
      status: 'draft',
      version,
      updatedAt: timestamp,
      allowWorkspaceJoin: true,
    }
    const versionRecord: AgentVersionRecord = {
      id: `agent-version-${normalizedInput.id}-${Date.now()}`,
      agentId: normalizedInput.id,
      version,
      status: 'draft',
      createdAt: timestamp,
      createdBy: actor,
      summary: changeSummary.trim() || '创建初始草稿版本。',
      ...agentVersionSnapshot(agent),
    }
    return this.repository.createAgentDraft(agent, versionRecord)
  }

  async updateAgentDraft(input: UpdateAgentDraftInput) {
    const agents = await this.repository.read('agents')
    const current = agents.find((agent) => agent.id === input.agentId)
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    if (current.status !== 'draft') throw new Error('只有草稿状态的 Agent 可以编辑')
    if (!input.actor.trim()) throw new Error('操作人不能为空')

    const { agentId, actor: _actor, changeSummary, ...submittedConfiguration } = input
    void _actor
    const configuration = {
      ...submittedConfiguration,
      owner: current.owner,
      department: current.department,
      welcomeMessage: normalizeWelcomeMessage(submittedConfiguration),
    }
    assertDraftConfiguration({ id: agentId, changeSummary, ...configuration })
    const timestamp = prototypeTimestamp()
    const agent = await this.repository.updateAgent(agentId, {
      ...configuration,
      updatedAt: timestamp,
    })
    const version = await this.repository.updateAgentVersion(agentId, current.version, {
      summary: changeSummary.trim() || '更新 Agent 草稿配置。',
      ...agentVersionSnapshot(agent),
    })
    return { agent, version }
  }

  async setAgentStatus(input: {
    agentId: string
    status: Extract<PublishStatus, 'published' | 'disabled'>
    actor: string
  }) {
    const agents = await this.repository.read('agents')
    const current = agents.find((agent) => agent.id === input.agentId)
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    if (input.status === 'published') assertAgentReady(current)

    const timestamp = prototypeTimestamp()
    const action = input.status === 'disabled'
      ? 'disabled' as const
      : current.status === 'draft'
        ? 'published' as const
        : 'enabled' as const
    const agent = await this.repository.updateAgent(input.agentId, {
      status: input.status,
      version: current.version,
      updatedAt: timestamp,
    })
    await this.repository.updateAgentVersion(input.agentId, current.version, {
      status: input.status,
      ...(action === 'published' ? { publishedAt: timestamp, publishedBy: input.actor } : {}),
    })
    const release = await this.repository.appendAgentRelease({
      id: `release-${Date.now()}`,
      agentId: input.agentId,
      version: current.version,
      action,
      actor: input.actor,
      time: timestamp,
      note: action === 'published'
        ? '通过管理后台发布当前草稿版本。'
        : action === 'enabled'
          ? '重新启用当前 Agent 版本。'
          : '停用当前 Agent，不影响已创建的运行。',
    })
    return { agent, release }
  }

  async rollbackAgent(input: { agentId: string; version: string; actor: string }) {
    const [agents, versions] = await Promise.all([
      this.repository.read('agents'),
      this.repository.read('agentVersions'),
    ])
    const current = agents.find((agent) => agent.id === input.agentId)
    const target = versions.find(
      (version) => version.agentId === input.agentId && version.version === input.version,
    )
    if (!current) throw new Error(`Agent 不存在：${input.agentId}`)
    if (!target) throw new Error(`Agent Version 不存在：${input.agentId}@${input.version}`)
    if (target.status === 'draft') throw new Error('不能回滚到尚未发布的草稿版本')

    const timestamp = prototypeTimestamp()
    const agent = await this.repository.updateAgent(input.agentId, {
      status: 'published',
      version: target.version,
      visibility: target.visibility,
      roleIds: target.roleIds,
      dataScopes: target.dataScopes,
      welcomeMessage: target.welcomeMessage,
      examplePrompts: target.examplePrompts,
      systemPrompt: target.systemPrompt,
      maxTokens: target.maxTokens,
      timeoutSeconds: target.timeoutSeconds,
      skills: target.skills,
      tools: target.tools,
      updatedAt: timestamp,
    })
    await this.repository.updateAgentVersion(input.agentId, target.version, { status: 'published' })
    const release = await this.repository.appendAgentRelease({
      id: `release-${Date.now()}`,
      agentId: input.agentId,
      version: target.version,
      action: 'rollback',
      actor: input.actor,
      time: timestamp,
      note: `活动版本由 v${current.version} 回滚到 v${target.version}。`,
    })
    return { agent, release }
  }

  getSkills() {
    return this.repository.read('skills').then(skills => skills.map(skill => ({
      ...skill,
      ...(skill.status === 'published' ? { activeVersion: skill.version } : {}),
    })))
  }

  async createSkill(input: CreateSkillInput) {
    const actor = input.actor.trim()
    if (!actor) throw new Error('创建人不能为空')
    const skillId = `skill-${randomUUID()}`
    const configuration: SkillConfiguration = {
      id: skillId,
      name: input.name,
      category: input.category,
      description: input.description,
      instructions: input.instructions,
      toolIds: input.toolIds,
      testPrompt: input.testPrompt,
    }
    assertSkillConfiguration(configuration)
    await this.assertSkillToolsAvailable(input.toolIds)
    const skill: SkillDefinition = {
      id: skillId,
      name: input.name.trim(),
      category: input.category.trim(),
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      toolIds: unique(input.toolIds),
      testPrompt: input.testPrompt.trim(),
      owner: actor,
      status: 'draft',
      version: '0.1.0',
      updatedAt: prototypeTimestamp().slice(0, 10),
    }
    return this.repository.createSkill(skill)
  }

  async updateSkill(input: UpdateSkillInput) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    const skills = await this.repository.read('skills')
    const current = skills.find((skill) => skill.id === input.skillId)
    if (!current) throw new Error(`Skill 不存在：${input.skillId}`)
    if (current.status !== 'draft') throw new Error('已发布或已停用的 Skill 不可原地编辑')
    const configuration: SkillConfiguration = { id: input.skillId, ...input }
    assertSkillConfiguration(configuration)
    await this.assertSkillToolsAvailable(input.toolIds)
    return this.repository.updateSkill(input.skillId, {
      name: input.name.trim(),
      category: input.category.trim(),
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      toolIds: unique(input.toolIds),
      testPrompt: input.testPrompt.trim(),
      updatedAt: prototypeTimestamp().slice(0, 10),
    })
  }

  async setSkillStatus(input: {
    skillId: string
    status: Extract<PublishStatus, 'published' | 'disabled'>
    actor: string
  }) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    const skills = await this.repository.read('skills')
    const skill = skills.find((item) => item.id === input.skillId)
    if (!skill) throw new Error(`Skill 不存在：${input.skillId}`)
    if (input.status === 'published') {
      assertSkillConfiguration(skill)
      await this.assertSkillToolsAvailable(skill.toolIds)
    }
    return this.repository.updateSkill(input.skillId, {
      status: input.status,
      updatedAt: prototypeTimestamp().slice(0, 10),
    })
  }

  private async assertSkillToolsAvailable(toolIds: string[]) {
    const tools = await this.repository.read('tools')
    for (const toolId of unique(toolIds)) {
      const tool = tools.find((item) => item.id === toolId)
      if (!tool) throw new Error(`Skill 引用的工具不存在：${toolId}`)
      if (tool.status === 'disabled') throw new Error(`Skill 引用的工具已停用：${tool.name}`)
    }
  }

  getTools() {
    return this.repository.read('tools')
  }

  async getToolCatalog() {
    const installed = new Set((await this.repository.read('tools')).map(tool => tool.id))
    return dshBuiltInToolCatalog.map(entry => {
      if (!entry.platformSupported) return publicCatalogCandidate(entry, 'unavailable', entry.unsupportedReason ?? '平台尚未接入该工具')
      return installed.has(entry.id)
        ? publicCatalogCandidate(entry, 'installed', '已添加到工具目录')
        : publicCatalogCandidate(entry, 'ready', '原型模式可演示添加；真实环境仍会检查 DSH Runtime')
    })
  }

  async addTool(input: AddToolInput) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    const policy = normalizeToolPolicyInput(input)
    const entry = dshBuiltInToolCatalog.find(item => item.id === input.catalogId)
    if (!entry) throw new Error(`不支持添加该 DSH 工具：${input.catalogId}`)
    if (!entry.platformSupported) throw new Error(entry.unsupportedReason ?? `平台尚未接入该工具：${input.catalogId}`)
    assertDshToolApprovalPolicy(entry, policy.approvalPolicy)
    const existing = (await this.repository.read('tools')).find(tool => tool.id === entry.id)
    if (existing) throw new Error(`工具已存在：${entry.name}`)
    return this.repository.createTool(catalogEntryToToolDefinition(entry, {
      allowedRoles: policy.allowedRoles,
      dataScopes: policy.dataScopes,
      approvalPolicy: policy.approvalPolicy,
    }))
  }

  async setToolStatus(input: {
    toolId: string
    status: Extract<ToolDefinition['status'], 'available' | 'disabled'>
    actor: string
  }) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    return this.repository.updateTool(input.toolId, {
      status: input.status,
      lastCheckedAt: '刚刚',
    })
  }

  getConnectors() {
    return this.repository.read('connectors')
  }

  async checkConnector(input: { connectorId: string; actor: string }) {
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    const connectors = await this.repository.read('connectors')
    const connector = connectors.find((item) => item.id === input.connectorId)
    if (!connector) throw new Error(`连接器不存在：${input.connectorId}`)
    assertConnectorConfiguration(connector)
    return this.repository.updateConnector(input.connectorId, {
      status: 'healthy',
      latency: mockConnectorLatency(input.connectorId),
      lastCheckedAt: '刚刚',
    })
  }

  updateToolPermissions(input: {
    toolId: string
    allowedRoles: ToolDefinition['allowedRoles']
    dataScopes: ToolDefinition['dataScopes']
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) {
    return this.repository.updateToolPermissions(input.toolId, {
      allowedRoles: input.allowedRoles,
      dataScopes: input.dataScopes,
      approvalPolicy: input.approvalPolicy,
    })
  }

  getAuditEvents() {
    return this.repository.read('auditEvents')
  }

  async getOperationsSummary(): Promise<OperationsSummary> {
    const [tasks, auditEvents, modelUsage, artifacts] = await Promise.all([
      this.repository.read('tasks'),
      this.repository.read('auditEvents'),
      this.repository.read('modelUsage'),
      this.repository.read('artifacts'),
    ])
    return {
      runs24h: tasks.length,
      successfulRuns24h: tasks.filter(task => task.status === 'succeeded').length,
      failedRuns24h: tasks.filter(task => task.status === 'failed').length,
      modelTokens24h: modelUsage.reduce((total, record) => total + record.totalTokens, 0),
      toolCalls24h: auditEvents.filter(event => event.category === 'tool').length,
      artifacts24h: artifacts.length,
      attentionEvents24h: auditEvents.filter(event => event.status === 'failed' || event.status === 'blocked').length,
    }
  }

  getHealth() {
    return this.repository.read('health')
  }

  getUsage() {
    return this.repository.read('usage')
  }

  getModelUsage() {
    return this.repository.read('modelUsage')
  }

  getPlatformStatus(): PlatformStatus {
    return {
      architecture: 'node-modular-monolith',
      persistence: 'prototype-memory',
      sso: 'mock',
      dshRuntime: 'not-connected',
      database: 'not-configured',
      artifactStorage: 'not-configured',
    }
  }
}

function prototypeTimestamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

function normalizeWelcomeMessage(
  input: Pick<AgentDraftConfiguration, 'welcomeMessage' | 'name' | 'description'>,
) {
  const welcomeMessage = input.welcomeMessage.trim()
  if (welcomeMessage) return welcomeMessage
  return `你好，我是${input.name.trim() || '企业 Agent'}。${input.description.trim() || '我会根据已配置的能力和权限协助你完成工作。'}`.slice(0, 120)
}

function assertDraftConfiguration(input: AgentDraftConfiguration) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(input.id)) {
    throw new Error('Agent 标识必须以小写字母开头，只能包含小写字母、数字和连字符，长度为 3～48 位')
  }
  if (input.name.trim().length < 2) throw new Error('Agent 名称至少需要 2 个字符')
  if (input.description.trim().length < 10) throw new Error('Agent 说明至少需要 10 个字符')
  if (!input.owner.trim() || !input.department.trim()) throw new Error('负责人和归属部门不能为空')
  if (!input.visibility.trim() || input.roleIds.length === 0) throw new Error('请配置 Agent 可见范围和角色')
  if (input.dataScopes.length === 0) throw new Error('请配置至少一个业务数据范围')
  if (input.welcomeMessage.trim().length > 120) throw new Error('欢迎语不能超过 120 个字符')
  if (input.examplePrompts.length === 0) throw new Error('请配置至少一个示例问题')
  if (input.systemPrompt.trim().length < 20) throw new Error('System Prompt 至少需要 20 个字符')
  if (input.maxTokens < 1024 || input.maxTokens > 32768) throw new Error('Token 上限必须在 1024～32768 之间')
  if (input.timeoutSeconds < 30 || input.timeoutSeconds > 600) throw new Error('运行超时必须在 30～600 秒之间')
  if (input.skills.length === 0) throw new Error('请至少引用一个已发布 Skill')
  if (input.tools.length === 0) throw new Error('请至少选择一个可用工具')
}

function assertAgentReady(agent: AgentDefinition) {
  assertDraftConfiguration({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    owner: agent.owner,
    department: agent.department,
    visibility: agent.visibility,
    roleIds: agent.roleIds,
    dataScopes: agent.dataScopes,
    welcomeMessage: agent.welcomeMessage,
    examplePrompts: agent.examplePrompts,
    systemPrompt: agent.systemPrompt,
    maxTokens: agent.maxTokens,
    timeoutSeconds: agent.timeoutSeconds,
    skills: agent.skills,
    tools: agent.tools,
    changeSummary: '发布校验',
  })
}

function assertSkillConfiguration(input: SkillConfiguration) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(input.id)) {
    throw new Error('Skill 标识必须以小写字母开头，只能包含小写字母、数字和连字符，长度为 3～48 位')
  }
  if (input.name.trim().length < 2) throw new Error('Skill 名称至少需要 2 个字符')
  if (!input.category.trim()) throw new Error('请选择 Skill 分类')
  if (input.description.trim().length < 10) throw new Error('Skill 说明至少需要 10 个字符')
  if (input.instructions.trim().length < 20) throw new Error('执行指令至少需要 20 个字符')
  if (input.toolIds.length === 0) throw new Error('请至少选择一个工具')
  if (input.testPrompt.trim().length < 4) throw new Error('请提供一个可用于测试的典型问题')
}

function assertConnectorConfiguration(input: ConnectorConfiguration) {
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(input.id)) {
    throw new Error('连接器标识必须以小写字母开头，只能包含小写字母、数字和连字符，长度为 3～48 位')
  }
  if (input.name.trim().length < 2) throw new Error('连接器名称至少需要 2 个字符')
  if (!input.system.trim()) throw new Error('企业系统不能为空')
  try {
    const endpoint = new URL(input.endpoint.trim())
    if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname) throw new Error()
  } catch {
    throw new Error('服务地址必须是包含主机名的 http:// 或 https:// 地址')
  }
  if (!input.authType.trim()) throw new Error('请选择认证方式')
  if (!input.credentialRef.trim().startsWith('secret://')) throw new Error('凭据引用必须使用 secret:// 开头，不能填写真实密钥')
  if (input.credentialRef.trim().endsWith('/')) throw new Error('凭据引用需要指向一个具体的服务端密钥条目')
  if (input.scopeDescription.trim().length < 6) throw new Error('请说明连接器的数据范围')
}

function mockConnectorLatency(id: string) {
  return `${160 + (id.length * 17) % 220} ms`
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function agentVersionSnapshot(agent: AgentDefinition) {
  return {
    visibility: agent.visibility,
    roleIds: [...agent.roleIds],
    dataScopes: [...agent.dataScopes],
    welcomeMessage: agent.welcomeMessage,
    examplePrompts: [...agent.examplePrompts],
    systemPrompt: agent.systemPrompt,
    maxTokens: agent.maxTokens,
    timeoutSeconds: agent.timeoutSeconds,
    skills: [...agent.skills],
    tools: [...agent.tools],
  }
}
