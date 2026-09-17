import type { PrototypeRepository } from '../../../infrastructure/prototype/prototype-repository.ts'

export class WorkbenchQueryService {
  private readonly repository: PrototypeRepository

  constructor(repository: PrototypeRepository) {
    this.repository = repository
  }

  getSession() {
    return this.repository.read('users').then((users) => ({
      user: users.employee,
      identityProvider: 'prototype-sso' as const,
      apiAudience: 'workbench' as const,
    }))
  }

  getTasks() {
    return this.repository.read('tasks')
  }

  getWorkspaces() {
    return this.repository.read('workspaces')
  }

  getArtifacts() {
    return this.repository.read('artifacts')
  }

  /** Prototype 成果内容：供无库模式下成果下载/预览路由读取确定性种子字节。 */
  getArtifactFile(artifactId: string) {
    return this.repository.readArtifactFile(artifactId)
  }

  async getAgents() {
    const agents = await this.repository.read('agents')
    return agents
      .filter(agent => agent.status === 'published')
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        welcomeMessage: agent.welcomeMessage,
        version: agent.version,
        examplePrompts: [...agent.examplePrompts],
      }))
  }

  async getSkills() {
    const skills = await this.repository.read('skills')
    return skills
      .filter(skill => skill.status === 'published')
      .map(skill => ({
        id: skill.id,
        name: skill.name,
        version: skill.version,
        category: skill.category,
        description: skill.description,
        owner: skill.owner,
        testPrompt: skill.testPrompt,
        updatedAt: skill.updatedAt,
      }))
  }
}
