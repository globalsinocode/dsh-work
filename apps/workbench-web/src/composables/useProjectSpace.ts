import { computed, ref, type Ref } from 'vue'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { TeamMemberRole, WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 项目空间页面的共享状态（项目空间方案 12.4）：空间对象、员工与 Agent 成员、服务端判定的
 * 本人角色、可 @ 的 Agent、文件与成果，以及归档 / 只读等写入口判断。A 的项目空间详情与
 * B 的群组页使用同一份逻辑，两种模式只在布局层不同。
 *
 * 角色只采用服务端给出的值（`roleOverride` 由宿主显式传入，或 `GET /workspaces/:id/members`
 * 返回的 `currentUserRole`）；未知时一律 null，团队写入口不渲染——宁可漏开不可误开。
 * 成员请求带世代号：切换空间后晚到的旧响应不得覆盖新空间的名册与角色。
 */
export function useProjectSpace(options: {
  workspaceId: Ref<string>
  /** 宿主显式给出的角色（管理端嵌入、测试）；undefined 表示以服务端名册为准。 */
  roleOverride?: () => TeamMemberRole | null | undefined
}) {
  const contentStore = useContentStore()

  const workspace = computed(() => contentStore.workspaces.find((item) => item.id === options.workspaceId.value))
  const isPersonal = computed(() => workspace.value?.type === 'personal')
  const isTeam = computed(() => workspace.value?.type === 'team')
  /**
   * 归档只读态：仅团队空间在服务端 `status === 'archived'` 时进入（个人空间恒为
   * active，即使夹具强行带上归档状态也不渲染归档提示，AC-23）。
   */
  const isArchived = computed(() => isTeam.value && workspace.value?.status === 'archived')

  const agentMembers = ref<WorkspaceAgentMember[]>([])
  const workspaceMembers = ref<WorkspaceMember[]>([])
  /** 服务端返回的调用者角色（负责人转交后不再等于创建者，不能靠姓名推断）。 */
  const serverUserRole = ref<TeamMemberRole | null>(null)
  const currentUserRole = computed<TeamMemberRole | null>(() => {
    const override = options.roleOverride?.()
    return override !== undefined ? override : serverUserRole.value
  })
  /** 负责人判定来自服务端角色，不在前端按创建者猜测（负责人-only 动作的唯一依据）。 */
  const isOwner = computed(() => currentUserRole.value === 'owner')

  /** 当前操作人可发起对话的 Agent 成员：与服务端 allowedActions 一致（只读成员为空）。 */
  const startableAgentMembers = computed(() => agentMembers.value
    .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation')))
  const startableAgentMemberIds = computed(() => startableAgentMembers.value.map(member => member.id))
  /** TW-10：输入框可 @ 的 Agent 成员（id + 名称），与 startableAgentMemberIds 同一过滤口径。 */
  const startableMentionOptions = computed(() =>
    startableAgentMembers.value.map(member => ({ id: member.id, name: member.name })))

  /** 已加载的空间文件（文件页签、动态文件名解析共用）。 */
  const workspaceFiles = computed(() => workspace.value?.files ?? [])
  const workspaceArtifacts = computed(() =>
    contentStore.artifacts.filter((artifact) => artifact.workspaceId === options.workspaceId.value))

  const canWriteRole = computed(() => currentUserRole.value !== null && currentUserRole.value !== 'viewer')
  /**
   * TW-10 共享讨论的写入口径：团队空间中非只读成员且空间未归档才可发言/触发执行；
   * 角色未知（名册请求失败）时不给入口。
   */
  const canWriteTeamContent = computed(() => isTeam.value && !isArchived.value && canWriteRole.value)
  /**
   * 上传新版本（执行轨）与写入同一口径：归档空间、只读成员与角色未知时都不给入口，
   * 避免一个注定 403 的假入口；服务端 403 仍是最终兜底。
   */
  const canUploadFileVersions = canWriteTeamContent
  /** 「引用此版本」与「引用到对话」同口径：归档空间无法发起新对话，不渲染引用入口。 */
  const canReferenceFileVersion = computed(() => isTeam.value && !isArchived.value)
  /** 项目简报只由负责人与管理员在活动空间编辑（项目空间 S1）。 */
  const canEditBrief = computed(() =>
    isTeam.value && !isArchived.value && (currentUserRole.value === 'owner' || currentUserRole.value === 'admin'))
  /**
   * 空间用量的可见门禁：仅团队空间中服务端确认的负责人／管理员（AC-30）。归档空间属
   * 读取轨，负责人/管理员仍可查看。
   */
  const canViewUsage = computed(() =>
    isTeam.value && (currentUserRole.value === 'owner' || currentUserRole.value === 'admin'))

  let memberRequestSeq = 0
  let agentMemberRequestSeq = 0
  const currentId = () => workspace.value?.id ?? ''

  /** Agent 成员只按既有 T4 接口加载，且严格限定团队空间：个人空间既不发请求也不渲染（AC-23）。 */
  async function loadAgentMembers(workspaceId = currentId()) {
    if (!workspaceId || !isTeam.value) return
    const seq = ++agentMemberRequestSeq
    try {
      const items = await workbenchApi.listWorkspaceAgentMembers(workspaceId)
      if (seq !== agentMemberRequestSeq || workspaceId !== currentId()) return
      agentMembers.value = items
    } catch (error) {
      if (seq !== agentMemberRequestSeq || workspaceId !== currentId()) return
      agentMembers.value = []
      notifyActionFailure('加载 Agent 成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
    }
  }

  /** 员工名册与服务端判定的调用者角色。团队成员均可读取；个人空间不请求（AC-23）。 */
  async function loadWorkspaceMembers(workspaceId = currentId()) {
    if (!workspaceId || !isTeam.value) return
    const seq = ++memberRequestSeq
    try {
      const directory = await workbenchApi.listWorkspaceMembers(workspaceId)
      if (seq !== memberRequestSeq || workspaceId !== currentId()) return
      workspaceMembers.value = directory.items
      serverUserRole.value = directory.currentUserRole
    } catch (error) {
      if (seq !== memberRequestSeq || workspaceId !== currentId()) return
      workspaceMembers.value = []
      serverUserRole.value = null
      notifyActionFailure('加载员工成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
    }
  }

  function refreshTeamMembers() {
    void loadAgentMembers()
    void loadWorkspaceMembers()
  }

  /** 空间切换：作废在途成员请求并清空名册与角色（评审 M7）。 */
  function resetMembers() {
    memberRequestSeq += 1
    agentMemberRequestSeq += 1
    agentMembers.value = []
    workspaceMembers.value = []
    serverUserRole.value = null
  }

  return {
    workspace,
    isPersonal,
    isTeam,
    isArchived,
    agentMembers,
    workspaceMembers,
    currentUserRole,
    isOwner,
    startableAgentMemberIds,
    startableMentionOptions,
    workspaceFiles,
    workspaceArtifacts,
    canWriteTeamContent,
    canUploadFileVersions,
    canReferenceFileVersion,
    canEditBrief,
    canViewUsage,
    loadAgentMembers,
    loadWorkspaceMembers,
    refreshTeamMembers,
    resetMembers,
  }
}
