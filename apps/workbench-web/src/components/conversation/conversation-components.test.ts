import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Artifact, ChatMessage, SessionThread, TaskResult, TaskRun } from '@/types/domain'
import ConversationMessageItem from './ConversationMessageItem.vue'
import RunComposer from './RunComposer.vue'
import RunMessageList from './RunMessageList.vue'
import SessionDiscussionList from './SessionDiscussionList.vue'

vi.mock('@/api/client', () => ({ workbenchApi: {} }))

// S5b：从 ConversationView 拆出的消息组件，A 的对话详情与 B 的对话页共用。

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    version: 'task-result/v1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    execution: 'succeeded',
    outcome: 'achieved',
    summary: '目标已达成',
    primaryOutput: null,
    receipts: [],
    pendingItems: [],
    sources: [],
    artifacts: [],
    error: null,
    evidence: {
      stopReason: null,
      toolCalls: null,
      toolResults: null,
      artifactsClaimed: null,
      artifactsRegistered: 0,
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      outputTruncated: false,
      interrupted: null,
    },
    completedAt: '2026-10-23T10:05:00.000Z',
    ...overrides,
  }
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    name: '库存周报.md',
    size: '2 KB',
    version: 1,
    fileId: 'file-1',
    canReference: true,
    ...overrides,
  } as Artifact
}

const messages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: '分析库存', createdAt: '10:00', runId: 'run-1', senderId: 'U1', senderName: '林岚' },
  { id: 'm2', role: 'assistant', content: '分析完成', createdAt: '10:01', runId: 'run-1', agentName: '库存助手', runRequesterName: '林岚' },
]

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    title: '库存分析',
    prompt: '分析库存',
    status: 'succeeded',
    attemptId: 'attempt-1',
    workspaceId: 'ws-personal',
    workspaceName: '个人',
    workspaceType: 'personal',
    sessionId: 'session-1',
    agentVersion: 'inventory@1.2.0',
    createdAt: '2026-10-23 10:00',
    updatedAt: '2026-10-23 10:05',
    owner: '林岚',
    requestedBy: 'U1',
    messages,
    steps: [],
    attachments: [],
    duration: '1 分 5 秒',
    tokenUsage: 1200,
    result: result(),
    ...overrides,
  } as TaskRun
}

const global = { plugins: [ElementPlus] }

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ConversationMessageItem', () => {
  it('mirrors own messages and shows the requester of agent replies', () => {
    const own = mount(ConversationMessageItem, { global, props: { message: messages[0]!, own: true } })
    expect(own.classes()).toContain('conversation-message--own')
    expect(own.find('.assistant-avatar--user').text()).toBe('林')
    expect(own.find('.user-message').text()).toBe('分析库存')

    const reply = mount(ConversationMessageItem, { global, props: { message: messages[1]! } })
    expect(reply.text()).toContain('库存助手')
    expect(reply.text()).toContain('由 林岚 发起')
  })

  it('replaces the time line with meta, hides the requester on request and shows a tag', () => {
    const wrapper = mount(ConversationMessageItem, {
      global,
      props: { message: messages[1]!, meta: '目标已达成 · 1 分 5 秒', tag: '补充要求', showRequester: false },
    })
    expect(wrapper.text()).toContain('目标已达成 · 1 分 5 秒')
    expect(wrapper.text()).not.toContain('由 林岚 发起')
    expect(wrapper.get('[data-testid="task-conversation-tag"]').text()).toBe('补充要求')
  })
})

describe('RunMessageList', () => {
  it('shows the business outcome on the last reply and emits result-card actions', async () => {
    const file = artifact()
    const wrapper = mount(RunMessageList, {
      global,
      props: { task: run({ result: result({ artifacts: [file] }) }), isOwn: m => m.role === 'user', canFollowUp: true },
    })
    expect(wrapper.text()).toContain('目标已达成 · 1 分 5 秒')
    expect(wrapper.text()).toContain('1,200 Token · inventory')

    await wrapper.get('.answer-artifact__download').trigger('click')
    await wrapper.get('[data-testid="continue-editing-artifact-1"]').trigger('click')
    await wrapper.get('button[aria-label="复制回答"]').trigger('click')
    await wrapper.get('button[aria-label="复制对话链接"]').trigger('click')
    expect(wrapper.emitted('download')).toEqual([[file]])
    expect(wrapper.emitted('continue-editing')).toEqual([[file]])
    expect(wrapper.emitted('copy-answer')).toEqual([['分析完成']])
    expect(wrapper.emitted('copy-link')).toHaveLength(1)
  })

  it('marks referenced artifacts and hides “继续修改” when follow-up is not allowed', async () => {
    const props = { task: run({ result: result({ artifacts: [artifact()] }) }), isOwn: () => false, canFollowUp: true, referencedFileIds: ['file-1'] }
    const referenced = mount(RunMessageList, { global, props })
    const button = referenced.get('[data-testid="continue-editing-artifact-1"]')
    expect(button.text()).toBe('已引用')
    expect(button.attributes('disabled')).toBeDefined()

    const readOnly = mount(RunMessageList, { global, props: { ...props, canFollowUp: false } })
    expect(readOnly.find('[data-testid="continue-editing-artifact-1"]').exists()).toBe(false)
  })

  it('shows the working state, approval wait, failure with retry and stop attribution', async () => {
    const running = mount(RunMessageList, {
      global,
      props: {
        task: run({ status: 'running', result: result({ outcome: 'pending' }), steps: [{ id: 's1', title: '读取库存', status: 'running', tool: 'erp.query' }] as TaskRun['steps'] }),
        isOwn: () => false,
      },
    })
    expect(running.get('[data-testid="current-step"]').text()).toBe('正在调用 erp.query')
    await running.get('.working-answer button').trigger('click')
    expect(running.emitted('open-details')).toHaveLength(1)

    const approval = mount(RunMessageList, { global, props: { task: run({ status: 'awaiting_approval', result: result({ outcome: 'pending' }) }), isOwn: () => false } })
    expect(approval.text()).toContain('等待本轮工具权限确认')

    const failed = mount(RunMessageList, {
      global,
      props: {
        task: run({
          status: 'failed',
          result: result({ outcome: 'not_achieved', error: { code: 'run_failed', message: '本轮执行失败', object: '运行', reason: '超时', suggestion: '重试', retryable: true } }),
        }),
        isOwn: () => false,
        canRetry: true,
      },
    })
    expect(failed.text()).toContain('本轮执行失败')
    await failed.get('.error-notice .el-button').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
    expect(failed.find('[data-testid="run-result-not-achieved"]').exists()).toBe(false)

    const stopped = mount(RunMessageList, { global, props: { task: run({ status: 'cancelled', stoppedBy: '周航', result: result({ outcome: 'unverified' }) }), isOwn: () => false } })
    expect(stopped.get('[data-testid="run-stopped-by"]').text()).toBe('本轮执行已由 周航 停止')
  })
})

describe('SessionDiscussionList', () => {
  const thread = {
    sessionId: 'session-team',
    title: '讨论',
    workspaceId: 'ws-team',
    workspaceType: 'team',
    createdBy: 'U1',
    creatorName: '林岚',
    createdAt: '2026-10-23T10:00:00.000Z',
    lastActiveAt: '2026-10-23T10:00:00.000Z',
    currentUserRole: 'member',
    messages: [
      { id: 't1', role: 'user', content: '先看看', createdAt: '10:00', runId: null, senderId: 'U2', senderName: '周航', runRequesterId: null, runRequesterName: null, agentName: null },
    ],
    runs: [{ runId: 'run-9', status: 'succeeded', requestedBy: 'U2', requesterName: '周航', createdAt: '2026-10-23T10:01:00.000Z', stoppedByName: null }],
  } as unknown as SessionThread

  it('lists discussion messages and opens a run record', async () => {
    const wrapper = mount(SessionDiscussionList, { global, props: { thread, isOwn: () => false } })
    expect(wrapper.text()).toContain('先看看')
    await wrapper.get('[data-testid="session-run"]').trigger('click')
    expect(wrapper.emitted('open-run')).toEqual([['run-9']])
  })

  it('explains how to start when the discussion is empty', () => {
    const wrapper = mount(SessionDiscussionList, { global, props: { thread: { ...thread, messages: [], runs: [] }, isOwn: () => false } })
    expect(wrapper.get('.thread-empty').text()).toContain('@ Agent 成员则发起一次执行')
  })
})

describe('RunComposer', () => {
  it('shows referenced results above the notices slot and forwards composer events', async () => {
    const wrapper = mount(RunComposer, {
      global,
      props: { referencedArtifacts: [{ fileId: 'file-1', name: '库存周报.md', version: 2 }], running: true },
      slots: { notices: '<p data-testid="notice">提示</p>' },
    })
    const html = wrapper.html()
    expect(html.indexOf('referenced-artifacts')).toBeLessThan(html.indexOf('data-testid="notice"'))
    expect(wrapper.text()).toContain('库存周报.md · V2')
    await wrapper.get('.el-tag__close').trigger('click')
    expect(wrapper.emitted('remove-reference')).toEqual([['file-1']])
  })
})
