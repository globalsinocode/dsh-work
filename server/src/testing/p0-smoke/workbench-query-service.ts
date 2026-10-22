import type { SmokeRepository } from './smoke-repository.ts'

export class WorkbenchQueryService {
  private readonly repository: SmokeRepository

  constructor(repository: SmokeRepository) {
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
        versionId: `agent-version-${agent.id}-${agent.version.replace(/\./g, '')}`,
        versionReference: `${agent.id}@${agent.version}`,
        version: agent.version,
        publishedAt: agent.updatedAt,
        name: agent.name,
        description: agent.description,
        welcomeMessage: agent.welcomeMessage,
        examplePrompts: [...agent.examplePrompts],
      }))
  }

  async getSkills() {
    const skills = await this.repository.read('skills')
    return skills
      .filter(skill => skill.status === 'published')
      .map(skill => ({
        id: skill.id,
        versionId: `skill-version-${skill.id}-${skill.version.replace(/\./g, '')}`,
        versionReference: `${skill.id}@${skill.version}`,
        version: skill.version,
        publishedAt: skill.updatedAt,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        owner: skill.owner,
        testPrompt: skill.testPrompt,
        updatedAt: skill.updatedAt,
      }))
  }
}
