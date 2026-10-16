import {
  mockAgents,
  mockAgentVersions,
  mockArtifactFiles,
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
  AgentVersionRecord,
  ConnectorDefinition,
  RuntimeDefinition,
  SkillDefinition,
  ToolDefinition,
} from '../../domain/types.ts'
import { notFound, stateConflict } from '../../domain/request-errors.ts'

const copy = <T>(value: T): T => structuredClone(value)

async function simulateIo() {
  await new Promise<void>((resolve) => setTimeout(resolve, 80))
}

/**
 * In-memory data for the P0 browser smoke server only. Never used by the application:
 * production always reads PostgreSQL. Edits are lost on restart by design.
 */
export class SmokeRepository {
  async read<K extends PrototypeCollection>(collection: K): Promise<PrototypeData[K]> {
    await simulateIo()
    return copy(prototypeData[collection])
  }

  /**
   * Prototype 成果文件内容：只有 `mockArtifactFiles` 登记过的种子成果（当前为
   * HTML 预览用例）提供字节，其余保持「原型无内容」的明确 404。
   */
  async readArtifactFile(
    artifactId: string,
  ): Promise<{ name: string; mimeType: string; bytes: Buffer }> {
    await simulateIo()
    const file = mockArtifactFiles[artifactId]
    if (!file) throw notFound(`成果内容不存在：${artifactId}`)
    return { name: file.name, mimeType: file.mimeType, bytes: Buffer.from(file.content, 'utf8') }
  }

  async updateAgent(
    agentId: string,
    patch: Partial<Omit<AgentDefinition, 'id'>>,
  ): Promise<AgentDefinition> {
    await simulateIo()
    const agent = prototypeData.agents.find((item) => item.id === agentId)
    if (!agent) throw notFound(`Agent 不存在：${agentId}`)
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
    if (!record) throw notFound(`Agent Version 不存在：${agentId}@${version}`)
    Object.assign(record, copy(patch))
    return copy(record)
  }

  async createAgentDraft(
    agent: AgentDefinition,
    version: AgentVersionRecord,
  ): Promise<{ agent: AgentDefinition; version: AgentVersionRecord }> {
    await simulateIo()
    if (prototypeData.agents.some((item) => item.id === agent.id)) {
      throw stateConflict(`Agent 标识已存在：${agent.id}`)
    }
    prototypeData.agents.unshift(copy(agent))
    prototypeData.agentVersions.unshift(copy(version))
    return { agent: copy(agent), version: copy(version) }
  }

  async createSkill(skill: SkillDefinition): Promise<SkillDefinition> {
    await simulateIo()
    if (prototypeData.skills.some((item) => item.id === skill.id)) {
      throw stateConflict(`Skill 标识已存在：${skill.id}`)
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
    if (!skill) throw notFound(`Skill 不存在：${skillId}`)
    Object.assign(skill, copy(patch))
    return copy(skill)
  }

  async updateTool(
    toolId: string,
    patch: Partial<Omit<ToolDefinition, 'id'>>,
  ): Promise<ToolDefinition> {
    await simulateIo()
    const tool = prototypeData.tools.find((item) => item.id === toolId)
    if (!tool) throw notFound(`工具不存在：${toolId}`)
    Object.assign(tool, copy(patch))
    return copy(tool)
  }

  async createTool(tool: ToolDefinition): Promise<ToolDefinition> {
    await simulateIo()
    if (prototypeData.tools.some((item) => item.id === tool.id)) {
      throw stateConflict(`工具已存在：${tool.name}`)
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
    if (!connector) throw notFound(`连接器不存在：${connectorId}`)
    Object.assign(connector, copy(patch))
    return copy(connector)
  }

  async updateToolPermissions(
    toolId: string,
    patch: Pick<ToolDefinition, 'allowedRoleIds' | 'allowedRoles' | 'dataScopes' | 'approvalPolicy'>,
  ): Promise<ToolDefinition> {
    await simulateIo()
    const tool = prototypeData.tools.find((item) => item.id === toolId)
    if (!tool) throw notFound(`工具不存在：${toolId}`)
    Object.assign(tool, copy(patch))
    return copy(tool)
  }

  async updateRuntime(
    runtimeId: string,
    patch: Partial<Omit<RuntimeDefinition, 'id'>>,
  ): Promise<RuntimeDefinition> {
    await simulateIo()
    const runtime = prototypeData.runtimes.find((item) => item.id === runtimeId)
    if (!runtime) throw notFound(`Runtime 不存在：${runtimeId}`)
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
