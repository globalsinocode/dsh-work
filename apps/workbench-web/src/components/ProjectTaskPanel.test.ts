import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ProjectTask, WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'
import ProjectTaskPanel from './ProjectTaskPanel.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => router }))

const members: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: 'u-viewer', displayName: '苏晚', role: 'viewer', joinedAt: '2026-09-02T00:00:00.000Z' },
]
const agents: WorkspaceAgentMember[] = [{
  id: 'wam-1', agentId: 'agent-1', name: '缺货分析助手', description: '', status: 'available',
  version: 'v1', addedBy: '林岚', createdAt: '2026-09-05T00:00:00.000Z', allowedActions: ['start_conversation'],
}]

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 'ptask-1',
    title: '分析缺货原因',
    description: '列出前三个原因',
    createdBy: { userId: 'u-owner', displayName: '林岚' },
    assignee: { type: 'agent', agentMemberId: 'wam-1', name: '缺货分析助手' },
    status: 'todo',
    sessionId: null,
    latestRunId: null,
    inputFiles: [],
    deliverableFiles: [],
    completionNote: null,
    completedAt: null,
    dueDate: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    allowedActions: ['edit', 'remove', 'start'],
    ...overrides,
  }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ProjectTaskPanel, {
    props: {
      workspaceId: 'ws-team',
      workspaceName: '供应链项目',
      canWrite: true,
      members,
      agentMembers: agents,
      files: [],
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('ProjectTaskPanel（项目空间 S1）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    router.push.mockReset()
    vi.spyOn(workbenchApi, 'listProjectTasks').mockResolvedValue([])
  })

  it('shows an empty state with a create entry for writers and reports the count', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有任务')
    expect(wrapper.find('[data-testid="project-task-create"]').exists()).toBe(true)
    expect(wrapper.emitted('count')?.at(-1)).toEqual([0])
  })

  it('hides every write entry for read-only members', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue([task({ allowedActions: [] })])
    const wrapper = mountPanel({ canWrite: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="project-task-create"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="project-task-row"] button')).toHaveLength(0)
  })

  it('lists tasks with derived status labels and assignee', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue([
      task({ id: 't1', status: 'in_progress', sessionId: 's1', latestRunId: 'r1', allowedActions: [] }),
      task({ id: 't2', status: 'failed', sessionId: 's2', latestRunId: 'r2', allowedActions: [] }),
      task({
        id: 't3', title: '整理供应商名单', status: 'done', completionNote: '已分组',
        assignee: { type: 'employee', userId: 'u-owner', displayName: '林岚' }, allowedActions: [],
      }),
    ])
    const wrapper = mountPanel()
    await flushPromises()
    const statuses = wrapper.findAll('[data-testid="project-task-status"]').map(node => node.text())
    expect(statuses).toEqual(['进行中', '执行失败', '已完成'])
    expect(wrapper.text()).toContain('承接：Agent · 缺货分析助手')
    expect(wrapper.get('[data-testid="project-task-note"]').text()).toContain('已分组')
    expect(wrapper.emitted('count')?.at(-1)).toEqual([3])
  })

  it('creates a task for a colleague and offers only non-viewer employees and available Agents', async () => {
    const create = vi.spyOn(workbenchApi, 'createProjectTask').mockResolvedValue(task())
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="project-task-create"]').trigger('click')
    await flushPromises()

    const vm = wrapper.vm as unknown as {
      editor: { assignee: string }
      employeeOptions: Array<{ label: string }>
      agentOptions: Array<{ label: string }>
    }
    expect(vm.employeeOptions.map(option => option.label)).toEqual(['林岚'])
    expect(vm.agentOptions.map(option => option.label)).toEqual(['缺货分析助手'])

    await wrapper.get('input[data-testid="project-task-title"]').setValue('  整理供应商名单  ')
    vm.editor.assignee = 'employee:u-owner'
    await wrapper.get('[data-testid="project-task-save"]').trigger('click')
    await flushPromises()

    expect(create).toHaveBeenCalledWith('ws-team', {
      title: '整理供应商名单',
      description: '',
      assignee: { type: 'employee', id: 'u-owner' },
      inputFileIds: [],
      dueDate: null,
    })
    expect(workbenchApi.listProjectTasks).toHaveBeenCalledTimes(2)
  })

  it('starts an Agent task and opens its task thread', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue([task()])
    const start = vi.spyOn(workbenchApi, 'startProjectTask')
      .mockResolvedValue(task({ status: 'in_progress', sessionId: 'session-9', latestRunId: 'run-9', allowedActions: [] }))
    const wrapper = mountPanel()
    await flushPromises()
    const startButton = wrapper.findAll('button').find(button => button.text() === '交给 Agent 执行')
    expect(startButton).toBeTruthy()
    await startButton!.trigger('click')
    await flushPromises()
    expect(start).toHaveBeenCalledWith('ws-team', 'ptask-1', expect.stringMatching(/^project-task-start-ptask-1-/))
    expect(router.push).toHaveBeenCalledWith('/workspaces/ws-team/conversations/run-9')
  })

  it('completes an employee task with a note', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue([task({
      assignee: { type: 'employee', userId: 'u-owner', displayName: '林岚' },
      status: 'in_progress',
      allowedActions: ['edit', 'remove', 'set_status', 'complete'],
    })])
    const setStatus = vi.spyOn(workbenchApi, 'setProjectTaskStatus').mockResolvedValue(task({ status: 'done' }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '完成')!.trigger('click')
    await flushPromises()
    await wrapper.get('textarea[data-testid="project-task-completion-note"]').setValue('已按区域分组')
    await wrapper.get('[data-testid="project-task-complete-confirm"]').trigger('click')
    await flushPromises()
    expect(setStatus).toHaveBeenCalledWith('ws-team', 'ptask-1', {
      status: 'done', completionNote: '已按区域分组', deliverableFileIds: [],
    })
  })

  it('confirms before removing a task', async () => {
    vi.mocked(workbenchApi.listProjectTasks).mockResolvedValue([task()])
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    const remove = vi.spyOn(workbenchApi, 'removeProjectTask')
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
