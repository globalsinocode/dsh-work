import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useAgentGovernanceStore } from '@/stores/agentGovernance'
import { useContentStore } from '@/stores/content'
import type { AgentAccess, AgentDefinition, AgentReleaseState, AgentTrialCaseRun, AgentVersionRecord } from '@/types/domain'
import AgentReleaseWorkbenchView from './AgentReleaseWorkbenchView.vue'

afterEach(() => vi.restoreAllMocks())

it('试运行通过后一次审核确认即发布草稿候选', async () => {
  const agentId = 'agent-one-step-review'
  const kinds: AgentTrialCaseRun['kind'][] = [
    'success', 'invalid_input', 'permission_denied', 'prompt_injection', 'capability_failure',
  ]
  const state: AgentReleaseState = {
    candidate: {
      id: 'submission-one-step', agentId, agentVersionId: 'agent-version-one-step',
      version: '0.1.0', revision: 1, sealedRevision: 1, status: 'draft', source: 'config',
      bindingRefs: [], packageRefs: { skills: [], tools: [] }, missingDeps: { skills: [], tools: [] },
      cases: kinds.map(kind => ({
        id: `case-${kind}`, name: kind, kind, input: kind,
        evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
        automatedAssertions: ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'],
        // PostgreSQL JSONB returns the shorter rubric key before required.
        manualReview: { rubric: '结果符合预期', required: true },
      })),
      checks: [{ id: 'definition', label: '定义检查', status: 'passed', detail: '通过' }], plan: [],
    },
    trialRuns: [{
      id: 'trial-one-step', submissionRevision: 1, status: 'passed',
      startedAt: '2026-09-23T00:00:00.000Z',
      steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: kinds.map(kind => ({
        caseId: `case-${kind}`, name: kind, kind, evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
        automatedAssertions: [
          { assertion: 'run_attempt_recorded', passed: true, detail: 'Run/Attempt 已记录' },
          { assertion: 'execution_succeeded', passed: true, detail: '执行成功' },
          { assertion: 'output_non_empty', passed: true, detail: '输出非空' },
        ],
        manualReview: { required: true, rubric: '结果符合预期' },
        runId: `run-${kind}`, attemptId: `attempt-${kind}`, status: 'succeeded',
        outputExcerpt: kind === 'success' ? `结果${'后续核验内容'.repeat(60)}` : '结果', verdict: 'passed',
      })) }],
    }],
    evidence: {}, packageWarnings: [],
  }
  vi.spyOn(adminApi, 'ensureAgentReleaseCandidate').mockResolvedValue(state)
  const publish = vi.spyOn(adminApi, 'publishAgentRelease').mockResolvedValue({
    candidate: undefined, trialRuns: state.trialRuns, evidence: {}, packageWarnings: [],
  })
  vi.spyOn(adminApi, 'getAgentReleaseSubmissions').mockResolvedValue({ items: [] })
  const accessState = reactive<AgentAccess>({
    agentId, revision: 1, principalId: `principal-agent-${agentId}`, principalStatus: 'active',
    visibleRoleIds: ['role-employee'], roleIds: [], dataScopes: [],
    roleOptions: [{ id: 'role-employee', name: '员工', status: 'active' }], scopeOptions: [],
    capabilities: [], collections: [], routines: [],
  })
  vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(accessState)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)

  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  content.$patch({
    agents: [{
      id: agentId, name: '单次审核 Agent', description: '审核流程测试', owner: '平台管理员',
      department: '治理', visibility: '指定角色', roleIds: ['role-employee'],
      allowWorkspaceJoin: false, status: 'draft', version: '0.1.0',
      welcomeMessage: '', examplePrompts: [], systemPrompt: '你是测试 Agent。',
      maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
      skills: [], tools: [], updatedAt: '2026-09-23T00:00:00.000Z',
    } satisfies AgentDefinition],
    agentVersions: [{
      id: 'agent-version-one-step', agentId, version: '0.1.0', status: 'draft',
      createdAt: '2026-09-23T00:00:00.000Z', createdBy: 'admin', summary: '',
      welcomeMessage: '', examplePrompts: [],
      systemPrompt: '你是测试 Agent。', maxOutputBytes: 65536, maxToolCalls: 20,
      timeoutSeconds: 300, skills: [], tools: [],
    } satisfies AgentVersionRecord],
  })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:agentId/release/review', name: 'agent-release-review', component: AgentReleaseWorkbenchView },
    { path: '/agents/:agentId/release/trial', name: 'agent-release-trial', component: AgentReleaseWorkbenchView },
  ] })
  await router.push(`/agents/${agentId}/release/review`)
  await router.isReady()
  const wrapper = mount(AgentReleaseWorkbenchView, {
    global: { plugins: [pinia, router, ElementPlus], stubs: { teleport: true } },
  })
  try {
    await flushPromises()
    await router.push(`/agents/${agentId}/release/trial`)
    await flushPromises()
    expect(wrapper.text()).toContain('岗位权限')
    expect(wrapper.text()).toContain('1 个可见角色 · 0 个岗位角色 · 0 个数据范围')
    expect(wrapper.text()).not.toContain('验证前还需授权')
    expect(wrapper.get('.stage-footer--forward').text()).toContain('验证通过，确认发布')
    // 平台默认能力缺授权时只是不装配，不阻断验证。
    accessState.capabilities = [{
      reference: 'grep@1.0.0', name: '内容搜索', source: 'default',
      requiredRoleIds: ['role-employee'], requiredScopes: [], missingRole: true, missingScopes: [],
    }]
    await flushPromises()
    expect(wrapper.text()).not.toContain('验证前还需授权')
    // 已声明能力缺少角色或数据范围时阻断验证，并指出缺什么。
    accessState.capabilities = [{
      reference: 'read@1.0.0', name: '读取文本文件', source: 'declared',
      requiredRoleIds: ['role-employee'], requiredScopes: ['workspace:authorized'], missingRole: true,
      missingScopes: ['workspace:authorized'],
    }]
    await flushPromises()
    expect(wrapper.text()).toContain('读取文本文件 所需的岗位角色')
    expect(wrapper.text()).toContain('读取文本文件 所需的数据范围 workspace:authorized')
    accessState.capabilities = [{ ...accessState.capabilities[0]!, missingRole: false, missingScopes: [] }]
    await flushPromises()
    expect(wrapper.text()).not.toContain('验证前还需授权')
    accessState.visibleRoleIds = []
    await flushPromises()
    expect(wrapper.text()).toContain('还没有设置可见角色')
    accessState.visibleRoleIds = ['role-employee']
    await flushPromises()
    expect(wrapper.get('.case-run__output').text()).toContain('后续核验内容'.repeat(60))
    expect(wrapper.find('[aria-label="Agent 候选发布流程"]').exists()).toBe(false)
    expect(wrapper.find('.definition-card').exists()).toBe(false)
    expect(wrapper.text()).toContain('单次审核 Agent')
    expect(wrapper.text()).not.toContain('查看配置摘要')
    expect(wrapper.text()).not.toContain('试运行进度')
    expect(wrapper.text()).not.toContain('历史试运行')

    const failedState: AgentReleaseState = {
      ...state,
      trialRuns: [{
        id: 'trial-preflight-failed', submissionRevision: 1, status: 'failed',
        startedAt: '2026-09-23T01:00:00.000Z',
        steps: [{ id: 'dispatch', label: 'DSH 执行评估案例', status: 'failed', detail: '案例派发失败：Runtime 不可用' }],
      }, ...state.trialRuns],
    }
    vi.mocked(adminApi.ensureAgentReleaseCandidate).mockResolvedValueOnce(failedState)
    await useAgentGovernanceStore().ensureCandidate(agentId)
    await flushPromises()
    expect(wrapper.text()).toContain('案例派发失败：Runtime 不可用')
    expect(wrapper.findAll('.case-tab-label')[0]?.text()).toContain('待运行')
    expect(wrapper.findAll('.case-tab-label')[1]?.text()).toContain('未开始')

    const failedRun = {
      ...state.trialRuns[0]!.steps[0]!.caseRuns![0]!,
      runId: null, attemptId: null, status: 'failed', outputExcerpt: '',
      error: 'Agent 身份尚未获得试运行所需的角色和数据授权', verdict: undefined,
    }
    vi.mocked(adminApi.ensureAgentReleaseCandidate).mockResolvedValueOnce({
      ...failedState,
      trialRuns: [{ ...failedState.trialRuns[0]!, steps: [{
        id: 'dispatch', label: 'DSH 执行评估案例', status: 'failed',
        detail: '案例派发失败：正常任务 failed', caseRuns: [failedRun],
      }] }, ...state.trialRuns],
    })
    await useAgentGovernanceStore().ensureCandidate(agentId)
    await flushPromises()
    expect(wrapper.get('.case-feedback').text()).toContain('Agent 身份尚未获得试运行所需的角色和数据授权')
    expect(wrapper.get('.case-feedback').text()).not.toContain('案例派发失败：正常任务 failed')
    expect(wrapper.findAll('.case-tab-label')[0]?.text()).toContain('失败')
    expect(wrapper.findAll('.case-tab-label')[1]?.text()).toContain('未开始')
    expect(wrapper.find('.case-run__output').exists()).toBe(false)
    expect(wrapper.get('.case-run__details').text()).toContain('自动检查')

    const firstCase = state.candidate!.cases[0]!
    const runningTrial: AgentReleaseState = {
      ...state,
      trialRuns: [{
        id: 'trial-live-progress', submissionRevision: 1, status: 'executing',
        startedAt: '2026-09-23T01:10:00.000Z',
        steps: [
          { id: 'seal', label: '封存定义、依赖与绑定', status: 'passed' },
          { id: 'static', label: '静态检查与测试准入复核', status: 'passed' },
          { id: 'queue', label: '排队与运行准备', status: 'passed' },
          { id: 'dsh', label: 'DSH 执行评估案例', status: 'running', currentCaseId: firstCase.id },
        ],
        progress: { caseId: firstCase.id, runId: 'run-live', attemptId: 'attempt-live', runStatus: 'running',
          events: [
            { type: 'run.queued', label: '已进入 Runtime 队列', occurredAt: '2026-09-23T01:10:00.000Z' },
            { type: 'run.started', label: 'DSH Worker 已启动', occurredAt: '2026-09-23T01:10:01.000Z' },
          ] },
      }],
    }
    const completedTrial: AgentReleaseState = {
      ...state,
      trialRuns: [{ ...runningTrial.trialRuns[0]!, status: 'asserting', steps: [
        ...runningTrial.trialRuns[0]!.steps.slice(0, 3),
        { id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', currentCaseId: firstCase.id,
          caseRuns: [{ ...state.trialRuns[0]!.steps[0]!.caseRuns![0]!, verdict: undefined }] },
      ] }],
    }
    vi.mocked(adminApi.ensureAgentReleaseCandidate).mockResolvedValueOnce({ ...state, trialRuns: [] })
    await useAgentGovernanceStore().ensureCandidate(agentId)
    let completeTrial!: (value: AgentReleaseState) => void
    const startTrial = vi.spyOn(adminApi, 'startAgentReleaseTrial').mockReturnValue(new Promise(resolve => { completeTrial = resolve }))
    const poll = vi.spyOn(adminApi, 'getAgentReleaseState').mockResolvedValue(runningTrial)
    await wrapper.get('.case-actions .el-button--primary').trigger('click')
    expect(wrapper.get('.case-process').attributes('open')).toBeDefined()
    expect(wrapper.get('.case-process').text()).toContain('正在提交并检查本项')
    await vi.waitFor(() => expect(wrapper.get('.case-process').text()).toContain('DSH Worker 已启动'))
    expect(startTrial).toHaveBeenCalledOnce()
    expect(poll).toHaveBeenCalled()
    expect(wrapper.get('.case-process').text()).toContain('DSH 执行评估案例')
    completeTrial(completedTrial)
    await flushPromises()
    expect(wrapper.get('.case-run__output').text()).toContain('后续核验内容')
    expect(wrapper.get('.case-process').attributes('open')).toBeUndefined()

    vi.mocked(adminApi.ensureAgentReleaseCandidate).mockResolvedValueOnce(state)
    await useAgentGovernanceStore().ensureCandidate(agentId)
    await flushPromises()
    await router.push(`/agents/${agentId}/release/review`)
    await flushPromises()
    expect(wrapper.find('[data-action="submit-agent-release"]').exists()).toBe(false)
    const action = wrapper.get('[data-action="publish-agent"]')
    expect(action.text()).toContain('确认发布')
    expect(action.attributes('disabled')).toBeUndefined()
    await wrapper.get('textarea').setValue('案例与权限已复核')
    await action.trigger('click')
    await flushPromises()
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(agentId, '案例与权限已复核')
    expect(wrapper.text()).toContain('发布完成')
  } finally {
    wrapper.unmount()
  }
})

it('发布确认页按来源版本列出变化与案例结论，技术标识收起', async () => {
  const agentId = 'agent-review-diff'
  const kinds: AgentTrialCaseRun['kind'][] = [
    'success', 'invalid_input', 'permission_denied', 'prompt_injection', 'capability_failure',
  ]
  const assertions = [
    { assertion: 'run_attempt_recorded' as const, passed: true, detail: 'Run/Attempt 已记录' },
    { assertion: 'execution_succeeded' as const, passed: true, detail: '执行成功' },
    { assertion: 'output_non_empty' as const, passed: true, detail: '输出非空' },
  ]
  const state: AgentReleaseState = {
    candidate: {
      id: 'submission-diff', agentId, agentVersionId: 'agent-version-diff-020',
      version: '0.2.0', revision: 3, sealedRevision: 3, status: 'draft', source: 'config',
      bindingRefs: [], packageRefs: { skills: [], tools: [] }, missingDeps: { skills: [], tools: [] },
      cases: kinds.map(kind => ({
        id: `case-${kind}`, name: kind, kind, input: `${kind} 输入`,
        evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
        automatedAssertions: ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'],
        manualReview: { required: true, rubric: '符合预期' },
      })),
      checks: [{ id: 'definition', label: '定义检查', status: 'passed', detail: '通过' }], plan: [],
    },
    trialRuns: [{
      id: 'trial-diff', submissionRevision: 3, status: 'passed', startedAt: '2026-10-13T00:00:00.000Z',
      steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: kinds.map(kind => ({
        caseId: `case-${kind}`, name: kind, kind, evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
        automatedAssertions: assertions, manualReview: { required: true, rubric: '符合预期' },
        runId: `run-${kind}`, attemptId: `attempt-${kind}`, status: 'succeeded', outputExcerpt: '结果', verdict: 'passed',
      })) }],
    }],
    evidence: {}, packageWarnings: [],
  }
  vi.spyOn(adminApi, 'ensureAgentReleaseCandidate').mockResolvedValue(state)
  vi.spyOn(adminApi, 'getAgentReleaseSubmissions').mockResolvedValue({ items: [] })
  vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue({
    agentId, revision: 1, principalId: `principal-agent-${agentId}`, principalStatus: 'active',
    visibleRoleIds: ['role-employee', 'role-manager'], roleIds: [], dataScopes: [],
    roleOptions: [
      { id: 'role-employee', name: '普通员工', status: 'active' },
      { id: 'role-manager', name: '部门负责人', status: 'active' },
    ],
    scopeOptions: [], capabilities: [], collections: [], routines: [],
  })

  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  const version = (overrides: Partial<AgentVersionRecord>): AgentVersionRecord => ({
    id: 'agent-version-diff-010', agentId, version: '0.1.0', status: 'published',
    createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'admin', summary: '',
    welcomeMessage: '', examplePrompts: [],
    systemPrompt: '旧的 Soul 内容', maxOutputBytes: 65536, maxToolCalls: 20,
    timeoutSeconds: 300, skills: [], tools: [], ...overrides,
  })
  content.$patch({
    agents: [{
      id: agentId, name: '差异 Agent', description: '差异测试', owner: '平台管理员',
      department: '治理', visibility: '指定角色', roleIds: ['role-employee', 'role-manager'],
      allowWorkspaceJoin: false, status: 'published', version: '0.2.0',
      welcomeMessage: '', examplePrompts: [], systemPrompt: '新的 Soul 内容',
      maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
      skills: [], tools: [], updatedAt: '2026-10-13T00:00:00.000Z',
    } satisfies AgentDefinition],
    agentVersions: [
      version({}),
      version({
        id: 'agent-version-diff-020', version: '0.2.0', status: 'draft', sourceVersion: '0.1.0',
        systemPrompt: '新的 Soul 内容', skills: ['report-writer@1.0.0'],
      }),
    ],
  })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:agentId/release/review', name: 'agent-release-review', component: AgentReleaseWorkbenchView },
    { path: '/agents/:agentId/release/trial', name: 'agent-release-trial', component: AgentReleaseWorkbenchView },
  ] })
  await router.push(`/agents/${agentId}/release/review`)
  await router.isReady()
  const wrapper = mount(AgentReleaseWorkbenchView, {
    global: { plugins: [pinia, router, ElementPlus], stubs: { teleport: true } },
  })
  try {
    await flushPromises()
    expect(wrapper.text()).toContain('将发布 v0.2.0，对比来源版本 v0.1.0')
    const changes = wrapper.get('[aria-label="本次变化"]')
    expect(changes.text()).toContain('2 项有变化')
    expect(changes.text()).toContain('SOUL.md')
    expect(changes.text()).toContain('report-writer@1.0.0')
    expect(changes.text()).toContain('未变化：AGENTS.md 工作规程')
    expect(changes.text()).not.toContain('运行限制超时')
    const conclusions = wrapper.get('[aria-label="验证结论"]')
    expect(conclusions.text()).toContain('5/5 项人工确认通过')
    expect(conclusions.text()).toContain('prompt_injection 输入')
    expect(wrapper.get('.review-technical').attributes('open')).toBeUndefined()
    expect(wrapper.get('.review-technical').text()).toContain('trial-diff')
  } finally {
    wrapper.unmount()
  }
})
