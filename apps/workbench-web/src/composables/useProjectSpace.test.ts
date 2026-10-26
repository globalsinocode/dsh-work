import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useContentStore } from '@/stores/content'
import type { TeamMemberRole, Workspace, WorkspaceAgentMember } from '@/types/domain'
import { useProjectSpace } from './useProjectSpace'

const api = vi.hoisted(() => ({
  listWorkspaceAgentMembers: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}))
vi.mock('@/api/client', () => ({ workbenchApi: api }))
vi.mock('@/utils/feedback', () => ({ notifyActionFailure: vi.fn() }))

function space(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-a',
    name: '项目 A',
    description: '',
    type: 'team',
    memberCount: 2,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-10-23T00:00:00.000Z',
    owner: '林岚',
    members: [],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

function agent(id: string, overrides: Partial<WorkspaceAgentMember> = {}) {
  return { id, name: `Agent ${id}`, status: 'available', allowedActions: ['start_conversation'], ...overrides } as WorkspaceAgentMember
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function setup(spaces: Workspace[], roleOverride?: () => TeamMemberRole | null | undefined) {
  const content = useContentStore()
  content.workspaces = spaces
  const workspaceId = ref(spaces[0]?.id ?? '')
  const scope = effectScope()
  const state = scope.run(() => useProjectSpace({ workspaceId, ...(roleOverride ? { roleOverride } : {}) }))!
  return { state, workspaceId }
}

describe('useProjectSpace (shared by A project space and B group)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.listWorkspaceAgentMembers.mockReset()
    api.listWorkspaceMembers.mockReset()
  })

  it('uses the server role for write entries and fails closed while it is unknown', async () => {
    api.listWorkspaceMembers.mockResolvedValue({ items: [], currentUserRole: 'member' })
    const { state } = setup([space()])
    expect(state.canWriteTeamContent.value).toBe(false)
    await state.loadWorkspaceMembers()
    expect(state.currentUserRole.value).toBe('member')
    expect(state.canWriteTeamContent.value).toBe(true)
    expect(state.canEditBrief.value).toBe(false)
    expect(state.canViewUsage.value).toBe(false)
  })

  it('keeps viewers and archived spaces read-only', async () => {
    api.listWorkspaceMembers.mockResolvedValue({ items: [], currentUserRole: 'viewer' })
    const viewer = setup([space()])
    await viewer.state.loadWorkspaceMembers()
    expect(viewer.state.canWriteTeamContent.value).toBe(false)
    expect(viewer.state.canReferenceFileVersion.value).toBe(true)

    setActivePinia(createPinia())
    api.listWorkspaceMembers.mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const archived = setup([space({ status: 'archived' })])
    await archived.state.loadWorkspaceMembers()
    expect(archived.state.isArchived.value).toBe(true)
    expect(archived.state.canWriteTeamContent.value).toBe(false)
    expect(archived.state.canEditBrief.value).toBe(false)
    expect(archived.state.canReferenceFileVersion.value).toBe(false)
    expect(archived.state.canViewUsage.value).toBe(true)
  })

  it('prefers an explicit role from the host', async () => {
    api.listWorkspaceMembers.mockResolvedValue({ items: [], currentUserRole: 'viewer' })
    const { state } = setup([space()], () => 'owner')
    await state.loadWorkspaceMembers()
    expect(state.isOwner.value).toBe(true)
  })

  it('offers only available agents the user may start as @ mentions', async () => {
    api.listWorkspaceAgentMembers.mockResolvedValue([
      agent('a1'),
      agent('a2', { status: 'disabled' }),
      agent('a3', { allowedActions: [] }),
    ])
    const { state } = setup([space()])
    await state.loadAgentMembers()
    expect(state.startableMentionOptions.value).toEqual([{ id: 'a1', name: 'Agent a1' }])
    expect(state.startableAgentMemberIds.value).toEqual(['a1'])
  })

  it('never requests members for a personal space', async () => {
    const { state } = setup([space({ id: 'ws-me', type: 'personal' })])
    await state.loadAgentMembers()
    await state.loadWorkspaceMembers()
    expect(api.listWorkspaceAgentMembers).not.toHaveBeenCalled()
    expect(api.listWorkspaceMembers).not.toHaveBeenCalled()
  })

  it('drops a late roster response after switching spaces', async () => {
    const late = deferred<{ items: []; currentUserRole: TeamMemberRole }>()
    api.listWorkspaceMembers.mockReturnValueOnce(late.promise)
    const { state, workspaceId } = setup([space(), space({ id: 'ws-b', name: '项目 B' })])
    const loading = state.loadWorkspaceMembers()
    workspaceId.value = 'ws-b'
    state.resetMembers()
    late.resolve({ items: [], currentUserRole: 'owner' })
    await loading
    expect(state.currentUserRole.value).toBeNull()
  })
})
