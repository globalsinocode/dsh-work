import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type {
  AgentAccess,
  AgentDefinition,
  AgentReleaseOverview,
  AgentValidation,
  AgentVersionHistoryItem,
  ValidationCase,
} from '@/types/domain'
import AgentReleasePanel from './AgentReleasePanel.vue'

afterEach(() => vi.restoreAllMocks())

const agentId = 'agent-validation-ui'

const agent: AgentDefinition = {
  id: agentId, name: '验证页 Agent', description: '验证与发布页面测试', owner: '平台管理员',
  department: '治理', visibility: '指定角色', roleIds: ['role-employee'],
  allowWorkspaceJoin: false, status: 'draft', version: '0.1.0',
  welcomeMessage: '', examplePrompts: ['示例：总结周报'], systemPrompt: '你是测试 Agent。',
  maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  skills: [], tools: [], updatedAt: '2026-10-16T00:00:00.000Z',
}

function validationCase(overrides: Partial<ValidationCase>): ValidationCase {
  return {
    id: 'case-1', position: 0, source: 'example', sourceRef: null, prompt: '示例：总结周报',
    status: 'succeeded', runId: 'run-1', attemptId: 'attempt-1', runCount: 1,
    checks: { runRecorded: true, executionSucceeded: true, outputNonEmpty: true },
    output: '本周完成三项工作。', error: null, verdict: null, verdictNote: null, verdictBy: null,
    verdictAt: null, startedAt: '2026-10-16T00:00:00.000Z', finishedAt: '2026-10-16T00:00:05.000Z',
    ...overrides,
  }
}

function validation(cases: ValidationCase[]): AgentValidation {
  return {
    id: 'validation-1', agentId, agentVersionId: 'agent-version-1', version: '0.1.0',
    status: 'completed', createdBy: 'admin', createdAt: '2026-10-16T00:00:00.000Z',
    completedAt: '2026-10-16T00:00:06.000Z', cases,
    publishable: cases.every(item => item.verdict === 'passed'),
  }
}

function overview(current: AgentValidation | null): AgentReleaseOverview {
  return {
    agentId,
    activeVersion: null,
    draft: { id: 'agent-version-1', version: '0.1.0', status: 'candidate' },
    candidate: { id: 'agent-version-1', version: '0.1.0' },
    draftChanged: false,
    testCases: [{ id: 'test-case-1', prompt: '自定义：列出风险' }],
    plannedCases: [
      { source: 'example', sourceRef: null, prompt: '示例：总结周报' },
      { source: 'custom', sourceRef: 'test-case-1', prompt: '自定义：列出风险' },
    ],
    checks: [
      { id: 'audience', label: '可见角色', passed: true, detail: '1 个可见角色' },
      { id: 'cases', label: '验证案例', passed: true, detail: '2 个案例' },
    ],
    usesMcp: false,
    validation: current,
  }
}

async function mountView(history: AgentVersionHistoryItem[] = []) {
  const access: AgentAccess = {
    agentId, revision: 1, principalId: `principal-agent-${agentId}`, principalStatus: 'active',
    visibleRoleIds: ['role-employee'], roleIds: [], dataScopes: [],
    roleOptions: [{ id: 'role-employee', name: '员工', status: 'active' }], scopeOptions: [],
    capabilities: [], routines: [],
  }
  vi.spyOn(adminApi, 'getAgentAccess').mockResolvedValue(access)
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  const content = useContentStore()
  content.$patch({ agents: [agent] })
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  vi.spyOn(adminApi, 'getAgentVersionHistory').mockResolvedValue({ items: history })
  const wrapper = mount(AgentReleasePanel, {
    props: { agentId },
    global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

function button(wrapper: Awaited<ReturnType<typeof mountView>>, text: string) {
  const found = wrapper.findAll('button').find(item => item.text() === text)
  if (!found) throw new Error(`未找到按钮：${text}`)
  return found
}

it('全部案例判定通过后才能发布，发布提交当前验证', async () => {
  const pending = validation([
    validationCase({}),
    validationCase({ id: 'case-2', position: 1, source: 'custom', sourceRef: 'test-case-1', prompt: '自定义：列出风险' }),
  ])
  vi.spyOn(adminApi, 'getAgentRelease').mockResolvedValue({ agent, release: overview(pending) })
  vi.spyOn(adminApi, 'getAgentValidation').mockResolvedValue(pending)
  const judged = validation(pending.cases.map(item => ({ ...item, verdict: 'passed' as const })))
  const verdict = vi.spyOn(adminApi, 'setAgentValidationVerdict')
    .mockResolvedValueOnce(validation([judged.cases[0]!, pending.cases[1]!]))
    .mockResolvedValueOnce(judged)
  const publish = vi.spyOn(adminApi, 'publishAgent').mockResolvedValue({ ...overview(null), draft: null, candidate: null })

  const wrapper = await mountView()
  try {
    expect(wrapper.text()).toContain('验证前检查')
    expect(wrapper.text()).toContain('1 个可见角色 · 0 个岗位角色 · 0 个数据范围')
    expect(wrapper.text()).toContain('自定义：列出风险')
    expect(wrapper.text()).toContain('2/2 项运行结束 · 0 项判定通过')
    expect(wrapper.get('[data-action="publish-agent"]').attributes('disabled')).toBeDefined()

    const passButtons = () => wrapper.findAll('button').filter(item => item.text() === '通过')
    await passButtons()[0]!.trigger('click')
    await flushPromises()
    await passButtons()[0]!.trigger('click')
    await flushPromises()
    expect(verdict).toHaveBeenCalledWith(agentId, 'validation-1', 'case-1', { verdict: 'passed' })
    expect(verdict).toHaveBeenCalledWith(agentId, 'validation-1', 'case-2', { verdict: 'passed' })
    expect(wrapper.get('[data-action="publish-agent"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-action="publish-agent"]').trigger('click')
    await flushPromises()
    expect(publish).toHaveBeenCalledWith(agentId, { validationId: 'validation-1', note: '' })
    expect(wrapper.text()).toContain('发布完成')
  } finally {
    wrapper.unmount()
  }
})

it('机器检查未通过时只能判为不通过，且必须填写原因', async () => {
  const failed = validation([validationCase({
    status: 'interrupted', checks: { runRecorded: true, executionSucceeded: false, outputNonEmpty: false },
    output: '', error: '服务重启中断',
  })])
  vi.spyOn(adminApi, 'getAgentRelease').mockResolvedValue({ agent, release: overview(failed) })
  vi.spyOn(adminApi, 'getAgentValidation').mockResolvedValue(failed)
  const verdict = vi.spyOn(adminApi, 'setAgentValidationVerdict').mockResolvedValue(validation([
    { ...failed.cases[0]!, verdict: 'failed', verdictNote: '中断后没有回答' },
  ]))
  const rerun = vi.spyOn(adminApi, 'rerunAgentValidationCase').mockResolvedValue({ ...failed, status: 'completed' })

  const wrapper = await mountView()
  try {
    expect(wrapper.text()).toContain('服务重启中断')
    expect(button(wrapper, '通过').attributes('disabled')).toBeDefined()

    await button(wrapper, '不通过').trigger('click')
    expect(button(wrapper, '确认不通过').attributes('disabled')).toBeDefined()
    await wrapper.get('textarea[aria-label="案例 1 不通过原因"]').setValue('中断后没有回答')
    await button(wrapper, '确认不通过').trigger('click')
    await flushPromises()
    expect(verdict).toHaveBeenCalledWith(agentId, 'validation-1', 'case-1', { verdict: 'failed', note: '中断后没有回答' })
    expect(wrapper.text()).toContain('不通过原因：中断后没有回答')

    await button(wrapper, '重跑本项').trigger('click')
    await flushPromises()
    expect(rerun).toHaveBeenCalledWith(agentId, 'validation-1', 'case-1')
  } finally {
    wrapper.unmount()
  }
})

it('自定义测试问题未保存时不能开始验证', async () => {
  vi.spyOn(adminApi, 'getAgentRelease').mockResolvedValue({
    agent, release: { ...overview(null), draft: { id: 'agent-version-1', version: '0.1.0', status: 'draft' }, candidate: null },
  })
  const replace = vi.spyOn(adminApi, 'replaceAgentTestCases').mockImplementation(async (_id, prompts) => ({
    ...overview(null), draft: { id: 'agent-version-1', version: '0.1.0', status: 'draft' }, candidate: null,
    testCases: prompts.map((prompt, index) => ({ id: `test-case-${index + 1}`, prompt })),
  }))
  const start = vi.spyOn(adminApi, 'startAgentValidation').mockResolvedValue(overview(validation([
    validationCase({ status: 'running', checks: null, output: '', finishedAt: null }),
  ])))

  const wrapper = await mountView()
  try {
    expect(wrapper.get('[data-action="start-validation"]').attributes('disabled')).toBeUndefined()
    await button(wrapper, '添加问题').trigger('click')
    await wrapper.get('textarea[aria-label="自定义测试问题 2"]').setValue('自定义：说明权限边界')
    expect(wrapper.get('[data-action="start-validation"]').attributes('disabled')).toBeDefined()
    await button(wrapper, '保存测试问题').trigger('click')
    await flushPromises()
    expect(replace).toHaveBeenCalledWith(agentId, ['自定义：列出风险', '自定义：说明权限边界'])
    await wrapper.get('[data-action="start-validation"]').trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledWith(agentId)
    expect(wrapper.text()).toContain('正在运行，完成后自动刷新。')
  } finally {
    wrapper.unmount()
  }
})

it('版本历史可以回滚到曾发布的版本，当前版本没有回滚按钮', async () => {
  vi.spyOn(adminApi, 'getAgentRelease').mockResolvedValue({
    agent, release: { ...overview(null), draft: null, candidate: null, activeVersion: { id: 'agent-version-2', version: '0.2.0' } },
  })
  const history: AgentVersionHistoryItem[] = [
    { id: 'agent-version-2', version: '0.2.0', status: 'published', summary: '第二版', createdAt: '2026-10-16T01:00:00.000Z',
      createdBy: '管理员', publishedAt: '2026-10-16T01:10:00.000Z', publishedBy: '管理员', active: true },
    { id: 'agent-version-1', version: '0.1.0', status: 'published', summary: '第一版', createdAt: '2026-10-15T01:00:00.000Z',
      createdBy: '管理员', publishedAt: '2026-10-15T01:10:00.000Z', publishedBy: '管理员', active: false },
  ]
  const wrapper = await mountView(history)
  const content = useContentStore()
  const rollback = vi.spyOn(content, 'rollbackAgent').mockResolvedValue(agent)
  vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue({} as never)
  try {
    const buttons = wrapper.findAll('[data-action="rollback-agent"]')
    expect(buttons).toHaveLength(1)
    await buttons[0]!.trigger('click')
    await flushPromises()
    expect(rollback).toHaveBeenCalledWith(agentId, '0.1.0')
  } finally {
    wrapper.unmount()
  }
})

it('验证前检查展示不阻断的未验证角色提示（项目空间 S0）', async () => {
  const release = overview(null)
  release.checks = [
    ...release.checks,
    {
      id: 'authorization', label: '能力所需授权', passed: true, detail: '已声明的能力都已获授权',
      warning: '岗位角色“平台管理员”不在可见角色内，验证不会覆盖；在项目空间中执行时这些角色的能力可用。',
    },
  ]
  vi.spyOn(adminApi, 'getAgentRelease').mockResolvedValue({ agent, release })
  const wrapper = await mountView()
  try {
    expect(wrapper.text()).toContain('3/3 项通过')
    expect(wrapper.get('[data-testid="release-check-warning"]').text()).toContain('“平台管理员”不在可见角色内')
  } finally {
    wrapper.unmount()
  }
})
