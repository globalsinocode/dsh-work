import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import { useAuthStore } from './auth'
import type {
  AdminTaskSummary,
  AgentDefinition,
  AgentDraftConfiguration,
  AgentJoinedWorkspaceRecord,
  AgentReleaseRecord,
  AgentVersionRecord,
  AuditEvent,
  ConnectorDefinition,
  DshRuntimeToolConnectorStatus,
  GrantSourceReconciliationView,
  HealthComponent,
  ManagedWorkspaceDefinition,
  OperationsSummary,
  PlatformStatus,
  RuntimeDefinition,
  SkillConfiguration,
  SkillDefinition,
  SkillReleaseRecord,
  SkillVersionRecord,
  ToolCatalogCandidate,
  ToolDefinition,
  UpdateRuntimeConfigurationInput,
  UsagePoint,
} from '../types/domain'

export const useContentStore = defineStore('admin-content', () => {
  const authStore = useAuthStore()
  const tasks = ref<AdminTaskSummary[]>([])
  const runtimes = ref<RuntimeDefinition[]>([])
  const workspaces = ref<ManagedWorkspaceDefinition[]>([])
  const agents = ref<AgentDefinition[]>([])
  const agentVersions = ref<AgentVersionRecord[]>([])
  const agentReleaseRecords = ref<AgentReleaseRecord[]>([])
  const skills = ref<SkillDefinition[]>([])
  const skillVersions = ref<SkillVersionRecord[]>([])
  const skillReleaseRecords = ref<SkillReleaseRecord[]>([])
  const tools = ref<ToolDefinition[]>([])
  const toolCatalog = ref<ToolCatalogCandidate[]>([])
  const connectors = ref<ConnectorDefinition[]>([])
  const dshRuntimeToolConnector = ref<DshRuntimeToolConnectorStatus | null>(null)
  const auditEvents = ref<AuditEvent[]>([])
  const operationsSummary = ref<OperationsSummary | null>(null)
  const health = ref<HealthComponent[]>([])
  const usage = ref<UsagePoint[]>([])
  const platformStatus = ref<PlatformStatus | null>(null)
  const agentJoinedWorkspaces = ref<Record<string, AgentJoinedWorkspaceRecord[]>>({})
  const grantReconciliation = ref<GrantSourceReconciliationView | null>(null)
  const loading = ref(false)
  const error = ref('')
  const adminInitialized = ref(false)
  const auditInitialized = ref(false)
  const initialized = computed(() =>
    (!authStore.canReadAdmin || adminInitialized.value)
    && (!authStore.canReadAudit || auditInitialized.value),
  )
  let pendingLoad: Promise<void> | undefined

  async function load(force = false) {
    const needsAdmin = authStore.canReadAdmin && (force || !adminInitialized.value)
    const needsAudit = authStore.canReadAudit && (force || !auditInitialized.value)
    if (!needsAdmin && !needsAudit) return
    if (pendingLoad) return pendingLoad
    pendingLoad = (async () => {
      loading.value = true
      error.value = ''
      try {
        await Promise.all([
          ...(needsAdmin ? [loadAdminData()] : []),
          ...(needsAudit ? [loadAuditData()] : []),
        ])
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '管理数据加载失败，请稍后重试'
      } finally {
        loading.value = false
        pendingLoad = undefined
      }
    })()
    return pendingLoad
  }

  async function loadAdminData() {
    const [
      taskData,
      runtimeData,
      workspaceData,
      agentData,
      agentVersionData,
      agentReleaseData,
      skillData,
      skillVersionData,
      skillReleaseData,
      toolData,
      toolCatalogData,
      connectorData,
      dshRuntimeToolConnectorData,
      healthData,
      usageData,
      statusData,
    ] = await Promise.all([
      adminApi.getTasks(),
      adminApi.getRuntimes(),
      adminApi.getWorkspaces(),
      adminApi.getAgents(),
      adminApi.getAgentVersions(),
      adminApi.getAgentReleaseRecords(),
      adminApi.getSkills(),
      adminApi.getSkillVersions(),
      adminApi.getSkillReleaseRecords(),
      adminApi.getTools(),
      adminApi.getToolCatalog(),
      adminApi.getMcpConnectors(),
      adminApi.getDshRuntimeToolConnector(),
      adminApi.getHealth(),
      adminApi.getUsage(),
      adminApi.getPlatformStatus(),
    ])
    tasks.value = taskData
    runtimes.value = runtimeData
    workspaces.value = workspaceData
    agents.value = agentData
    agentVersions.value = agentVersionData
    agentReleaseRecords.value = agentReleaseData
    skills.value = skillData
    skillVersions.value = skillVersionData
    skillReleaseRecords.value = skillReleaseData
    tools.value = toolData
    toolCatalog.value = toolCatalogData
    connectors.value = connectorData
    dshRuntimeToolConnector.value = dshRuntimeToolConnectorData
    health.value = healthData
    usage.value = usageData
    platformStatus.value = statusData
    adminInitialized.value = true
  }

  async function loadAuditData() {
    const [auditData, operationsSummaryData] = await Promise.all([
      adminApi.getAuditEvents({ page: 1, pageSize: 20 }),
      adminApi.getOperationsSummary(),
    ])
    auditEvents.value = auditData.items
    operationsSummary.value = operationsSummaryData
    auditInitialized.value = true
  }

  async function setAgentStatus(
    agentId: string,
    status: 'published' | 'disabled',
  ) {
    const result = await adminApi.setAgentStatus({ agentId, status })
    replaceById(agents.value, result.agent)
    agentReleaseRecords.value.unshift(result.release)
    const version = agentVersions.value.find(
      (item) => item.agentId === agentId && item.version === result.agent.version,
    )
    if (version) version.status = status
    return result.agent
  }

  async function createAgentDraft(input: AgentDraftConfiguration) {
    const result = await adminApi.createAgentDraft(input)
    agents.value.unshift(result.agent)
    agentVersions.value.unshift(result.version)
    return result.agent
  }

  async function updateAgentDraft(input: AgentDraftConfiguration) {
    const { id, ...configuration } = input
    const result = await adminApi.updateAgentDraft({
      agentId: id,
      ...configuration,
    })
    replaceById(agents.value, result.agent)
    replaceById(agentVersions.value, result.version)
    return result.agent
  }

  async function rollbackAgent(agentId: string, version: string) {
    const result = await adminApi.rollbackAgent({ agentId, version })
    replaceById(agents.value, result.agent)
    agentReleaseRecords.value.unshift(result.release)
    const target = agentVersions.value.find(
      (item) => item.agentId === agentId && item.version === version,
    )
    if (target) target.status = 'published'
    return result.agent
  }

  /** 平台治理开关（convergence §1）：关闭后该 Agent 不再出现在团队空间候选。 */
  async function setAgentWorkspaceJoin(agentId: string, allowWorkspaceJoin: boolean) {
    const result = await adminApi.setAgentWorkspaceJoin({ agentId, allowWorkspaceJoin })
    replaceById(agents.value, result.agent)
    return result.agent
  }

  /** 只读的「已加入空间」清单；按 Agent 缓存，供详情页评估停用影响。 */
  async function loadAgentJoinedWorkspaces(agentId: string) {
    const result = await adminApi.getAgentJoinedWorkspaces(agentId)
    agentJoinedWorkspaces.value = { ...agentJoinedWorkspaces.value, [agentId]: result.items }
    return result.items
  }

  async function loadGrantSourceReconciliation() {
    grantReconciliation.value = await adminApi.getGrantSourceReconciliation()
    return grantReconciliation.value
  }

  /** 对账完成后刷新清单：legacy 来源被改写为 manual，不再出现在列表中。 */
  async function reconcileGrantSources(sourceIds: string[]) {
    const result = await adminApi.reconcileGrantSources({ sourceIds })
    await loadGrantSourceReconciliation()
    return result
  }

  async function updateToolPermissions(input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) {
    const tool = await adminApi.updateToolPermissions(input)
    replaceById(tools.value, tool)
    return tool
  }

  async function addTool(input: {
    catalogId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) {
    const tool = await adminApi.addTool(input)
    replaceById(tools.value, tool)
    const candidate = toolCatalog.value.find(item => item.id === input.catalogId)
    if (candidate) {
      candidate.status = 'installed'
      candidate.availabilityMessage = '已添加到工具目录'
    }
    return tool
  }

  async function createSkill(input: Omit<SkillConfiguration, 'id'>) {
    const result = await adminApi.createSkill(input)
    skills.value.unshift(result.skill)
    skillVersions.value.unshift(result.version)
    return result.skill
  }

  async function updateSkill(input: SkillConfiguration) {
    const { id, ...configuration } = input
    const result = await adminApi.updateSkill({ skillId: id, ...configuration })
    replaceById(skills.value, result.skill)
    replaceById(skillVersions.value, result.version)
    return result.skill
  }

  function testSkill(skillId: string, prompt: string) {
    return adminApi.testSkill({ skillId, prompt })
  }

  function startSkillTestRun(skillId: string, prompt: string) {
    return adminApi.startSkillTestRun({ skillId, prompt })
  }

  function getSkillTestRun(skillId: string, runId: string) {
    return adminApi.getSkillTestRun(skillId, runId)
  }

  async function setSkillStatus(
    skillId: string,
    status: 'published' | 'disabled',
  ) {
    const result = await adminApi.setSkillStatus({ skillId, status })
    replaceById(skills.value, result.skill)
    skillReleaseRecords.value.unshift(result.release)
    if (result.release.action === 'published') {
      const version = skillVersions.value.find(
        item => item.skillId === skillId && item.version === result.release.version,
      )
      if (version) {
        version.status = 'published'
        version.publishedAt = result.release.time
        version.publishedBy = result.release.actor
      }
    }
    return result.skill
  }

  async function rollbackSkill(skillId: string, version: string) {
    const result = await adminApi.rollbackSkill({ skillId, version })
    replaceById(skills.value, result.skill)
    skillReleaseRecords.value.unshift(result.release)
    for (const item of skillVersions.value) {
      if (item.skillId === skillId && item.status === 'draft') item.status = 'disabled'
    }
    return result.skill
  }

  async function setToolStatus(
    toolId: string,
    status: 'available' | 'disabled',
  ) {
    const tool = await adminApi.setToolStatus({ toolId, status })
    replaceById(tools.value, tool)
    return tool
  }

  async function checkConnector(connectorId: string) {
    const connector = await adminApi.checkConnector({ connectorId })
    replaceById(connectors.value, connector)
    return connector
  }

  async function registerMcpConnector(input: Parameters<typeof adminApi.registerMcpConnector>[0]) {
    const connector = await adminApi.registerMcpConnector(input)
    connectors.value.push(connector)
    return connector
  }

  function testMcpConnection(input: Parameters<typeof adminApi.testMcpConnection>[0]) {
    return adminApi.testMcpConnection(input)
  }

  async function deleteMcpConnector(connectorId: string) {
    const result = await adminApi.deleteMcpConnector(connectorId)
    const index = connectors.value.findIndex(connector => connector.id === connectorId)
    if (index >= 0) connectors.value.splice(index, 1)
    return result
  }

  async function rotateMcpCredential(connectorId: string, bearerToken: string) {
    const connector = await adminApi.rotateMcpCredential({ connectorId, bearerToken })
    replaceById(connectors.value, connector)
    return connector
  }

  async function setMcpConnectorStatus(connectorId: string, status: 'enabled' | 'disabled') {
    const connector = await adminApi.setMcpConnectorStatus({ connectorId, status })
    replaceById(connectors.value, connector)
    return connector
  }

  function getMcpInvocationAudits(connectorId: string) {
    return adminApi.getMcpInvocationAudits(connectorId)
  }

  async function checkRuntime(runtimeId: string) {
    const runtime = await adminApi.checkRuntime({ runtimeId })
    replaceById(runtimes.value, runtime)
    return runtime
  }

  async function checkDshRuntimeToolConnector() {
    const connector = await adminApi.checkDshRuntimeToolConnector()
    dshRuntimeToolConnector.value = connector
    return connector
  }

  async function updateRuntimeConfiguration(input: UpdateRuntimeConfigurationInput) {
    const runtime = await adminApi.updateRuntimeConfiguration(input)
    replaceById(runtimes.value, runtime)
    return runtime
  }

  return {
    tasks,
    runtimes,
    workspaces,
    agents,
    agentVersions,
    agentReleaseRecords,
    skills,
    skillVersions,
    skillReleaseRecords,
    tools,
    toolCatalog,
    connectors,
    dshRuntimeToolConnector,
    auditEvents,
    operationsSummary,
    health,
    usage,
    platformStatus,
    agentJoinedWorkspaces,
    grantReconciliation,
    loading,
    error,
    initialized,
    load,
    createAgentDraft,
    updateAgentDraft,
    setAgentStatus,
    rollbackAgent,
    setAgentWorkspaceJoin,
    loadAgentJoinedWorkspaces,
    loadGrantSourceReconciliation,
    reconcileGrantSources,
    createSkill,
    updateSkill,
    setSkillStatus,
    testSkill,
    startSkillTestRun,
    getSkillTestRun,
    rollbackSkill,
    setToolStatus,
    checkConnector,
    testMcpConnection,
    registerMcpConnector,
    deleteMcpConnector,
    rotateMcpCredential,
    setMcpConnectorStatus,
    getMcpInvocationAudits,
    checkRuntime,
    checkDshRuntimeToolConnector,
    updateRuntimeConfiguration,
    updateToolPermissions,
    addTool,
  }
})

function replaceById<T extends { id: string }>(collection: T[], item: T) {
  const index = collection.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) collection.splice(index, 1, item)
  else collection.unshift(item)
}
