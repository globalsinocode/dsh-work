import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRecommendation, Artifact, ChatMessage, SessionThread, SkillDraft, TaskResult, TaskRun } from '@/types/domain'
import ConversationMessageItem from './ConversationMessageItem.vue'
import RunComposer from './RunComposer.vue'
import RunMessageList from './RunMessageList.vue'
import SessionDiscussionList from './SessionDiscussionList.vue'

const { downloadArtifact, getArtifactText, submitSkillDraft, withdrawSkillDraft, getSkillDraftFile } = vi.hoisted(() => ({
  downloadArtifact: vi.fn(), getArtifactText: vi.fn(),
  submitSkillDraft: vi.fn(), withdrawSkillDraft: vi.fn(), getSkillDraftFile: vi.fn(),
}))
vi.mock('@/api/client', () => ({ workbenchApi: { downloadArtifact, getArtifactText, submitSkillDraft, withdrawSkillDraft, getSkillDraftFile } }))

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
    // 身份行保留时间并追加结论；个人对话不标“由某人发起”；底部只留 Token 用量，不重复同事名称。
    expect(wrapper.text()).toContain('10:01 · 目标已达成')
    expect(wrapper.text()).not.toContain('由 林岚 发起')
    expect(wrapper.get('.assistant-run-meta').text()).toBe('1,200 Token')

    const team = mount(RunMessageList, { global, props: { task: run({ workspaceType: 'team', tokenUsage: undefined }), isOwn: m => m.role === 'user' } })
    expect(team.text()).toContain('由 林岚 发起')
    expect(team.find('.assistant-run-meta').exists()).toBe(false)

    const unverified = mount(RunMessageList, { global, props: { task: run({ result: result({ outcome: 'unverified' }) }), isOwn: m => m.role === 'user' } })
    expect(unverified.text()).toContain('库存助手10:01')
    expect(unverified.text()).not.toContain('待核验')

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

  it('REC-01: recommendation cards sit under each run’s last reply; “去聊天” carries that run’s question, unavailable ones explain instead', async () => {
    const recommendation = (overrides: Partial<AgentRecommendation>): AgentRecommendation => ({
      id: 'rec-1', runId: 'run-1', agentId: 'agent-contract', name: '合同审查', description: '审查合同条款',
      reason: '掌握公司的合同审查规则', available: true, ...overrides,
    })
    const wrapper = mount(RunMessageList, {
      global,
      props: {
        task: run({
          id: 'run-1',
          messages: [
            { id: 'u1', role: 'user', content: '先问一个通用问题', createdAt: '10:00', runId: 'run-old' },
            { id: 'a1', role: 'assistant', content: '通用回答', createdAt: '10:01', runId: 'run-old' },
            { id: 'u2', role: 'user', content: '这份合同的违约金合理吗？', createdAt: '10:02', runId: 'run-1' },
            { id: 'a2', role: 'assistant', content: '先给出通用判断', createdAt: '10:03', runId: 'run-1' },
          ],
          recommendations: [
            recommendation({}),
            recommendation({ id: 'rec-2', agentId: 'agent-finance', name: '财务内控', reason: '能核对付款条款', available: false }),
          ],
        }),
        isOwn: m => m.role === 'user',
      },
    })
    const cards = wrapper.findAll('[data-testid="agent-recommendations"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.text()).toContain('合同审查')
    expect(cards[0]!.text()).toContain('推荐理由：掌握公司的合同审查规则')

    await wrapper.get('[aria-label="去和合同审查聊天"]').trigger('click')
    expect(wrapper.emitted('open-recommended-agent')).toEqual([[recommendation({}), '这份合同的违约金合理吗？']])

    await wrapper.get('[aria-label="去和财务内控聊天"]').trigger('click')
    expect(wrapper.emitted('open-recommended-agent')).toHaveLength(1)
    expect(wrapper.text()).toContain('该 AI 同事暂不可用')
  })

  it('REC-01: prefers the question written for the colleague over the employee’s “who should I ask”', async () => {
    const recommendation: AgentRecommendation = {
      id: 'rec-3', runId: 'run-1', agentId: 'agent-planning', name: '计划排产', description: '排产与交期',
      reason: '负责交期风险说明', suggestedPrompt: '请分析本月订单的交期风险，列出可能延期的订单和原因。', available: true,
    }
    const wrapper = mount(RunMessageList, {
      global,
      props: {
        task: run({
          id: 'run-1',
          messages: [
            { id: 'u1', role: 'user', content: '分析本月订单的交期风险，应该找哪个 AI 同事？', createdAt: '10:00', runId: 'run-1' },
            { id: 'a1', role: 'assistant', content: '建议找计划排产', createdAt: '10:01', runId: 'run-1' },
          ],
          recommendations: [recommendation],
        }),
        isOwn: m => m.role === 'user',
      },
    })
    await wrapper.get('[aria-label="去和计划排产聊天"]').trigger('click')
    expect(wrapper.emitted('open-recommended-agent')).toEqual([[recommendation, '请分析本月订单的交期风险，列出可能延期的订单和原因。']])
  })

  it('SKC-01: the Skill draft card sits under the run’s last reply; the employee submits, withdraws and previews it', async () => {
    const draft = (overrides: Partial<SkillDraft> = {}): SkillDraft => ({
      submissionId: 'sub-1', versionId: 'ver-2', versionNumber: 2, runId: 'run-1', name: '销售周报汇总',
      description: '每周把销售日报汇总成周报。',
      files: [{ path: 'SKILL.md', size: 1400, script: false }, { path: 'scripts/report.py', size: 3200, script: true }],
      compatibility: { status: 'compatible', issues: [] }, status: 'draft', latest: true, ...overrides,
    })
    submitSkillDraft.mockResolvedValue(draft({ status: 'pending', submittedAt: '2026-10-30T07:42:00.000Z' }))
    withdrawSkillDraft.mockResolvedValue(draft({ status: 'draft' }))
    getSkillDraftFile.mockResolvedValue({ path: 'SKILL.md', size: 20, content: '---\nname: 销售周报汇总\n---' })
    const wrapper = mount(RunMessageList, {
      global,
      props: {
        task: run({
          id: 'run-1',
          messages: [
            { id: 'u1', role: 'user', content: '帮我做一个周报 Skill', createdAt: '10:00', runId: 'run-1' },
            { id: 'a1', role: 'assistant', content: '先确认几件事', createdAt: '10:01', runId: 'run-1' },
            { id: 'a2', role: 'assistant', content: '草稿如下', createdAt: '10:02', runId: 'run-1' },
          ],
          skillDrafts: [draft({ versionId: 'ver-1', versionNumber: 1, latest: false }), draft()],
        }),
        isOwn: m => m.role === 'user',
      },
    })
    expect(wrapper.findAll('[data-testid="skill-drafts"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="skill-draft-superseded"]').text()).toContain('草稿 v1 · 已由新版本替代')
    const card = wrapper.get('[data-testid="skill-draft-card"]')
    expect(card.text()).toContain('scripts/report.py')
    expect(card.text()).toContain('脚本')
    expect(card.text()).toContain('包校验：通过')
    expect(card.text(), '不声称平台验证过试跑').not.toContain('试跑')

    await card.get('.skill-draft__preview-toggle').trigger('click')
    await flushPromises()
    expect(getSkillDraftFile).toHaveBeenCalledWith('sub-1', 'ver-2')
    expect(wrapper.get('[data-testid="skill-draft-preview"]').text()).toContain('name: 销售周报汇总')

    await wrapper.get('[data-action="submit-skill-draft"]').trigger('click')
    await flushPromises()
    expect(submitSkillDraft).toHaveBeenCalledWith('sub-1', 'ver-2')
    expect(wrapper.get('[data-testid="skill-draft-card"]').text()).toContain('已提交审核')
    await wrapper.get('[data-action="withdraw-skill-draft"]').trigger('click')
    await flushPromises()
    expect(withdrawSkillDraft).toHaveBeenCalledWith('sub-1')
    expect(wrapper.find('[data-action="submit-skill-draft"]').exists()).toBe(true)
  })

  it('SKC-01: an incompatible draft cannot be submitted; a rejected one shows the reason', () => {
    const base: SkillDraft = {
      submissionId: 'sub-2', versionId: 'ver-1', versionNumber: 1, runId: 'run-1', name: '客诉回复', description: '客诉首次回复。',
      files: [{ path: 'SKILL.md', size: 900, script: false }],
      compatibility: { status: 'incompatible', issues: [{ code: 'python_package', severity: 'error', message: '依赖 foo 不在执行环境中' }] },
      status: 'draft', latest: true,
    }
    const mountWith = (drafts: SkillDraft[]) => mount(RunMessageList, {
      global,
      props: {
        task: run({ id: 'run-1', messages: [{ id: 'a1', role: 'assistant', content: '草稿如下', createdAt: '10:01', runId: 'run-1' }], skillDrafts: drafts }),
        isOwn: m => m.role === 'user',
      },
    })
    const incompatible = mountWith([base])
    expect(incompatible.text()).toContain('包校验：未通过')
    expect(incompatible.text()).toContain('依赖 foo 不在执行环境中')
    expect(incompatible.get('[data-action="submit-skill-draft"]').attributes('disabled')).toBeDefined()
    const rejected = mountWith([{ ...base, compatibility: { status: 'compatible', issues: [] }, status: 'rejected', reviewNote: '文件名不要带客户名称' }])
    expect(rejected.text()).toContain('审核未通过')
    expect(rejected.text()).toContain('文件名不要带客户名称')
    expect(rejected.find('[data-action="submit-skill-draft"]').exists()).toBe(false)
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

  it('marks the artifact card being previewed as selected on the whole card', () => {
    const props = { task: run({ result: result({ artifacts: [artifact()] }) }), isOwn: () => false, canFollowUp: true }
    const previewing = mount(RunMessageList, { global, props: { ...props, previewKey: 'artifact-1@1' } })
    expect(previewing.get('[data-testid="answer-artifact-artifact-1"] .answer-artifact__row').classes()).toContain('is-active')
    expect(previewing.get('[data-testid="preview-artifact-artifact-1"]').attributes('aria-pressed')).toBe('true')
    const idle = mount(RunMessageList, { global, props })
    expect(idle.get('[data-testid="answer-artifact-artifact-1"] .answer-artifact__row').classes()).not.toContain('is-active')
  })

  it('keeps the requester on a team reply that did not reach its goal, without any outcome label', () => {
    const team = mount(RunMessageList, { global, props: { task: run({ workspaceType: 'team', result: result({ outcome: 'not_achieved' }) }), isOwn: m => m.role === 'user' } })
    const identity = team.findAll('.assistant-identity')[1]!.text()
    expect(identity).toMatch(/10:01\s*· 由 林岚 发起/)
    expect(identity).not.toContain('目标')
  })

  it('warns about operations with unknown effects when a run was stopped, and splits reason from next step on failure', () => {
    const effect = { kind: 'external_effect_unknown' as const, message: '工具 erp.write 的实际效果未知；须查询权威系统回执后才能确认目标。' }
    const stopped = mount(RunMessageList, { global, props: { task: run({ status: 'cancelled', stoppedBy: '林岚', result: result({ outcome: 'not_achieved', pendingItems: [effect] }) }), isOwn: () => false } })
    const warning = stopped.get('[data-testid="run-external-effect-unknown"]')
    expect(warning.attributes('role')).toBe('alert')
    expect(warning.text()).toContain('erp.write')
    expect(warning.text()).toContain('重新发送前')

    const plainStop = mount(RunMessageList, { global, props: { task: run({ status: 'cancelled', stoppedBy: '林岚', result: result({ outcome: 'not_achieved' }) }), isOwn: () => false } })
    expect(plainStop.find('[data-testid="run-external-effect-unknown"]').exists()).toBe(false)

    const failed = mount(RunMessageList, {
      global,
      props: {
        task: run({ status: 'failed', result: result({ outcome: 'not_achieved', pendingItems: [effect], error: { code: 'run_failed', message: '本轮执行失败', object: '运行 run-1', reason: '执行服务没有正常完成本轮。', suggestion: '可以重新执行。', retryable: true } }) }),
        isOwn: () => false,
      },
    })
    const paragraphs = failed.findAll('[data-testid="run-error-notice"] p').map(item => item.text())
    expect(paragraphs).toEqual(['执行服务没有正常完成本轮。', '下一步：可以重新执行。'])
    expect(failed.get('[data-testid="run-error-notice"]').text()).toContain('erp.write')
    expect(failed.find('[data-testid="run-external-effect-unknown"]').exists()).toBe(false)
  })

  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, seconds)).toISOString()
  const liveSteps: TaskRun['steps'] = [
    { id: 'e1', title: '执行服务开始运行', detail: '', status: 'succeeded', event: 'run.started', at: at(0) },
    { id: 'c1', title: '调用工具', detail: '', status: 'succeeded', tool: 'read', callId: 'c1', event: 'tool.completed', at: at(13), startedAt: at(11) },
    { id: 'c2', title: '正在调用工具', detail: '', status: 'running', tool: 'erp.query', callId: 'c2', event: 'tool.started', at: at(41), startedAt: at(41) },
  ]

  it('collapses the steps above the answer once the run has finished', async () => {
    const finished = mount(RunMessageList, {
      global,
      props: {
        task: run({
          steps: [
            ...liveSteps.slice(0, 2),
            { id: 'c2', title: '调用工具', detail: '', status: 'failed', tool: 'python_execute', callId: 'c2', event: 'tool.completed', at: at(98), startedAt: at(41) },
            { id: 'e2', title: '执行完成', detail: '', status: 'succeeded', event: 'run.completed', at: at(126) },
          ],
        }),
        isOwn: () => false,
      },
    })
    expect(finished.find('[data-testid="run-progress-card"]').exists()).toBe(false)
    const summary = finished.get('[data-testid="run-progress-summary"]')
    expect(summary.get('summary').text()).toBe('已完成 5 个步骤（调用工具 2 次）')
    expect(summary.findAll('[data-testid="run-progress-step"]').map(row => row.find('.run-progress-step__label').text())).toEqual([
      '理解问题，已完成', '读取文件，已完成', '思考下一步，已完成', '运行 Python失败', '整理回答，已完成',
    ])

    const noTools = mount(RunMessageList, { global, props: { task: run({ steps: [liveSteps[0]!] }), isOwn: () => false } })
    expect(noTools.find('[data-testid="run-progress-summary"]').exists()).toBe(false)
  })

  it('shows the working state, approval wait, failure with retry and stop attribution', async () => {
    const running = mount(RunMessageList, {
      global,
      props: {
        task: run({ status: 'running', result: result({ outcome: 'pending' }), steps: liveSteps }),
        isOwn: () => false,
      },
    })
    const rows = running.findAll('[data-testid="run-progress-step"]')
    expect(rows.map(row => row.find('.run-progress-step__label').text())).toEqual([
      '理解问题，已完成', '读取文件，已完成', '思考下一步，已完成', '正在调用 erp.query，进行中',
    ])
    expect(rows.map(row => row.find('.run-progress-step__time').text())).toEqual(['11 秒', '2 秒', '28 秒', expect.stringMatching(/秒|分/)])
    expect(running.get('[data-testid="current-step"]').text()).toBe('正在调用 erp.query')
    expect(running.text()).not.toContain('没有新的输出')
    await running.get('[data-testid="run-progress-card"] button').trigger('click')
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

    // 失败说明先给原因与下一步，运行编号与错误码收进默认收起的技术详情。
    const details = failed.get('[data-testid="run-error-details"]')
    expect(details.attributes('open')).toBeUndefined()
    expect(details.text()).toContain('run_failed')
    expect(failed.get('[data-testid="run-error-notice"]').text()).toContain('下一步：重试')

    // 员工主动停止：只留一行，不再用“目标未达成”的警示卡片重复说明。
    const stopped = mount(RunMessageList, { global, props: { task: run({ status: 'cancelled', stoppedBy: '周航', result: result({ outcome: 'not_achieved', summary: '执行已取消，任务目标未达成。' }) }), isOwn: () => false } })
    expect(stopped.get('[data-testid="run-stopped-by"]').text()).toBe('本轮执行已由 周航 停止')
    expect(stopped.find('[data-testid="run-result-not-achieved"]').exists()).toBe(false)
    expect(stopped.text()).not.toContain('目标未达成')

    const systemStopped = mount(RunMessageList, { global, props: { task: run({ status: 'cancelled', stoppedBy: null, result: result({ outcome: 'not_achieved' }) }), isOwn: () => false } })
    expect(systemStopped.get('[data-testid="run-stopped-by"]').text()).toBe('本轮执行已停止')
  })

  it('shows the elapsed total beside the title only when there is more than one step (EX-PROGRESS-01)', () => {
    const several = mount(RunMessageList, { global, props: { task: run({ status: 'running', result: result({ outcome: 'pending' }), steps: liveSteps }), isOwn: () => false } })
    expect(several.get('[data-testid="run-progress-card"] .assistant-identity').text()).toMatch(/正在处理 · 已用/)


    // 重新执行后唯一的步骤从新的执行开始，它的计时不等于本轮总用时，仍显示总用时。
    const retried = mount(RunMessageList, {
      global,
      props: {
        task: run({ status: 'running', result: result({ outcome: 'pending' }), steps: [
          { id: 'e1', title: '执行服务开始运行', detail: '', status: 'succeeded', event: 'run.started', at: at(0) },
          { id: 'e2', title: '执行服务开始运行', detail: '', status: 'succeeded', event: 'run.started', at: at(50) },
          { id: 'c9', title: '正在调用工具', detail: '', status: 'running', tool: 'erp.query', callId: 'c9', event: 'tool.started', at: at(50), startedAt: at(50) },
        ] }),
        isOwn: () => false,
      },
    })
    expect(retried.findAll('[data-testid="run-progress-step"]')).toHaveLength(1)
    expect(retried.get('[data-testid="run-progress-card"] .assistant-identity').text()).toMatch(/正在处理 · 已用/)
  })

  it('EX-STATE-01: names the working colleague the same way as its finished reply', () => {
    const named = mount(RunMessageList, {
      global,
      props: { task: run({ status: 'running', agentVersion: '库存助手@1.2.0', result: result({ outcome: 'pending' }), steps: liveSteps }), isOwn: () => false },
    })
    expect(named.get('[data-testid="run-progress-card"] .assistant-identity').text()).toContain('库存助手')
    expect(named.get('[data-testid="run-progress-card"] .assistant-avatar').text()).toBe('库')

    // 没有版本时 agentVersion 为空串：退回最近一条回复的名称。
    const fallback = mount(RunMessageList, {
      global,
      props: { task: run({ status: 'running', agentVersion: '', result: result({ outcome: 'pending' }), steps: liveSteps }), isOwn: () => false },
    })
    expect(fallback.get('[data-testid="run-progress-card"] .assistant-identity strong').text()).toBe('库存助手')
  })

  it('EX-STATE-01: keeps a note under earlier rounds that were stopped or failed without a reply', () => {
    const thread: ChatMessage[] = [
      ...messages,
      { id: 'm3', role: 'user', content: '再核对明细', createdAt: '10:02', runId: 'run-2', senderId: 'U1', senderName: '林岚' },
      { id: 'm4', role: 'user', content: '换个口径', createdAt: '10:03', runId: 'run-3', senderId: 'U1', senderName: '林岚' },
      { id: 'm5', role: 'user', content: '最后一轮', createdAt: '10:04', runId: 'run-4', senderId: 'U1', senderName: '林岚' },
    ]
    const wrapper = mount(RunMessageList, {
      global,
      props: {
        task: run({
          id: 'run-4', status: 'cancelled', stoppedBy: '林岚', messages: thread, result: result({ outcome: 'unverified' }),
          threadRuns: [
            { runId: 'run-1', status: 'succeeded', stoppedBy: null },
            { runId: 'run-2', status: 'cancelled', stoppedBy: '林岚' },
            { runId: 'run-3', status: 'failed', stoppedBy: null },
            { runId: 'run-4', status: 'cancelled', stoppedBy: '林岚' },
          ],
        }),
        isOwn: message => message.role === 'user',
      },
    })
    // 已有回复的轮次与本轮都不加说明；本轮的停止仍由下方说明给出，不重复。
    expect(wrapper.findAll('[data-testid="past-run-note"]').map(note => note.text())).toEqual([
      '已停止（林岚），没有生成回复',
      '这一轮没有完成，没有生成回复',
    ])
    expect(wrapper.get('[data-testid="run-stopped-by"]').text()).toBe('本轮执行已由 林岚 停止')
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
