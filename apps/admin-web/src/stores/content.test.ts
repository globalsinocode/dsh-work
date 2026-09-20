import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentDefinition, GrantSourceReconciliationView, SkillDefinition, SkillReleaseRecord, SkillVersionRecord } from '../types/domain'

const api = vi.hoisted(() => ({
  getAgentReleaseRecords: vi.fn(),
  getAgents: vi.fn(),
  getAgentVersions: vi.fn(),
  getAgentJoinedWorkspaces: vi.fn(),
  getAuditEvents: vi.fn(),
  getConnectors: vi.fn(),
  getGrantSourceReconciliation: vi.fn(),
  getHealth: vi.fn(),
  getOperationsSummary: vi.fn(),
  getPlatformStatus: vi.fn(),
  getRuntimes: vi.fn(),
  getSession: vi.fn(),
  getSkillReleaseRecords: vi.fn(),
  getSkills: vi.fn(),
  getSkillVersions: vi.fn(),
  getTasks: vi.fn(),
  getTools: vi.fn(),
  getToolCatalog: vi.fn(),
  getUsage: vi.fn(),
  getWorkspaces: vi.fn(),
  reconcileGrantSources: vi.fn(),
  addTool: vi.fn(),
  rollbackSkill: vi.fn(),
  setAgentWorkspaceJoin: vi.fn(),
  setSkillStatus: vi.fn(),
}))
vi.mock('../api/client', () => ({ adminApi: api }))

describe('admin content store Skill version state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('marks the published draft in version history without a page reload', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    const release = makeRelease({ action: 'published', version: '0.2.0' })
    store.$patch({
      skills: [makeSkill({ version: '0.2.0', activeVersion: '0.1.0', status: 'draft' })],
      skillVersions: [makeVersion({ version: '0.2.0', status: 'draft' })],
    })
    api.setSkillStatus.mockResolvedValue({
      skill: makeSkill({ version: '0.2.0', activeVersion: '0.2.0', status: 'published' }),
      release,
    })

    await store.setSkillStatus('skill-reporting', 'published')

    expect(store.skillVersions[0]).toMatchObject({
      status: 'published',
      publishedAt: release.time,
      publishedBy: release.actor,
    })
    expect(store.skillReleaseRecords).toEqual([release])
  })

  it('disables the discarded draft in version history after rollback', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    const release = makeRelease({ action: 'rollback', version: '0.1.0' })
    store.$patch({
      skills: [makeSkill({ version: '0.2.0', activeVersion: '0.1.0', status: 'draft' })],
      skillVersions: [
        makeVersion({ id: 'skill-version-draft', version: '0.2.0', status: 'draft' }),
        makeVersion({ id: 'skill-version-target', version: '0.1.0', status: 'published' }),
      ],
    })
    api.rollbackSkill.mockResolvedValue({
      skill: makeSkill({ version: '0.1.0', activeVersion: '0.1.0', status: 'published' }),
      release,
    })

    await store.rollbackSkill('skill-reporting', '0.1.0')

    expect(store.skillVersions.find(item => item.id === 'skill-version-draft')?.status).toBe('disabled')
    expect(store.skillVersions.find(item => item.id === 'skill-version-target')?.status).toBe('published')
    expect(store.skillReleaseRecords).toEqual([release])
  })

  it('loads only audit endpoints for an audit-only session', async () => {
    const { useAuthStore } = await import('./auth')
    const { useContentStore } = await import('./content')
    const authStore = useAuthStore()
    api.getSession.mockResolvedValue({
      identityProvider: 'ai-hub-oidc',
      apiAudience: 'admin',
      permissions: ['audit:read'],
      user: {
        id: 'U00019', name: '安全审计员', title: '审计员', department: '信息安全部',
        avatarText: '审', role: 'auditor', dataScopes: [],
      },
    })
    await authStore.load()
    api.getAuditEvents.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
    api.getOperationsSummary.mockResolvedValue({
      runs24h: 0,
      modelTokens24h: 0,
      attentionEvents24h: 0,
    })

    const store = useContentStore()
    await store.load()

    expect(api.getAuditEvents).toHaveBeenCalledOnce()
    expect(api.getOperationsSummary).toHaveBeenCalledOnce()
    expect(api.getTasks).not.toHaveBeenCalled()
    expect(api.getAgents).not.toHaveBeenCalled()
  })
})

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'skill-reporting',
    name: '报告生成',
    version: '0.1.0',
    activeVersion: '0.1.0',
    category: '写作',
    owner: '平台管理员',
    status: 'published',
    description: '生成结构化业务报告。',
    instructions: '根据用户输入生成结构化业务报告，并标记数据来源。',
    toolIds: ['tool-read'],
    testPrompt: '生成本周业务报告',
    updatedAt: '2026-08-31 10:00',
    ...overrides,
  }
}

function makeVersion(overrides: Partial<SkillVersionRecord> = {}): SkillVersionRecord {
  return {
    id: 'skill-version-reporting-1',
    skillId: 'skill-reporting',
    version: '0.1.0',
    name: '报告生成',
    category: '写作',
    description: '生成结构化业务报告。',
    instructions: '根据用户输入生成结构化业务报告，并标记数据来源。',
    toolIds: ['tool-read'],
    testPrompt: '生成本周业务报告',
    status: 'published',
    createdAt: '2026-08-31 09:00',
    createdBy: '平台管理员',
    summary: 'Skill 版本',
    ...overrides,
  }
}

function makeRelease(overrides: Partial<SkillReleaseRecord> = {}): SkillReleaseRecord {
  return {
    id: 'skill-release-reporting-1',
    skillId: 'skill-reporting',
    version: '0.1.0',
    action: 'published',
    actor: '平台管理员',
    time: '2026-08-31 10:30',
    note: 'Skill 状态变更',
    ...overrides,
  }
}

describe('admin content store Agent 治理与授权来源对账', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('切换 allow_workspace_join 后就地更新 Agent 治理状态', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    store.$patch({ agents: [makeAgent({ allowWorkspaceJoin: true })] })
    api.setAgentWorkspaceJoin.mockResolvedValue({ agent: makeAgent({ allowWorkspaceJoin: false }) })

    const agent = await store.setAgentWorkspaceJoin('agent-t7', false)

    expect(api.setAgentWorkspaceJoin).toHaveBeenCalledWith({ agentId: 'agent-t7', allowWorkspaceJoin: false })
    expect(agent.allowWorkspaceJoin).toBe(false)
    expect(store.agents[0]?.allowWorkspaceJoin).toBe(false)
  })

  it('按 Agent 缓存只读的「已加入空间」清单', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    api.getAgentJoinedWorkspaces.mockResolvedValue({
      items: [{
        workspaceId: 'ws-team-1',
        workspaceName: '供应链经营分析',
        workspaceType: 'team',
        workspaceStatus: 'active',
        memberStatus: 'available',
        version: '1.0.0',
        addedBy: 'U00001',
        createdAt: '2026-09-10T00:00:00.000Z',
      }],
    })

    const items = await store.loadAgentJoinedWorkspaces('agent-t7')

    expect(api.getAgentJoinedWorkspaces).toHaveBeenCalledWith('agent-t7')
    expect(items).toHaveLength(1)
    expect(store.agentJoinedWorkspaces['agent-t7']).toEqual(items)
  })

  it('对账完成后刷新对账清单，legacy 来源不再出现', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    const before: GrantSourceReconciliationView = {
      items: [makeReconciliationItem()],
      workspaceSummary: [{ workspaceId: 'ws-supply', workspaceName: '供应链经营分析', unresolvedCount: 1 }],
    }
    const after: GrantSourceReconciliationView = { items: [], workspaceSummary: [] }
    api.reconcileGrantSources.mockResolvedValue({ reconciled: 1, sourceIds: ['wgs-legacy-1'], workspaceIds: ['ws-supply'] })
    api.getGrantSourceReconciliation.mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    await store.loadGrantSourceReconciliation()
    expect(store.grantReconciliation?.items).toHaveLength(1)

    const result = await store.reconcileGrantSources(['wgs-legacy-1'])

    expect(api.reconcileGrantSources).toHaveBeenCalledWith({ sourceIds: ['wgs-legacy-1'] })
    expect(result.reconciled).toBe(1)
    expect(store.grantReconciliation?.items).toHaveLength(0)
    expect(api.getGrantSourceReconciliation).toHaveBeenCalledTimes(2)
  })
})

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-t7',
    name: 'T7 治理 Agent',
    description: 'T7 治理与对账测试。',
    owner: '平台管理员',
    department: '数字化中心',
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized'],
    allowWorkspaceJoin: true,
    status: 'published',
    version: '1.0.0',
    welcomeMessage: '你好',
    examplePrompts: ['测试'],
    systemPrompt: '你是 T7 测试 Agent。',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    updatedAt: '2026-09-10 10:00',
    ...overrides,
  }
}

function makeReconciliationItem() {
  return {
    sourceId: 'wgs-legacy-1',
    workspaceId: 'ws-supply',
    workspaceName: '供应链经营分析',
    capabilityType: 'agent' as const,
    capabilityVersionId: 'agent-version-dsh-work-assistant-1',
    capabilityLabel: 'dsh-work Assistant v1.2.0',
    createdBy: 'U00001',
    createdAt: '2026-09-10T00:00:00.000Z',
    possibleAgents: [{
      agentId: 'agent-dsh-work-assistant',
      agentName: 'dsh-work Assistant',
      versionId: 'agent-version-dsh-work-assistant-1',
      version: '1.2.0',
      agentStatus: 'published',
    }],
    inferenceNote: '仅提示不自动回填。',
  }
}
