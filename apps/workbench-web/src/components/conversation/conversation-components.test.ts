import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Artifact, ChatMessage, SessionThread, TaskResult, TaskRun } from '@/types/domain'
import ConversationMessageItem from './ConversationMessageItem.vue'
import RunComposer from './RunComposer.vue'
import RunMessageList from './RunMessageList.vue'
import SessionDiscussionList from './SessionDiscussionList.vue'

const { downloadArtifact, getArtifactText } = vi.hoisted(() => ({ downloadArtifact: vi.fn(), getArtifactText: vi.fn() }))
vi.mock('@/api/client', () => ({ workbenchApi: { downloadArtifact, getArtifactText } }))

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
    type: 'markdown',
    size: '2 KB',
    version: 1,
    createdAt: '2026-10-23T10:05:00.000Z',
    runId: 'run-1',
    workspaceId: 'ws-personal',
    fileId: 'file-1',
    canReference: true,
    summary: '',
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
  downloadArtifact.mockReset()
  getArtifactText.mockReset()
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

  it('lists the files sent with a user message', () => {
    const wrapper = mount(ConversationMessageItem, {
      global,
      props: { message: { ...messages[0]!, attachments: ['八月生产计划.xlsx', '库存.csv'] }, own: true },
    })
    const list = wrapper.get('[aria-label="附带文件"]')
    expect(list.findAll('li').map(item => item.text())).toEqual(['八月生产计划.xlsx', '库存.csv'])
    expect(wrapper.find('.user-message p').text()).toBe('分析库存')

    const plain = mount(ConversationMessageItem, { global, props: { message: messages[0]! } })
    expect(plain.find('[aria-label="附带文件"]').exists()).toBe(false)
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

    await wrapper.get('[data-testid="preview-artifact-artifact-1"]').trigger('click')
    await wrapper.get('button[aria-label="下载成果 库存周报.md"]').trigger('click')
    await wrapper.get('[data-testid="continue-editing-artifact-1"]').trigger('click')
    await wrapper.get('button[aria-label="复制回答"]').trigger('click')
    await wrapper.get('button[aria-label="复制对话链接"]').trigger('click')
    expect(wrapper.emitted('preview')).toEqual([[file]])
    expect(wrapper.emitted('download')).toEqual([[file]])
    expect(wrapper.emitted('continue-editing')).toEqual([[file]])
    expect(wrapper.emitted('copy-answer')).toEqual([['分析完成']])
    expect(wrapper.emitted('copy-link')).toHaveLength(1)
  })

  it('attaches threadArtifacts to each run’s last assistant reply; any of them opens the preview', async () => {
    const older = artifact({ id: 'artifact-old', name: '周会纪要.md', runId: 'run-old', type: 'markdown' })
    const newer = artifact({ id: 'artifact-new', name: '备忘.md', runId: 'run-1', type: 'markdown' })
    const wrapper = mount(RunMessageList, {
      global,
      props: {
        task: run({
          id: 'run-1',
          messages: [
            { id: 'u1', role: 'user', content: '写纪要', createdAt: '10:00', runId: 'run-old' },
            { id: 'a1', role: 'assistant', content: '已生成文件', createdAt: '10:01', runId: 'run-old' },
            { id: 'u2', role: 'user', content: '再写备忘', createdAt: '10:02', runId: 'run-1' },
            { id: 'a2', role: 'assistant', content: '备忘已就绪', createdAt: '10:03', runId: 'run-1' },
          ],
          result: result({ artifacts: [newer] }),
          threadArtifacts: [older, newer],
        }),
        isOwn: m => m.role === 'user',
        canFollowUp: true,
      },
    })
    expect(wrapper.findAll('[data-testid="answer-artifacts"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="answer-artifact-artifact-old"]').text()).toContain('周会纪要.md')
    expect(wrapper.get('[data-testid="answer-artifact-artifact-new"]').text()).toContain('备忘.md')
    // 继续修改只出现在当前 Run 的成果上
    expect(wrapper.find('[data-testid="continue-editing-artifact-old"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="continue-editing-artifact-new"]').exists()).toBe(true)

    // EX-ARTIFACT-08：较早一轮的成果同样可预览；正文在宿主的右栏中显示，不在回复内展开。
    const card = () => wrapper.get('[data-testid="preview-artifact-artifact-old"]')
    expect(card().attributes('aria-label')).toBe('预览成果 周会纪要.md')
    expect(card().attributes('aria-pressed')).toBe('false')
    await card().trigger('click')
    expect(wrapper.emitted('preview')).toEqual([[older]])
    expect(downloadArtifact).not.toHaveBeenCalled()

    // 宿主回传正在预览的版本后，对应卡片标为选中；同 id 的其他版本不算。
    await wrapper.setProps({ previewKey: 'artifact-old@1' })
    expect(card().attributes('aria-pressed')).toBe('true')
    expect(card().text()).toContain('预览中')
    await wrapper.setProps({ previewKey: 'artifact-old@2' })
    expect(card().attributes('aria-pressed')).toBe('false')
  })

  it('2b-5: every artifact opens the preview; failed or pending text is explained beside the card; images show a thumbnail', async () => {
    const sheet = artifact({ id: 'a-xlsx', name: '营收.xlsx', type: 'xlsx', textPreview: 'available' })
    const report = artifact({ id: 'a-pdf', name: '报告.pdf', type: 'pdf', textPreview: 'failed', textPreviewError: 'PDF 无法读取' })
    const notes = artifact({ id: 'a-docx', name: '说明.docx', type: 'docx', textPreview: 'pending' })
    const chart = artifact({ id: 'a-png', name: '趋势.png', type: 'png' })
    downloadArtifact.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart')
    const wrapper = mount(RunMessageList, {
      global,
      props: { task: run({ result: result({ artifacts: [sheet, report, notes, chart] }) }), isOwn: m => m.role === 'user', canFollowUp: true },
    })
    await flushPromises()

    // 解析失败与尚未解析的在卡片旁说明，仍可点开预览（右栏同样说明并提供下载）。
    expect(wrapper.get('[data-testid="artifact-body-unavailable-a-pdf"]').text()).toBe('无法生成正文：PDF 无法读取，请下载查看')
    expect(wrapper.get('[data-testid="artifact-body-unavailable-a-docx"]').text()).toBe('正文暂未生成，请稍后再看或下载查看')
    expect(wrapper.find('[data-testid="artifact-body-unavailable-a-xlsx"]').exists()).toBe(false)
    for (const id of ['a-xlsx', 'a-pdf', 'a-docx', 'a-png']) {
      await wrapper.get(`[data-testid="preview-artifact-${id}"]`).trigger('click')
    }
    expect(wrapper.emitted('preview')).toEqual([[sheet], [report], [notes], [chart]])
    // 列表本身不读正文：解析文本由右栏读取。
    expect(getArtifactText).not.toHaveBeenCalled()
    expect(wrapper.find('.artifact-text').exists()).toBe(false)

    // 图片经鉴权下载显示缩略图，点击同样在右栏打开。
    expect(downloadArtifact).toHaveBeenCalledWith('a-png', 1)
    const thumb = wrapper.get('[data-testid="artifact-thumb-a-png"]')
    expect(thumb.attributes('aria-label')).toBe('预览图片 趋势.png')
    expect(thumb.get('img').attributes('src')).toBe('blob:chart')
    await thumb.trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(5)
    expect(wrapper.emitted('preview')![4]).toEqual([chart])
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    create.mockRestore()
  })

  it('lists files that were not registered as artifacts under the run’s last reply', () => {
    const skippedRun = run({
      result: result({
        outcome: 'unverified',
        artifacts: [artifact({ type: 'xlsx', name: '数据.xlsx' })],
        pendingItems: [
          { kind: 'artifact_skipped', message: '“宏.xlsx”未登记为成果：含宏、脚本或会访问外部内容的组件' },
          { kind: 'no_verified_deliverable', message: '其他待核验事项不在这里显示' },
        ],
      }),
    })
    const wrapper = mount(RunMessageList, { global, props: { task: skippedRun, isOwn: m => m.role === 'user', canFollowUp: true } })
    const note = wrapper.get('[data-testid="artifact-skipped"]')
    expect(note.attributes('role')).toBe('note')
    expect(note.text()).toContain('以下文件未登记为成果')
    expect(note.text()).toContain('“宏.xlsx”未登记为成果：含宏、脚本或会访问外部内容的组件')
    expect(note.text()).not.toContain('其他待核验事项')

    const clean = mount(RunMessageList, { global, props: { task: run({ result: result({ artifacts: [artifact()] }) }), isOwn: () => false } })
    expect(clean.find('[data-testid="artifact-skipped"]').exists()).toBe(false)
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
