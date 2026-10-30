<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import {
  Cpu,
  Document,
  DocumentChecked,
  Files,
  Reading,
} from '@element-plus/icons-vue'

import { emptyComposerDraft, TaskComposer, type ComposerDraft } from '@dsh-work/workbench-components'

import TeamSpaceComposer from '@/components/team-space-composer/team-space-composer.vue'
import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { WorkbenchAgent, WorkbenchSkill, WorkspaceFile, WorkspaceFileProjection } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { splitMentions, type MentionOption } from '@/utils/mentions'
import { takeRecommendationPrefill } from '@/utils/recommendation-prefill'

const props = withDefaults(
  defineProps<{
    workspaceId?: string
    workspaceName?: string
    workspaceLocked?: boolean
    embedded?: boolean
    title?: string
    /**
     * 团队空间中当前操作人**可发起对话**的 Agent 成员 id（服务端 allowedActions
     * 含 start_conversation 且可用）。只读成员服务端返回空数组，因此既看不到入口
     * 也不能提交；缺省空数组，宁可漏开不可误开。
     */
    startableAgentMemberIds?: string[]
    /**
     * 团队会话必须绑定 Agent 成员（TW-02）。只有团队空间详情为 true；个人空间
     * 详情同样是 workspaceLocked，但不能被这条规则拦住（AC-23）。
     */
    requiresAgentMember?: boolean
    /**
     * TW-10 共享讨论：当前操作人是否具备空间写权限（owner/admin/member）。
     * 只读成员（viewer）与角色未知时不允许发言或发起执行——宁可漏开不可误开。
     * 个人空间不受影响（AC-23）。
     */
    canDiscuss?: boolean
    /** 团队名册在途：角色未知，勿展示「只读/无写权限」类终态文案。 */
    teamRolePending?: boolean
    /**
     * 输入框可 @ 的 Agent 成员（TW-10）：id + 展示名，与工作空间详情页的
     * startable 过滤口径一致；非团队锁定场景传空。
     */
    mentionOptions?: Array<{ id: string; name: string }>
    /** 团队空间中部输入：由空间页传入的按上下文分键草稿表。 */
    teamComposerDrafts?: Record<string, ComposerDraft>
    /** D38：可 @ 的同事（不含本人），@ 只登记站内提醒、不执行；非团队锁定场景传空。 */
    colleagueOptions?: MentionOption[]
  }>(),
  {
    workspaceId: '',
    workspaceName: '',
    workspaceLocked: false,
    embedded: false,
    title: 'dsh-work，我帮你',
    startableAgentMemberIds: () => [],
    requiresAgentMember: false,
    canDiscuss: true,
    teamRolePending: false,
    mentionOptions: () => [],
    teamComposerDrafts: () => ({}),
    colleagueOptions: () => [],
  },
)

const emit = defineEmits<{
  teamDraftChange: [fromKey: string, draft: ComposerDraft]
}>()

const useTeamSpaceComposer = computed(() => props.workspaceLocked && props.requiresAgentMember)

/**
 * TW-10：团队共享讨论里普通成员可直接发言（不产生 Run）或在文本里 @ Agent
 * 触发执行；只有只读成员/角色未知时才整体阻止。Agent 的默认选择（唯一可发起
 * 成员自动预选）只是「首条消息默认 @ 谁」，不再是进入对话的前置条件。
 */
const referenceError = ref('')
const referenceLoading = ref(false)
const referenceName = ref('')
const blockedReason = computed(() => {
  if (referenceLoading.value) return '正在检查引用文件权限'
  if (referenceError.value) return referenceError.value
  if (mcpAccessBlocked.value.length) {
    return `需要先完成外部连接授权：${mcpAccessBlocked.value.map(item => item.name).join('、')}`
  }
  if (!props.requiresAgentMember) return ''
  if (props.teamRolePending) return ''
  return props.canDiscuss ? '' : '当前角色为只读成员或尚无写权限，不能发言或发起执行；请联系负责人。'
})
/** 名册未返回前禁止提交，但不展示误报的 blocked 横幅。 */
const composerPermissionPending = computed(() => props.teamRolePending)

const router = useRouter()
const route = useRoute()
const taskStore = useTaskStore()
const contentStore = useContentStore()
const rootRef = ref<HTMLElement>()

type ComposerHandle = {
  focusComposer: () => void
  setDraft: (draft: ComposerDraft) => void
}

const teamComposerRef = ref<ComposerHandle>()
const personalComposerRef = ref<ComposerHandle>()

const selectedTask = ref('')
const presetPrompt = ref('')
const referencedWorkspaceFileIds = ref<string[]>([])
const selectedAgentId = ref('')
const selectedAgentVersionId = ref('')
const selectedSkillId = ref('')
/** 推荐卡片跳转（推荐方案 4.3）：预填问题时的提示；目标同事已不可用时提示且不选中。 */
const recommendationNotice = ref<'' | 'prefilled' | 'unavailable'>('')
const selectedSkillVersionId = ref('')
const mcpAccessBlocked = ref<Array<{ connectorId: string; name: string }>>([])
const mcpAccessOmitted = ref<Array<{ connectorId: string; name: string }>>([])

// Global tasks are implicit personal tasks. Only an explicit locked origin
// carries a workspace; never infer it from the order of a cached space list.
const composerWorkspaceId = computed(() => props.workspaceLocked ? props.workspaceId : '')
const composerWorkspaceName = computed(() => props.workspaceLocked ? props.workspaceName : '')
const composerReady = computed(() => true)
const selectedSkill = computed<WorkbenchSkill | undefined>(() =>
  contentStore.skills.find(skill =>
    skill.id === selectedSkillId.value && skill.versionId === selectedSkillVersionId.value,
  ),
)
const selectedAgent = computed<WorkbenchAgent | undefined>(() =>
  contentStore.agents.find(agent =>
    agent.id === selectedAgentId.value && agent.versionId === selectedAgentVersionId.value,
  ),
)
/**
 * 唯一可发起 Agent 的自动预选（TW-02「只有一个可用 Agent 时可默认选中」）：
 * 身份由预选横幅明确展示；多个可发起成员时不预选，由用户在输入区 @ 选择。
 */
const effectivePresetAgentMember = computed(() => {
  if (!props.workspaceLocked || !props.requiresAgentMember) return null
  const startable = props.mentionOptions.filter(option => props.startableAgentMemberIds.includes(option.id))
  return startable.length === 1 ? { ...startable[0]!, status: 'available' as const } : null
})
const composerMentionOptions = computed<MentionOption[]>(() => [
  ...props.mentionOptions.map(option => ({ ...option, kind: 'agent' as const })),
  ...props.colleagueOptions,
])

const commonTasks = [
  {
    label: '整理文档',
    icon: Document,
    prompt: '请整理我接下来提供的业务材料，提炼关键事实、待办事项和责任人。',
  },
  {
    label: '查询制度',
    icon: Reading,
    prompt: '查询公司现行制度中与委外加工发料和库存扣减有关的规定，并列出依据。',
  },
  {
    label: '分析文件',
    icon: Files,
    prompt: '分析我上传的文件，概括主要指标、异常项和需要跟进的问题。',
  },
  {
    label: '生成报告',
    icon: DocumentChecked,
    prompt: '根据当前数据生成一份管理层可阅读的经营分析报告，包含摘要、风险和行动建议。',
  },
]

function focusComposer() {
  void nextTick(() => {
    if (useTeamSpaceComposer.value) {
      teamComposerRef.value?.focusComposer()
      return
    }
    rootRef.value?.querySelector<HTMLTextAreaElement>('.composer__input')?.focus()
  })
}

function resetComposerDraft() {
  void nextTick(() => {
    const empty = emptyComposerDraft()
    teamComposerRef.value?.setDraft(empty)
    personalComposerRef.value?.setDraft(empty)
  })
}

function selectTask(item: (typeof commonTasks)[number]) {
  referenceError.value = ''; referenceName.value = ''; referenceSequence++
  if (!props.workspaceLocked && route.query.file) {
    const query = { ...route.query }; delete query.file; void router.replace({ query })
  }
  selectedTask.value = item.label
  referencedWorkspaceFileIds.value = []
  presetPrompt.value = item.prompt
  focusComposer()
}

function useWorkspaceFile(file: WorkspaceFile) {
  selectedTask.value = '分析文件'
  referencedWorkspaceFileIds.value = [file.id]
  referenceName.value = file.name
  presetPrompt.value = `请分析团队文件“${file.name}”，概括关键信息、异常项和需要跟进的问题。`
  focusComposer()
}

function onWorkspaceFileSelected(file: WorkspaceFileProjection) {
  selectedTask.value = '分析文件'
  referencedWorkspaceFileIds.value = [file.id]
  referenceName.value = file.name
  presetPrompt.value = `请分析团队文件“${file.name}”，概括关键信息、异常项和需要跟进的问题。`
  focusComposer()
}

/**
 * TW-10：工作空间内发起的对话停留在空间页（/workspaces/:id 内嵌视图）；
 * 工作台等独立入口仍打开 /conversations 独立页。
 */
function conversationPath(workspaceId: string, target: string) {
  return props.workspaceLocked
    ? `/workspaces/${workspaceId}/conversations/${target}`
    : `/conversations/${target}`
}

async function submitTask(payload: {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  confirm?: () => void
  release?: () => void
}) {
  recommendationNotice.value = ''
  if (composerPermissionPending.value || blockedReason.value) {
    if (blockedReason.value) ElMessage.warning(blockedReason.value)
    payload.release?.()
    return
  }
  try {
    // TW-10：文本中显式 @ 的 Agent 成员优先于唯一成员的自动预选。
    const presetMemberId = effectivePresetAgentMember.value?.status === 'available'
      ? effectivePresetAgentMember.value.id
      : undefined
    const { agentMemberIds, userIds } = splitMentions(payload.mentions)
    const mentionedUserIds = props.workspaceLocked ? userIds : []
    const mentionedId = agentMemberIds.find(id => props.startableAgentMemberIds.includes(id))
    // 只 @ 同事的消息是对同事说的：不交给预选的 Agent，作为讨论发送并提醒同事（D38）。
    const workspaceAgentMemberId = props.workspaceLocked
      ? (mentionedId ?? (mentionedUserIds.length ? undefined : presetMemberId))
      : undefined
    if (props.workspaceLocked && props.requiresAgentMember && !workspaceAgentMemberId) {
      // 团队空间、无 @ 也无预选：开启纯讨论会话（不产生 Run）。
      if (payload.files.length || referencedWorkspaceFileIds.value.length) {
        ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
        payload.release?.()
        return
      }
      const session = await taskStore.startTeamDiscussion(payload.workspaceId, payload.prompt, mentionedUserIds)
      await router.push(conversationPath(payload.workspaceId, session.id))
      payload.confirm?.()
      referencedWorkspaceFileIds.value = []
      return
    }
    const task = await taskStore.createTask(
      payload.prompt,
      payload.files,
      props.workspaceLocked ? props.workspaceId : undefined,
      props.workspaceLocked ? props.workspaceName : composerWorkspaceName.value,
      props.workspaceLocked ? undefined : selectedAgentId.value || undefined,
      referencedWorkspaceFileIds.value,
      selectedSkillId.value || undefined,
      workspaceAgentMemberId,
      selectedAgentVersionId.value || undefined,
      selectedSkillVersionId.value || undefined,
      mentionedUserIds,
    )
    await router.push(conversationPath(payload.workspaceId, task.id))
    payload.confirm?.()
    referencedWorkspaceFileIds.value = []
  } catch (error) {
    payload.release?.()
    if (await handleSelectedVersionConflict(error)) return
    notifyActionFailure('创建对话', props.workspaceLocked ? `工作空间“${props.workspaceName}”` : '新对话', error, '检查 Agent、工作空间、附件和输入内容后重新提交。')
  }
}

async function handleSelectedVersionConflict(error: unknown) {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
  if (code !== 'selected_version_unavailable') return false
  ElMessage.warning('所选版本已不可用，请重新选择')
  selectedAgentId.value = ''
  selectedAgentVersionId.value = ''
  selectedSkillId.value = ''
  selectedSkillVersionId.value = ''
  const query = { ...route.query }
  delete query.agent
  delete query.agentVersion
  delete query.skill
  delete query.skillVersion
  void router.replace({ query })
  try {
    await Promise.all([
      props.workspaceLocked ? Promise.resolve() : contentStore.refreshAgents(),
      contentStore.refreshSkills(),
    ])
  } catch {
    // 保留提示；用户仍可手动刷新页面。
  }
  return true
}

function syncSkillFromRoute() {
  const skillId = typeof route.query.skill === 'string' ? route.query.skill : ''
  const skillVersionId = typeof route.query.skillVersion === 'string' ? route.query.skillVersion : ''
  const matched = contentStore.skills.find(skill => skill.id === skillId && skill.versionId === skillVersionId)
  selectedSkillId.value = matched ? skillId : ''
  selectedSkillVersionId.value = matched ? skillVersionId : ''
  const skill = selectedSkill.value
  if (skill) {
    selectedTask.value = ''
    presetPrompt.value = skill.testPrompt
    focusComposer()
  }
}

async function refreshMcpAccess(agentId: string) {
  mcpAccessBlocked.value = []
  mcpAccessOmitted.value = []
  if (!agentId || props.workspaceLocked) return
  try {
    const access = await workbenchApi.getAgentMcpAccess(agentId)
    mcpAccessBlocked.value = access.blocked
    mcpAccessOmitted.value = access.omitted
  } catch {
    mcpAccessBlocked.value = []
    mcpAccessOmitted.value = []
  }
}

function syncAgentFromRoute() {
  if (props.workspaceLocked) {
    selectedAgentId.value = ''
    selectedAgentVersionId.value = ''
    mcpAccessBlocked.value = []
    mcpAccessOmitted.value = []
    recommendationNotice.value = ''
    return
  }
  const agentId = typeof route.query.agent === 'string' ? route.query.agent : ''
  const agentVersionId = typeof route.query.agentVersion === 'string' ? route.query.agentVersion : ''
  // 推荐跳转只带 agent id；有 agentVersion 时精确匹配，否则取该 Agent 当前可见版本。
  const matched = agentVersionId
    ? contentStore.agents.find(agent => agent.id === agentId && agent.versionId === agentVersionId)
    : contentStore.agents.find(agent => agent.id === agentId)
  selectedAgentId.value = matched ? matched.id : ''
  selectedAgentVersionId.value = matched ? matched.versionId : ''
  void refreshMcpAccess(selectedAgentId.value)
  const agent = selectedAgent.value
  const prefill = takeRecommendationPrefill()
  recommendationNotice.value = prefill ? (agent ? 'prefilled' : 'unavailable') : ''
  if (agent) {
    selectedTask.value = ''
    presetPrompt.value = prefill || (agent.examplePrompts[0] ?? '')
    focusComposer()
  }
}

function clearSelectedAgent() {
  recommendationNotice.value = ''
  selectedAgentId.value = ''
  selectedAgentVersionId.value = ''
  const query = { ...route.query }
  delete query.agent
  delete query.agentVersion
  void router.replace({ query })
}

function clearSelectedSkill() {
  selectedSkillId.value = ''
  selectedSkillVersionId.value = ''
  const query = { ...route.query }
  delete query.skill
  delete query.skillVersion
  void router.replace({ query })
}

onMounted(async () => {
  try {
    await Promise.all([
      props.workspaceLocked ? Promise.resolve() : contentStore.load(),
      props.workspaceLocked && !route.query.skill ? Promise.resolve() : contentStore.refreshSkills(),
    ])
    syncSkillFromRoute()
    syncAgentFromRoute()
  } catch (error) {
    notifyActionFailure('加载员工能力', 'Skill 广场', error, '仍可继续发送普通对话；稍后刷新页面重试 Skill。')
  }
})

watch(() => route.query.skill, syncSkillFromRoute)
watch(() => route.query.skillVersion, syncSkillFromRoute)
watch(() => route.query.agent, syncAgentFromRoute)
watch(() => route.query.agentVersion, syncAgentFromRoute)
watch(selectedAgentId, agentId => { void refreshMcpAccess(agentId) })

let referenceSequence = 0
function clearPersonalReference() {
  referenceSequence++; referenceLoading.value = false; referenceError.value = ''; referenceName.value = ''
  referencedWorkspaceFileIds.value = []
  if (!props.workspaceLocked && route.query.file) {
    const query = { ...route.query }; delete query.file; void router.replace({ query })
  }
}
async function syncPersonalReference() {
  if (props.workspaceLocked) return
  const sequence = ++referenceSequence
  referencedWorkspaceFileIds.value = []; referenceName.value = ''; referenceError.value = ''; referenceLoading.value = false
  const id = typeof route.query.file === 'string' ? route.query.file : ''
  if (!id) return
  referenceLoading.value = true
  try {
    const file = await workbenchApi.getPersonalFile(id)
    if (sequence !== referenceSequence) return
    if (!file.canReference) throw new Error('该文件当前不可引用，请查看文件的解析和安全状态')
    referencedWorkspaceFileIds.value = [file.id]; referenceName.value = file.name
    presetPrompt.value = `请分析文件“${file.name}”。`
  } catch(cause) {
    if (sequence === referenceSequence) referenceError.value = cause instanceof Error ? cause.message : '无法引用文件'
  } finally { if (sequence === referenceSequence) referenceLoading.value = false }
}
watch(() => route.query.file, () => { void syncPersonalReference() }, { immediate: true })
watch(() => props.workspaceId, () => {
  clearPersonalReference()
  presetPrompt.value = ''
  resetComposerDraft()
})
onBeforeUnmount(() => { referenceSequence++ })

function onTeamStageSubmit(payload: {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  contextKey: string
  confirm?: () => void
  release?: () => void
}) {
  void submitTask({
    prompt: payload.prompt,
    files: payload.files,
    workspaceId: payload.workspaceId,
    mentions: payload.mentions,
    confirm: payload.confirm,
    release: payload.release,
  })
}

defineExpose({ useWorkspaceFile, focusComposer, submitWorkspaceTask: submitTask })
</script>

<template>
  <div
    ref="rootRef"
    class="conversation-starter"
    :class="{
      'conversation-starter--embedded': embedded,
    }"
    :data-testid="embedded ? 'workspace-composer-strip' : undefined"
  >
    <main class="workbench-stage">
      <section class="workbench-welcome" aria-labelledby="conversation-starter-title">
        <div class="workbench-welcome__copy">
          <h1 id="conversation-starter-title">{{ title }}</h1>
          <p>整理文档、查询制度、分析文件并形成可交付报告</p>
        </div>

        <p
          v-if="effectivePresetAgentMember"
          data-testid="preset-agent-member"
          class="conversation-starter__agent"
        >
          <el-icon><Cpu /></el-icon>
          <span>本次对话使用 Agent 成员：<strong>{{ effectivePresetAgentMember.name }}</strong>（{{ effectivePresetAgentMember.status === 'available' ? '可用' : '已停用，暂不可用' }}）</span>
        </p>

        <nav class="capability-strip" aria-label="常用任务">
          <button
            v-for="item in commonTasks"
            :key="item.label"
            class="capability-chip"
            :class="{ 'is-selected': selectedTask === item.label }"
            type="button"
            @click="selectTask(item)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <!--<div v-if="!workspaceLocked" class="personal-capability-actions">
          <el-button link @click="router.push('/skills')">选择 Skill</el-button>
          <el-button link @click="router.push('/files')">从我的文件引用</el-button>
        </div>-->
        <p v-if="referenceName">已引用：{{ referenceName }} <el-button link @click="clearPersonalReference">取消引用</el-button></p>
        <p v-if="referenceError" role="alert">{{ referenceError }} <el-button link @click="clearPersonalReference">取消引用</el-button></p>
        <p v-if="mcpAccessOmitted.length" class="mcp-access-omitted">本次不会使用：{{ mcpAccessOmitted.map(item => item.name).join('、') }}</p>
        <TeamSpaceComposer
          v-if="composerReady && useTeamSpaceComposer"
          ref="teamComposerRef"
          placement="stage"
          context-key="stage"
          :workspace-id="composerWorkspaceId"
          :workspace-name="composerWorkspaceName"
          :mention-options="mentionOptions"
          :drafts="teamComposerDrafts"
          :blocked-reason="blockedReason"
          :submitting="composerPermissionPending"
          :initial-prompt="presetPrompt"
          :files-require-mention="effectivePresetAgentMember?.status !== 'available'"
          @draft-change="(fromKey, draft) => emit('teamDraftChange', fromKey, draft)"
          @workspace-file-selected="onWorkspaceFileSelected"
          @submit="onTeamStageSubmit"
        />
        <p v-if="recommendationNotice === 'prefilled'" class="recommendation-notice" role="status" data-testid="recommendation-prefill-notice">
          已带入你在 dsh-work 助手那里的问题，确认后再发送；原对话记录与附件不会带入。
        </p>
        <p v-else-if="recommendationNotice === 'unavailable'" class="recommendation-notice recommendation-notice--blocked" role="alert">
          推荐的 AI 同事暂不可用：你已没有使用权限，或它已停用。
        </p>
        <TaskComposer
          v-if="composerReady && !useTeamSpaceComposer"
          ref="personalComposerRef"
          class="workbench-composer"
          :initial-prompt="presetPrompt"
          :initial-workspace-id="composerWorkspaceId"
          :initial-workspace-name="composerWorkspaceName"
          :workspaces="[]"
          :workspace-locked="workspaceLocked"
          :show-workspace-context="workspaceLocked"
          :selected-skill-name="selectedSkill?.name"
          :selected-agent-name="selectedAgent?.name"
          :blocked-reason="blockedReason"
          :submitting="composerPermissionPending"
          :mention-options="workspaceLocked ? composerMentionOptions : []"
          :files-require-mention="workspaceLocked && requiresAgentMember && effectivePresetAgentMember?.status !== 'available'"
          @submit="submitTask"
          @clear-skill="clearSelectedSkill"
          @clear-agent="clearSelectedAgent"
          @open-files="router.push('/files')"
        />
        <el-skeleton v-else-if="!composerReady" class="workbench-composer" :rows="3" animated />

        <footer v-if="!useTeamSpaceComposer" class="workbench-trust">
          <span>支持 PDF、DOCX、XLSX、XLS、CSV，单文件不超过 20 MB</span>
          <span v-if="!workspaceLocked || !requiresAgentMember">Enter 发送 · Shift + Enter 换行</span>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
.recommendation-notice { width: 100%; max-width: 760px; box-sizing: border-box; margin: 0 auto 10px; padding: 8px 12px; border-radius: var(--dsh-radius-sm); background: var(--dsh-color-brand-soft); color: var(--dsh-color-brand-dark); font-size: var(--dsh-font-size-badge); line-height: 1.6; }
.recommendation-notice--blocked { background: var(--dsh-color-warning-soft); color: var(--dsh-color-warning); }
.personal-capability-actions { display: flex; justify-content: center; gap: 12px; margin-bottom: 10px; }
.conversation-starter {
  min-height: 100vh;
  overflow: hidden;
  color: #242624;
  background:
    radial-gradient(circle at 56% 42%, rgb(233 244 239 / 30%), transparent 31%),
    #fff;
}

.workbench-stage {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 78px 34px 116px;
}

.workbench-welcome {
  position: relative;
  width: min(100%, 860px);
  transform: translateY(-3vh);
}

.workbench-welcome__copy {
  text-align: center;
}

.workbench-welcome h1 {
  margin: 0;
  color: #1d1f1d;
  font-size: var(--dsh-font-size-hero);
  font-weight: 680;
  letter-spacing: -0.045em;
}

.workbench-welcome__copy p {
  min-height: 20px;
  margin: 9px 0 0;
  color: #858985;
  font-size: var(--dsh-font-size-caption);
}

.capability-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 22px 0 8px;
  padding: 0 1px;
  overflow-x: auto;
  scrollbar-width: none;
}

.capability-strip::-webkit-scrollbar {
  display: none;
}

.capability-chip {
  display: inline-flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px solid #e1e2df;
  border-radius: 999px;
  color: #5f645f;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}

.capability-chip:hover {
  border-color: #bfc8c3;
  color: #263d35;
  background: #f6f9f7;
}

.capability-chip.is-selected {
  border-color: #9fc8ba;
  color: #155e4b;
  background: #edf7f3;
}

.capability-chip .el-icon {
  font-size: var(--dsh-font-size-body);
}

.conversation-starter__agent {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 18px 0 -6px;
  color: #4a5a54;
  font-size: var(--dsh-font-size-badge);
}

.conversation-starter__agent strong {
  font-weight: 650;
}

.workbench-composer {
  width: 100%;
}

.workbench-trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 10px;
  color: #999d99;
  font-size: var(--dsh-font-size-micro);
}

.workbench-trust span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.conversation-starter--embedded .workbench-stage {
  min-height: 100%;
  height: 100%;
  padding-right: 28px;
  padding-left: 28px;
}

.conversation-starter--embedded {
  min-height: 100%;
  height: 100%;
}

.conversation-starter--composer-only {
  min-height: 0;
  height: auto;
  flex: 0 0 auto;
  background: #fff;
}

.conversation-starter--composer-only.conversation-starter--embedded {
  min-height: 0;
  height: auto;
}

.workspace-composer-strip {
  padding: 12px 20px 14px;
  border-top: 1px solid #e8ebe8;
  background: #fff;
}

.workbench-trust--compact {
  justify-content: flex-start;
  margin-top: 6px;
}

.conversation-starter--embedded .workbench-welcome {
  transform: translateY(-1.5vh);
}

@media (max-width: 640px) {
  .workbench-stage,
  .conversation-starter--embedded .workbench-stage {
    align-items: flex-start;
    padding: 88px 14px 64px;
  }

  .workbench-welcome,
  .conversation-starter--embedded .workbench-welcome {
    transform: none;
  }

  .workbench-welcome h1 {
    font-size: var(--dsh-font-size-metric);
  }

  .workbench-welcome__copy p {
    padding: 0 22px;
    line-height: 1.55;
  }

  .capability-strip {
    justify-content: flex-start;
    margin-right: -14px;
    margin-left: -14px;
    padding: 0 14px;
  }

  .workbench-trust {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    padding: 0 8px;
  }
}
</style>
