import {
  mockAgents,
  mockAgentReleaseRecords,
  mockAgentVersions,
  mockArtifacts,
  mockAuditEvents,
  mockConnectors,
  mockHealth,
  mockModelUsage,
  mockRuntimes,
  mockSkills,
  mockTasks,
  mockTools,
  mockUsage,
  mockWorkspaces,
  prototypeUsers,
} from './data.ts'
import type {
  AgentDefinition,
  AgentReleaseRecord,
  AgentVersionRecord,
  ConnectorDefinition,
  RuntimeDefinition,
  SkillDefinition,
  ToolDefinition,
} from '../../domain/types.ts'

const copy = <T>(value: T): T => structuredClone(value)

async function simulateIo() {
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
}

/**
 * Prototype-only persistence adapter. It deliberately has the same boundary that a
 * PostgreSQL repository will implement later, without pretending data is durable.
 */
export class PrototypeRepository {
  async read<K extends PrototypeCollection>(collection: K): Promise<PrototypeData[K]> {
    await simulateIo()
    return copy(prototypeData[collection])
  }

  async updateAgent(
    agentId: string,
    patch: Partial<Omit<AgentDefinition, 'id'>>,
  ): Promise<AgentDefinition> {
    await simulateIo()
    const agent = prototypeData.agents.find((item) => item.id === agentId)
    if (!agent) throw new Error(`Agent 不存在：${agentId}`)
    Object.assign(agent, copy(patch))
    return copy(agent)
  }

  async updateAgentVersion(
    agentId: string,
    version: string,
    patch: Partial<Omit<AgentVersionRecord, 'id' | 'agentId' | 'version'>>,
  ): Promise<AgentVersionRecord> {
    await simulateIo()
    const record = prototypeData.agentVersions.find(
      (item) => item.agentId === agentId && item.version === version,
    )
    if (!record) throw new Error(`Agent Version 不存在：${agentId}@${version}`)
    Object.assign(record, copy(patch))
    return copy(record)
  }

  async createAgentDraft(
    agent: AgentDefinition,
    version: AgentVersionRecord,
  ): Promise<{ agent: AgentDefinition; version: AgentVersionRecord }> {
    await simulateIo()
    if (prototypeData.agents.some((item) => item.id === agent.id)) {
      throw new Error(`Agent 标识已存在：${agent.id}`)
    }
    prototypeData.agents.unshift(copy(agent))
    prototypeData.agentVersions.unshift(copy(version))
    return { agent: copy(agent), version: copy(version) }
  }

  async appendAgentRelease(record: AgentReleaseRecord): Promise<AgentReleaseRecord> {
    await simulateIo()
    prototypeData.agentReleaseRecords.unshift(copy(record))
    return copy(record)
  }

  async createSkill(skill: SkillDefinition): Promise<SkillDefinition> {
    await simulateIo()
    if (prototypeData.skills.some((item) => item.id === skill.id)) {
      throw new Error(`Skill 标识已存在：${skill.id}`)
    }
    prototypeData.skills.unshift(copy(skill))
    return copy(skill)
  }

  async updateSkill(
    skillId: string,
    patch: Partial<Omit<SkillDefinition, 'id'>>,
  ): Promise<SkillDefinition> {
    await simulateIo()
    const skill = prototypeData.skills.find((item) => item.id === skillId)
    if (!skill) throw new Error(`Skill 不存在：${skillId}`)
    Object.assign(skill, copy(patch))
    return copy(skill)
  }

  async updateTool(
    toolId: string,
    patch: Partial<Omit<ToolDefinition, 'id'>>,
  ): Promise<ToolDefinition> {
    await simulateIo()
    const tool = prototypeData.tools.find((item) => item.id === toolId)
    if (!tool) throw new Error(`工具不存在：${toolId}`)
    Object.assign(tool, copy(patch))
    return copy(tool)
  }

  async createTool(tool: ToolDefinition): Promise<ToolDefinition> {
    await simulateIo()
    if (prototypeData.tools.some((item) => item.id === tool.id)) {
      throw new Error(`工具已存在：${tool.name}`)
    }
    prototypeData.tools.unshift(copy(tool))
    return copy(tool)
  }

  async updateConnector(
    connectorId: string,
    patch: Partial<Omit<ConnectorDefinition, 'id'>>,
  ): Promise<ConnectorDefinition> {
    await simulateIo()
    const connector = prototypeData.connectors.find((item) => item.id === connectorId)
    if (!connector) throw new Error(`连接器不存在：${connectorId}`)
    Object.assign(connector, copy(patch))
    return copy(connector)
  }

  async updateToolPermissions(
    toolId: string,
    patch: Pick<ToolDefinition, 'allowedRoles' | 'dataScopes' | 'approvalPolicy'>,
  ): Promise<ToolDefinition> {
    await simulateIo()
    const tool = prototypeData.tools.find((item) => item.id === toolId)
    if (!tool) throw new Error(`工具不存在：${toolId}`)
    Object.assign(tool, copy(patch))
    return copy(tool)
  }

  async updateRuntime(
    runtimeId: string,
    patch: Partial<Omit<RuntimeDefinition, 'id'>>,
  ): Promise<RuntimeDefinition> {
    await simulateIo()
    const runtime = prototypeData.runtimes.find((item) => item.id === runtimeId)
    if (!runtime) throw new Error(`Runtime 不存在：${runtimeId}`)
    Object.assign(runtime, copy(patch))
    return copy(runtime)
  }
}

const prototypeData = {
  tasks: mockTasks,
  workspaces: mockWorkspaces,
  artifacts: mockArtifacts,
  agents: mockAgents,
  agentVersions: mockAgentVersions,
  agentReleaseRecords: mockAgentReleaseRecords,
  skills: mockSkills,
  tools: mockTools,
  connectors: mockConnectors,
  runtimes: mockRuntimes,
  auditEvents: mockAuditEvents,
  health: mockHealth,
  usage: mockUsage,
  modelUsage: mockModelUsage,
  users: prototypeUsers,
}

type PrototypeCollection = keyof typeof prototypeData
type PrototypeData = typeof prototypeData
