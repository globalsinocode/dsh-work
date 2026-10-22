import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, WorkbenchAgent, WorkbenchSkill, Workspace, WorkspaceFile } from '../types/domain'

export interface WorkspaceFilePageState {
  items: WorkspaceFile[]
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: string
}

function emptyFilePage(): WorkspaceFilePageState {
  return { items: [], nextCursor: null, hasMore: false, loading: false, error: '' }
}

export const useContentStore = defineStore('workbench-content', () => {
  const workspaces = ref<Workspace[]>([])
  const artifacts = ref<Artifact[]>([])
  const agents = ref<WorkbenchAgent[]>([])
  const skills = ref<WorkbenchSkill[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const workspaceError = ref('')
  const artifactsError = ref('')
  const agentsError = ref('')
  const workspaceFilePages = ref<Record<string, WorkspaceFilePageState>>({})
  let generation = 0
  function reset() {
    generation++
    workspaces.value = []; artifacts.value = []; agents.value = []; skills.value = []
    workspaceFilePages.value = {}
    workspaceError.value = ''
    artifactsError.value = ''
    agentsError.value = ''
    loading.value = false; initialized.value = false
  }
  const personalWorkspace = computed(() => workspaces.value.find(workspace => workspace.type === 'personal'))

  async function load() {
    if (initialized.value) return
    await refresh()
  }

  async function refreshWorkspaces() {
    const current = generation
    try {
      const workspaceData = await workbenchApi.getWorkspaces()
      if (current !== generation) return
      workspaces.value = workspaceData
      workspaceError.value = ''
    } catch (error) {
      if (current !== generation) return
      workspaceError.value = error instanceof Error ? error.message : '工作空间加载失败'
    }
  }

  async function refresh() {
    const current = generation
    loading.value = true
    try {
      await Promise.allSettled([
        refreshWorkspaces(),
        refreshArtifacts(),
        refreshAgents(),
      ])
      if (current !== generation) return
      initialized.value = true
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function refreshSkills() {
    const current = generation
    const loaded = await workbenchApi.getSkills()
    if (current === generation) skills.value = loaded
    return current === generation ? loaded : []
  }

  async function refreshAgents() {
    const current = generation
    try {
      const loaded = await workbenchApi.getAgents()
      if (current === generation) {
        agents.value = loaded
        agentsError.value = ''
      }
    } catch (error) {
      if (current === generation) {
        agentsError.value = error instanceof Error ? error.message : 'Agent 加载失败'
      }
    }
    return current === generation ? agents.value : []
  }

  async function createTeamWorkspace(input: {
    name: string
    description: string
  }) {
    const current = generation
    const workspace = await workbenchApi.createWorkspace({
      name: input.name,
      description: input.description || '团队共享的对话、文件与成果协作空间。',
    })
    if (current !== generation) throw new Error('账号已切换，请重新操作')
    workspaces.value.unshift(workspace)
    return workspace
  }

  function mapUploadedWorkspaceFile(uploaded: WorkspaceFile): WorkspaceFile {
    return {
      ...uploaded,
      size: uploaded.size ?? uploaded.sizeLabel,
      uploadedAt: uploaded.uploadedAt ?? uploaded.createdAt,
    }
  }

  async function uploadWorkspaceFile(workspaceId: string, file: File) {
    const current = generation
    const uploaded = mapUploadedWorkspaceFile(await workbenchApi.uploadWorkspaceFile(workspaceId, file) as WorkspaceFile)
    if (current !== generation) throw new Error('账号已切换，请重新操作')
    const page = workspaceFilePages.value[workspaceId] ?? emptyFilePage()
    page.items = [uploaded, ...page.items.filter(item => item.logicalFileId !== uploaded.logicalFileId)]
    workspaceFilePages.value = { ...workspaceFilePages.value, [workspaceId]: page }
    const workspace = workspaces.value.find((item) => item.id === workspaceId)
    if (workspace && workspace.type === 'personal') workspace.files.unshift(uploaded)
    if (workspace && workspace.type === 'team') workspace.fileCount = (workspace.fileCount ?? page.items.length)
    return uploaded
  }

  async function refreshArtifacts() {
    const current = generation
    try {
      const loaded = await workbenchApi.getArtifacts()
      if (current === generation) {
        artifacts.value = loaded
        artifactsError.value = ''
      }
    } catch (error) {
      if (current === generation) {
        artifactsError.value = error instanceof Error ? error.message : '成果加载失败'
      }
    }
  }

  async function loadWorkspaceFiles(workspaceId: string, cursor?: string) {
    const current = generation
    const existing = workspaceFilePages.value[workspaceId] ?? emptyFilePage()
    const loadingMore = Boolean(cursor)
    workspaceFilePages.value = {
      ...workspaceFilePages.value,
      [workspaceId]: { ...existing, loading: true, error: loadingMore ? existing.error : '' },
    }
    try {
      const page = await workbenchApi.listWorkspaceFiles(workspaceId, { cursor })
      if (current !== generation) return
      const merged = loadingMore
        ? [...existing.items, ...page.items.filter(item => !existing.items.some(row => row.id === item.id))]
        : page.items
      workspaceFilePages.value = {
        ...workspaceFilePages.value,
        [workspaceId]: {
          items: merged,
          nextCursor: page.nextCursor,
          hasMore: Boolean(page.nextCursor),
          loading: false,
          error: '',
        },
      }
    } catch (error) {
      if (current !== generation) return
      workspaceFilePages.value = {
        ...workspaceFilePages.value,
        [workspaceId]: {
          ...existing,
          loading: false,
          error: error instanceof Error ? error.message : '文件加载失败',
        },
      }
    }
  }

  function workspaceFiles(workspaceId: string) {
    return workspaceFilePages.value[workspaceId] ?? emptyFilePage()
  }

  return {
    workspaces,
    reset,
    personalWorkspace,
    artifacts,
    agents,
    skills,
    loading,
    initialized,
    workspaceError,
    artifactsError,
    agentsError,
    load,
    refresh,
    refreshWorkspaces,
    createTeamWorkspace,
    uploadWorkspaceFile,
    refreshArtifacts,
    refreshAgents,
    refreshSkills,
    loadWorkspaceFiles,
    workspaceFiles,
  }
})
