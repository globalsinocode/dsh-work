import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentReleaseState, AgentTrialCaseRun, AgentVersionRecord } from '@/types/domain'
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
        manualReview: { required: true, rubric: '结果符合预期' },
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
        outputExcerpt: '结果', verdict: 'passed',
      })) }],
    }],
    evidence: {}, packageWarnings: [],
  }
  vi.spyOn(adminApi, 'ensureAgentReleaseCandidate').mockResolvedValue(state)
  const publish = vi.spyOn(adminApi, 'publishAgentRelease').mockResolvedValue({
    candidate: undefined, trialRuns: state.trialRuns, evidence: {}, packageWarnings: [],
  })
  vi.spyOn(adminApi, 'getAgentReleaseSubmissions').mockResolvedValue({ items: [] })
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)

  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  content.$patch({
    agents: [{
      id: agentId, name: '单次审核 Agent', description: '审核流程测试', owner: '平台管理员',
      department: '治理', visibility: '指定角色', roleIds: ['role-employee'],
      dataScopes: [], allowWorkspaceJoin: false, status: 'draft', version: '0.1.0',
      welcomeMessage: '', examplePrompts: [], systemPrompt: '你是测试 Agent。',
      maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
      skills: [], tools: [], updatedAt: '2026-09-23T00:00:00.000Z',
    } satisfies AgentDefinition],
    agentVersions: [{
      id: 'agent-version-one-step', agentId, version: '0.1.0', status: 'draft',
      createdAt: '2026-09-23T00:00:00.000Z', createdBy: 'admin', summary: '', visibility: '指定角色',
      roleIds: ['role-employee'], dataScopes: [], welcomeMessage: '', examplePrompts: [],
      systemPrompt: '你是测试 Agent。', maxOutputBytes: 65536, maxToolCalls: 20,
      timeoutSeconds: 300, skills: [], tools: [],
    } satisfies AgentVersionRecord],
  })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agents/:agentId/release/review', name: 'agent-release-review', component: AgentReleaseWorkbenchView },
    { path: '/agents/:agentId/release/trial', name: 'agent-release-trial', component: AgentReleaseWorkbenchView },
    { path: '/agents/:agentId/release/checks', name: 'agent-release-checks', component: AgentReleaseWorkbenchView },
  ] })
  await router.push(`/agents/${agentId}/release/review`)
  await router.isReady()
  const wrapper = mount(AgentReleaseWorkbenchView, {
    global: { plugins: [pinia, router, ElementPlus], stubs: { teleport: true } },
  })
  try {
    await flushPromises()
    expect(wrapper.find('[data-action="submit-agent-release"]').exists()).toBe(false)
    const action = wrapper.get('[data-action="publish-agent"]')
    expect(action.text()).toContain('审核通过并发布')
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
