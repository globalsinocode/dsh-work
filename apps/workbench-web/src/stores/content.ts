import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, WorkbenchAgent, WorkbenchSkill, Workspace } from '../types/domain'

export const useContentStore = defineStore('workbench-content', () => {
  const workspaces = ref<Workspace[]>([])
  const artifacts = ref<Artifact[]>([])
  const agents = ref<WorkbenchAgent[]>([])
  const skills = ref<WorkbenchSkill[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  let generation = 0
  function reset() {
    generation++
    workspaces.value = []; artifacts.value = []; agents.value = []; skills.value = []
    loading.value = false; initialized.value = false
  }
  const personalWorkspace = computed(() => workspaces.value.find(workspace => workspace.type === 'personal'))

  async function load() {
    if (initialized.value) return
    await refresh()
  }

  async function refresh() {
    const current = generation
    loading.value = true
    try {
      const [workspaceData, artifactData, agentData] = await Promise.all([
        workbenchApi.getWorkspaces(),
        workbenchApi.getArtifacts(),
        workbenchApi.getAgents(),
      ])
      if (current !== generation) return
      workspaces.value = workspaceData
      artifacts.value = artifactData
      agents.value = agentData
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
    const loaded = await workbenchApi.getAgents()
    if (current === generation) agents.value = loaded
    return current === generation ? loaded : []
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

  async function uploadWorkspaceFile(workspaceId: string, file: File) {
    const current = generation
    const uploaded = await workbenchApi.uploadWorkspaceFile(workspaceId, file)
    if (current !== generation) throw new Error('账号已切换，请重新操作')
    const workspace = workspaces.value.find((item) => item.id === workspaceId)
    if (workspace) workspace.files.unshift(uploaded)
    return uploaded
  }

  async function refreshArtifacts() {
    const current = generation
    const loaded = await workbenchApi.getArtifacts()
    if (current === generation) artifacts.value = loaded
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
    load,
    refresh,
    createTeamWorkspace,
    uploadWorkspaceFile,
    refreshArtifacts,
    refreshAgents,
    refreshSkills,
  }
})
