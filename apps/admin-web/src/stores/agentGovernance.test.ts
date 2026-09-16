import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adminApi } from '../api/client'
import type { AgentReleaseState, AgentDefinition } from '../types/domain'
import { useAgentGovernanceStore } from './agentGovernance'
import { useContentStore } from './content'

function makeCandidate(agentId: string, overrides: Partial<NonNullable<AgentReleaseState['candidate']>> = {}) {
  return {
    id: 'submission-1',
    agentId,
    agentVersionId: 'agent-version-1',
    version: '0.1.0',
    revision: 1,
    status: 'draft' as const,
    source: 'config' as const,
    cases: [
      { id: 'case-1', name: '正常任务', kind: 'success' as const, input: '生成摘要', expect: '返回摘要' },
      { id: 'case-2', name: '无效输入', kind: 'invalid_input' as const, input: '开始', expect: '提示补充范围' },
      { id: 'case-3', name: '越权请求', kind: 'permission_denied' as const, input: '读取薪酬', expect: '拒绝访问' },
    ],
    packageRefs: { skills: [], tools: [] },
    missingDeps: { skills: [], tools: [] },
    checks: [],
    plan: [],
    ...overrides,
  }
}

function makeState(agentId: string, overrides: Partial<AgentReleaseState> = {}): AgentReleaseState {
  return {
    candidate: makeCandidate(agentId),
    trialRuns: [],
    evidence: {},
    packageWarnings: [],
    ...overrides,
  }
}

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    name: '导入 Agent',
    description: 'ZIP 导入的 Agent。',
    owner: '测试管理员',
    department: '测试部门',
    visibility: '指定角色',
    roleIds: ['role-employee'],
    dataScopes: ['workspace:authorized'],
    allowWorkspaceJoin: false,
    status: 'draft',
    version: '0.1.0',
    welcomeMessage: '',
    examplePrompts: [],
    systemPrompt: '你是测试 Agent。',
    maxTokens: 8000,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    updatedAt: '2026-09-16 10:00',
  }
}

describe('agent governance store（服务端持久化）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('懒加载发布状态并把试运行并入候选', async () => {
    const state = makeState('agent-1', {
      candidate: makeCandidate('agent-1', { revision: 2 }),
      trialRuns: [{
        id: 'trial-1',
        submissionRevision: 2,
        status: 'passed',
        steps: [],
        startedAt: '2026-09-16T10:00:00.000Z',
      }],
    })
    const getState = vi.spyOn(adminApi, 'getAgentReleaseState').mockResolvedValue(state)
    const store = useAgentGovernanceStore()

    expect(store.candidateFor('agent-1', '0.1.0')).toBeUndefined()
    await vi.waitFor(() => expect(getState).toHaveBeenCalledWith('agent-1'))
    await vi.waitFor(() => {
      const candidate = store.overlays['agent-1']?.candidate
      expect(candidate?.revision).toBe(2)
      expect(candidate?.trialRuns[0]?.status).toBe('passed')
    })
  })

  it('无草稿且无提交时不触发加载', () => {
    const getState = vi.spyOn(adminApi, 'getAgentReleaseState')
    const store = useAgentGovernanceStore()
    expect(store.candidateFor('agent-none')).toBeUndefined()
    expect(getState).not.toHaveBeenCalled()
  })

  it('运行检查后合并检查与计划结果', async () => {
    const state = makeState('agent-2', {
      candidate: makeCandidate('agent-2', {
        checks: [
          { id: 'manifest', label: '定义格式与字段', status: 'passed', detail: '字段齐全' },
          { id: 'cases', label: '案例覆盖与有效性', status: 'passed', detail: '三类齐全' },
        ],
      }),
    })
    vi.spyOn(adminApi, 'runAgentReleaseChecks').mockResolvedValue(state)
    const store = useAgentGovernanceStore()

    const checks = await store.runChecks('agent-2')
    expect(checks).toHaveLength(2)
    expect(store.overlays['agent-2']?.candidate?.checks[0]?.status).toBe('passed')
    expect(store.submissions['agent-2']?.status).toBe('draft')
  })

  it('发布成功后刷新提交索引并展示版本证据', async () => {
    const state = makeState('agent-3', {
      candidate: makeCandidate('agent-3', { status: 'published', sealedRevision: 1 }),
      evidence: {
        '0.1.0': [
          { kind: 'configuration_checked', summary: '检查通过', at: '2026-09-16T10:00:00.000Z', by: 'platform', scope: 'submission-rev-1' },
          { kind: 'business_accepted', summary: '业务效果已确认', at: '2026-09-16T10:01:00.000Z', by: '管理员', scope: 'enterprise' },
        ],
      },
    })
    vi.spyOn(adminApi, 'publishAgentRelease').mockResolvedValue(state)
    vi.spyOn(adminApi, 'getAgentReleaseSubmissions').mockResolvedValue({ items: [] })
    const contentStore = useContentStore()
    const reload = vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    const store = useAgentGovernanceStore()

    await store.reviewAndPublish('agent-3', '0.1.0', '测试管理员', '确认发布')

    expect(store.overlays['agent-3']?.candidate?.status).toBe('published')
    const governance = store.versionGovernance('agent-3', '0.1.0')
    expect(governance.evidence).toHaveLength(2)
    expect(reload).toHaveBeenCalledWith(true)
  })

  it('导入发布包后返回服务端创建的 Agent', async () => {
    const agent = makeAgent('agent-zip')
    const state = makeState('agent-zip', { candidate: makeCandidate('agent-zip', { source: 'zip' }) })
    vi.spyOn(adminApi, 'importAgentPackage').mockResolvedValue(state)
    vi.spyOn(adminApi, 'getAgentReleaseSubmissions').mockResolvedValue({
      items: [{ agentId: 'agent-zip', revision: 1, status: 'draft', source: 'zip' }],
    })
    const contentStore = useContentStore()
    vi.spyOn(contentStore, 'load').mockImplementation(async () => {
      contentStore.agents = [agent]
    })
    const store = useAgentGovernanceStore()

    const file = new File(['zip'], 'agent.zip', { type: 'application/zip' })
    const result = await store.importPackage(file)

    expect(result.agent.id).toBe('agent-zip')
    expect(store.overlays['agent-zip']?.candidate?.source).toBe('zip')
    expect(store.submissions['agent-zip']?.source).toBe('zip')
  })

  it('版本证据索引按 agent + version 归并', async () => {
    vi.spyOn(adminApi, 'getAgentVersionEvidence').mockResolvedValue({
      items: [{
        agentId: 'agent-4',
        version: '1.0.0',
        evidence: [
          { kind: 'business_accepted', summary: '验收通过', at: '2026-09-01T09:00:00.000Z', by: '管理员', scope: 'enterprise' },
        ],
      }],
    })
    const store = useAgentGovernanceStore()
    await store.loadEvidenceIndex()
    expect(store.versionGovernance('agent-4', '1.0.0').evidence).toHaveLength(1)
    expect(store.versionGovernance('agent-4', '9.9.9').evidence).toHaveLength(0)
  })
})
