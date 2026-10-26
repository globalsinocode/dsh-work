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
  // 每个实例持有独立副本：P0 重置（POST /api/testing/p0/reset）新建实例即可回到初始数据，
  // 不能直接改模块级的 mock 数组，否则写入会跨实例泄漏。
  private readonly data: PrototypeData = copy(prototypeData)

  async read<K extends PrototypeCollection>(collection: K): Promise<PrototypeData[K]> {
    await simulateIo()
    return copy(this.data[collection])
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
    const agent = this.data.agents.find((item) => item.id === agentId)
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
    const record = this.data.agentVersions.find(
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
    if (this.data.agents.some((item) => item.id === agent.id)) {
      throw stateConflict(`Agent 标识已存在：${agent.id}`)
    }
    this.data.agents.unshift(copy(agent))
    this.data.agentVersions.unshift(copy(version))
    return { agent: copy(agent), version: copy(version) }
  }

  async createSkill(skill: SkillDefinition): Promise<SkillDefinition> {
    await simulateIo()
    if (this.data.skills.some((item) => item.id === skill.id)) {
      throw stateConflict(`Skill 标识已存在：${skill.id}`)
    }
    this.data.skills.unshift(copy(skill))
    return copy(skill)
  }

  async updateSkill(
    skillId: string,
    patch: Partial<Omit<SkillDefinition, 'id'>>,
  ): Promise<SkillDefinition> {
    await simulateIo()
    const skill = this.data.skills.find((item) => item.id === skillId)
    if (!skill) throw notFound(`Skill 不存在：${skillId}`)
    Object.assign(skill, copy(patch))
    return copy(skill)
  }

  async updateConnector(
    connectorId: string,
    patch: Partial<Omit<ConnectorDefinition, 'id'>>,
  ): Promise<ConnectorDefinition> {
    await simulateIo()
    const connector = this.data.connectors.find((item) => item.id === connectorId)
    if (!connector) throw notFound(`连接器不存在：${connectorId}`)
    Object.assign(connector, copy(patch))
    return copy(connector)
  }

  async updateRuntime(
    runtimeId: string,
    patch: Partial<Omit<RuntimeDefinition, 'id'>>,
  ): Promise<RuntimeDefinition> {
    await simulateIo()
    const runtime = this.data.runtimes.find((item) => item.id === runtimeId)
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
