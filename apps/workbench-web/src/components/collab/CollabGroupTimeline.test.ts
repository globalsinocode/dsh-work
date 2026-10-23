import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import { useTaskStore } from '@/stores/tasks'
import type { TaskRun, WorkspaceFile, WorkspaceTimelineItem } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import CollabGroupTimeline from './CollabGroupTimeline.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
const api = vi.hoisted(() => ({
  getWorkspaceTimeline: vi.fn(),
  createSession: vi.fn(),
  listConversationTargets: vi.fn(),
  workspaceSessionEventsUrl: vi.fn((id: string) => `/events/${id}`),
}))
vi.mock('vue-router', () => ({ useRouter: () => router }))
vi.mock('@/api/client', () => ({ workbenchApi: api }))
vi.mock('@/utils/feedback', () => ({ notifyActionFailure: vi.fn() }))

class FakeEventSource {
  addEventListener() {}
  close() {}
}

enableAutoUnmount(afterEach)

const items: WorkspaceTimelineItem[] = [
  { kind: 'task', id: 'tc:t1', at: '2026-10-08T00:00:00Z', event: 'created', actorName: '林岚', task: { id: 't1', title: '库存周报', status: 'in_progress', assigneeType: 'agent', assigneeName: '库存助手', schedule: { kind: 'manual', timezone: 'Asia/Shanghai' } as never, removed: false }, run: null, note: null },
  { kind: 'task', id: 'tr:r9', at: '2026-10-07T00:00:00Z', event: 'run_finished', actorName: '林岚', task: { id: 't1', title: '库存周报', status: 'in_progress', assigneeType: 'agent', assigneeName: '库存助手', schedule: null, removed: false }, run: { id: 'r9', status: 'succeeded', scheduled: true, quiet: true, summary: '无变化' }, note: null },
  { kind: 'message', id: 'm:2', at: '2026-10-06T00:00:00Z', sessionId: 's-new', sessionTitle: '第二段', role: 'user', content: '新话题', senderId: 'U1', senderName: '林岚', agentName: null, runId: null, runRequesterName: null },
  { kind: 'run', id: 'r:r1', at: '2026-10-05T00:01:00Z', sessionId: 's-old', sessionTitle: '第一段', runId: 'r1', status: 'succeeded', requesterName: '周航', agentName: '库存助手', stoppedByName: null },
  { kind: 'message', id: 'm:1', at: '2026-10-05T00:00:00Z', sessionId: 's-old', sessionTitle: '第一段', role: 'user', content: '大家看看', senderId: 'U2', senderName: '周航', agentName: null, runId: null, runRequesterName: null },
  { kind: 'system', id: 'w:ws', at: '2026-10-01T00:00:00Z', activityKind: 'workspace_created', actorName: '林岚', safeMetadata: {} },
]

const props = {
  workspaceId: 'ws-1',
  canWrite: true,
  archived: false,
  roleKnown: true,
  mentionOptions: [{ id: 'wam-1', name: '库存助手' }],
  hasAgentMembers: true,
  pendingFile: null as WorkspaceFile | null,
}

async function mountTimeline(overrides: Partial<typeof props> = {}) {
  const wrapper = mount(CollabGroupTimeline, { props: { ...props, ...overrides }, global: { plugins: [ElementPlus] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

async function submit(wrapper: Awaited<ReturnType<typeof mountTimeline>>, prompt: string, mentions: string[] = [], files: File[] = []) {
  const confirm = vi.fn()
  wrapper.findComponent(TaskComposer).vm.$emit('submit', { prompt, files, workspaceId: 'ws-1', mentions, confirm })
  await flushPromises()
  return confirm
}

describe('CollabGroupTimeline (S5d 群聊)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('EventSource', FakeEventSource)
    Object.values(api).forEach(fn => 'mockReset' in fn && fn.mockReset())
    api.getWorkspaceTimeline.mockResolvedValue({ workspaceId: 'ws-1', items, nextCursor: null })
    api.listConversationTargets.mockResolvedValue({ items: [], nextCursor: null })
    api.workspaceSessionEventsUrl.mockImplementation((id: string) => `/events/${id}`)
    router.push.mockReset()
    vi.spyOn(useAuthStore(), 'user', 'get').mockReturnValue({ id: 'U1', name: '林岚', title: '', department: '', avatarText: '林', role: 'employee', dataScopes: [] })
    Element.prototype.scrollTo = vi.fn()
  })

  it('shows discussions oldest first with topic dividers, task cards and system records', async () => {
    const wrapper = await mountTimeline()
    const dividers = wrapper.findAll('.collab-group-timeline__divider').map(item => item.text())
    expect(dividers[0]).toContain('第一段 ·')
    expect(dividers[1]).toContain('第二段 ·')
    expect(wrapper.get('[data-testid="group-system-record"]').text()).toContain('林岚 创建了群组')
    expect(wrapper.get('[data-testid="group-run-record"]').text()).toContain('周航 让 库存助手 执行')
    const cards = wrapper.findAll('[data-testid="group-task-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('定时执行无变化（展开）')
    expect(cards[1]!.text()).toContain('林岚 创建了任务')
    expect(cards[1]!.text()).toContain('执行规则 · 手动')
  })

  it('opens the task detail and run detail inside the group', async () => {
    const wrapper = await mountTimeline()
    await wrapper.get('[aria-label="打开任务：库存周报"]').trigger('click')
    expect(router.push).toHaveBeenLastCalledWith('/c/chats/group/ws-1/tasks/t1')
    await wrapper.get('[data-testid="group-run-record"]').trigger('click')
    expect(router.push).toHaveBeenLastCalledWith('/c/chats/group/ws-1/conversations/r1')
  })

  it('posts a plain message as discussion in the latest topic once the single-agent preset is cancelled', async () => {
    const wrapper = await mountTimeline()
    const store = useTaskStore()
    const post = vi.spyOn(store, 'postSessionMessage').mockResolvedValue(undefined as never)
    const start = vi.spyOn(store, 'startRunWithSessionFiles')
    await wrapper.get('.collab-group-timeline__preset-toggle').trigger('click')
    const confirm = await submit(wrapper, '大家怎么看')
    expect(post).toHaveBeenCalledWith('s-new', '大家怎么看')
    expect(start).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalled()
  })

  it('hands the message to the preselected agent, or the explicitly mentioned one', async () => {
    const wrapper = await mountTimeline({ mentionOptions: [{ id: 'wam-1', name: '库存助手' }] })
    const store = useTaskStore()
    const start = vi.spyOn(store, 'startRunWithSessionFiles').mockResolvedValue({ id: 'run-x' } as TaskRun)
    vi.spyOn(store, 'subscribe').mockImplementation(() => undefined)
    await submit(wrapper, '分析一下')
    expect(start).toHaveBeenCalledWith('s-new', { prompt: '分析一下', attachments: [], referencedFileIds: [], workspaceAgentMemberId: 'wam-1' })

    const multi = await mountTimeline({ mentionOptions: [{ id: 'wam-1', name: '库存助手' }, { id: 'wam-2', name: '排产助手' }] })
    await submit(multi, '@排产助手 排一下', ['wam-2'])
    expect(start).toHaveBeenLastCalledWith('s-new', expect.objectContaining({ workspaceAgentMemberId: 'wam-2' }))
  })

  it('starts the first topic when the group has no discussion yet', async () => {
    api.getWorkspaceTimeline.mockResolvedValue({ workspaceId: 'ws-1', items: [items.at(-1)!], nextCursor: null })
    api.createSession.mockResolvedValue({ id: 's-first' })
    const wrapper = await mountTimeline({ mentionOptions: [] })
    const store = useTaskStore()
    const post = vi.spyOn(store, 'postSessionMessage').mockResolvedValue(undefined as never)
    await submit(wrapper, '开个头')
    expect(api.createSession).toHaveBeenCalledWith({ title: '开个头', workspaceId: 'ws-1' })
    expect(post).toHaveBeenCalledWith('s-first', '开个头')
  })

  it('requires @Agent for a referenced workspace file', async () => {
    const file = { id: 'file-1', name: '经销商名单.xlsx' } as WorkspaceFile
    const wrapper = await mountTimeline({ pendingFile: file, mentionOptions: [{ id: 'wam-1', name: '库存助手' }, { id: 'wam-2', name: '排产助手' }] })
    const store = useTaskStore()
    const post = vi.spyOn(store, 'postSessionMessage')
    const start = vi.spyOn(store, 'startRunWithSessionFiles').mockResolvedValue({ id: 'run-y' } as TaskRun)
    vi.spyOn(store, 'subscribe').mockImplementation(() => undefined)
    expect(wrapper.get('[data-testid="group-referenced-file"]').text()).toContain('经销商名单.xlsx')
    await submit(wrapper, '看看这个文件')
    expect(post).not.toHaveBeenCalled()
    await submit(wrapper, '@库存助手 看看这个文件', ['wam-1'])
    expect(start).toHaveBeenCalledWith('s-new', expect.objectContaining({ referencedFileIds: ['file-1'], workspaceAgentMemberId: 'wam-1' }))
    expect(wrapper.emitted('clear-file')).toHaveLength(1)
  })

  it('shows no input for read-only members, archived groups and groups without agents', async () => {
    const viewer = await mountTimeline({ canWrite: false })
    expect(viewer.findComponent(TaskComposer).exists()).toBe(false)
    expect(viewer.get('[data-testid="group-readonly-notice"]').text()).toContain('只读成员')
    const archived = await mountTimeline({ canWrite: false, archived: true })
    expect(archived.get('[data-testid="group-archived-notice"]').text()).toContain('已归档')
    const noAgent = await mountTimeline({ hasAgentMembers: false, mentionOptions: [] })
    expect(noAgent.findComponent(TaskComposer).exists()).toBe(false)
    await noAgent.get('[data-testid="group-no-agent-notice"] .el-button').trigger('click')
    expect(noAgent.emitted('open-info')).toHaveLength(1)
  })
})
