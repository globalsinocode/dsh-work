<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useRoute, useRouter } from 'vue-router'
import {
  Cpu,
  Document,
  DocumentChecked,
  Files,
  Reading,
} from '@element-plus/icons-vue'

import { TaskComposer } from '@dsh-work/workbench-components'
import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { WorkbenchSkill, WorkspaceFile } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const props = withDefaults(
  defineProps<{
    workspaceId?: string
    workspaceName?: string
    workspaceLocked?: boolean
    embedded?: boolean
    title?: string
    /**
     * 团队空间 Agent 成员的行内「开始对话」预选（plan TW-02）。个人空间不传，
     * 启动参数保持现状（AC-23）。
     */
    presetAgentMember?: { id: string; name: string; status: 'available' | 'disabled' } | null
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
    /**
     * 输入框可 @ 的 Agent 成员（TW-10）：id + 展示名，与工作空间详情页的
     * startable 过滤口径一致；非团队锁定场景传空。
     */
    mentionOptions?: Array<{ id: string; name: string }>
  }>(),
  {
    workspaceId: '',
    workspaceName: '',
    workspaceLocked: false,
    embedded: false,
    title: 'dsh-work，我帮你',
    presetAgentMember: null,
    startableAgentMemberIds: () => [],
    requiresAgentMember: false,
    canDiscuss: true,
    mentionOptions: () => [],
  },
)

/**
 * TW-10：团队共享讨论里普通成员可直接发言（不产生 Run）或在文本里 @ Agent
 * 触发执行；只有只读成员/角色未知时才整体阻止。Agent 预选（右栏「开始对话」）
 * 现在只是「首条消息默认 @ 谁」的快捷方式，不再是进入对话的前置条件。
 */
const blockedReason = computed(() => {
  if (!props.requiresAgentMember) return ''
  return props.canDiscuss ? '' : '当前角色为只读成员或尚无写权限，不能发言或发起执行；请联系负责人。'
})

const router = useRouter()
const route = useRoute()
const taskStore = useTaskStore()
const contentStore = useContentStore()
const rootRef = ref<HTMLElement>()
const workspaceLoadFinished = ref(false)

const selectedTask = ref('')
const presetPrompt = ref('')
const composerKey = ref(0)
const referencedWorkspaceFileIds = ref<string[]>([])
const selectedSkillId = ref('')

const personalWorkspace = computed(() =>
  contentStore.workspaces.find(workspace => workspace.type === 'personal'),
)
/**
 * 全局新对话的空间选择器（3-T3 design §2.7/§3）：归档团队空间属执行轨，
 * 不允许在这里被选中发起新对话——服务端会拒绝，列出来只会让用户走进死路。
 * 当前所在空间（workspaceLocked）不经过该列表，归档态由详情页自行隐藏入口。
 */
const selectableWorkspaces = computed(() =>
  contentStore.workspaces.filter(workspace => workspace.type === 'personal' || workspace.status !== 'archived'),
)
const selectedWorkspace = computed(() => {
  if (props.workspaceLocked) {
    return contentStore.workspaces.find(workspace => workspace.id === props.workspaceId)
  }
  return personalWorkspace.value ?? contentStore.workspaces[0]
})
const composerWorkspaceId = computed(() =>
  props.workspaceLocked ? props.workspaceId : (selectedWorkspace.value?.id ?? ''),
)
const composerWorkspaceName = computed(() =>
  props.workspaceLocked ? props.workspaceName : (selectedWorkspace.value?.name ?? '我的空间'),
)
const composerReady = computed(() =>
  props.workspaceLocked || contentStore.initialized || workspaceLoadFinished.value,
)
const selectedSkill = computed<WorkbenchSkill | undefined>(() =>
  contentStore.skills.find(skill => skill.id === selectedSkillId.value),
)
/**
 * 唯一可发起 Agent 的兜底预选：父级已传入的显式/自动选择优先；组件自身在
 * 仅一个 startable 成员时也会选中，多个成员或用户已选择时绝不改写。
 */
const effectivePresetAgentMember = computed(() => {
  if (props.presetAgentMember) return props.presetAgentMember
  if (!props.workspaceLocked || !props.requiresAgentMember) return null
  const startable = props.mentionOptions.filter(option => props.startableAgentMemberIds.includes(option.id))
  return startable.length === 1 ? { ...startable[0]!, status: 'available' as const } : null
})

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
  void nextTick(() => rootRef.value?.querySelector<HTMLTextAreaElement>('.composer__input')?.focus())
}

function selectTask(item: (typeof commonTasks)[number]) {
  selectedTask.value = item.label
  referencedWorkspaceFileIds.value = []
  presetPrompt.value = item.prompt
  composerKey.value += 1
  focusComposer()
}

function useWorkspaceFile(file: WorkspaceFile) {
  selectedTask.value = '分析文件'
  referencedWorkspaceFileIds.value = [file.id]
  presetPrompt.value = `请分析工作空间文件“${file.name}”，概括关键信息、异常项和需要跟进的问题。 @工作空间文件`
  composerKey.value += 1
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

async function submitTask(payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm?: () => void }) {
  if (blockedReason.value) {
    ElMessage.warning(blockedReason.value)
    return
  }
  try {
    // TW-10：文本中显式 @ 的 Agent 成员优先于右栏预选（预选只是默认值）。
    const presetMemberId = effectivePresetAgentMember.value?.status === 'available'
      ? effectivePresetAgentMember.value.id
      : undefined
    const mentionedId = (payload.mentions ?? []).find(id => props.startableAgentMemberIds.includes(id))
    const workspaceAgentMemberId = props.workspaceLocked ? (mentionedId ?? presetMemberId) : undefined
    if (props.workspaceLocked && props.requiresAgentMember && !workspaceAgentMemberId) {
      // 团队空间、无 @ 也无预选：开启纯讨论会话（不产生 Run）。
      if (payload.files.length || referencedWorkspaceFileIds.value.length) {
        ElMessage.warning('带附件的消息需要 @Agent 发起执行；纯讨论消息不支持附件。')
        return
      }
      const session = await workbenchApi.createSession({
        title: payload.prompt,
        workspaceId: payload.workspaceId,
      })
      await taskStore.postSessionMessage(session.id, payload.prompt)
      await router.push(conversationPath(payload.workspaceId, session.id))
      payload.confirm?.()
      referencedWorkspaceFileIds.value = []
      return
    }
    const task = selectedSkillId.value
      ? await taskStore.createTask(
          payload.prompt,
          payload.files,
          payload.workspaceId,
          props.workspaceLocked ? props.workspaceName : composerWorkspaceName.value,
          undefined,
          referencedWorkspaceFileIds.value,
          selectedSkillId.value,
          workspaceAgentMemberId,
        )
      : await taskStore.createTask(
          payload.prompt,
          payload.files,
          payload.workspaceId,
          props.workspaceLocked ? props.workspaceName : composerWorkspaceName.value,
          undefined,
          referencedWorkspaceFileIds.value,
          undefined,
          workspaceAgentMemberId,
        )
    await router.push(conversationPath(payload.workspaceId, task.id))
    payload.confirm?.()
    referencedWorkspaceFileIds.value = []
  } catch (error) {
    notifyActionFailure('创建对话', props.workspaceLocked ? `工作空间“${props.workspaceName}”` : '新对话', error, '检查 Agent、工作空间、附件和输入内容后重新提交。')
  }
}

function syncSkillFromRoute() {
  const skillId = typeof route.query.skill === 'string' ? route.query.skill : ''
  selectedSkillId.value = contentStore.skills.some(skill => skill.id === skillId) ? skillId : ''
  const skill = selectedSkill.value
  if (skill) {
    selectedTask.value = ''
    presetPrompt.value = skill.testPrompt
    composerKey.value += 1
    focusComposer()
  }
}

function clearSelectedSkill() {
  selectedSkillId.value = ''
  const query = { ...route.query }
  delete query.skill
  void router.replace({ query })
}

onMounted(async () => {
  try {
    await Promise.all([
      props.workspaceLocked ? Promise.resolve() : contentStore.load(),
      props.workspaceLocked && !route.query.skill ? Promise.resolve() : contentStore.refreshSkills(),
    ])
    syncSkillFromRoute()
  } catch (error) {
    notifyActionFailure('加载员工能力', 'Skill 广场', error, '仍可继续发送普通对话；稍后刷新页面重试 Skill。')
  } finally {
    workspaceLoadFinished.value = true
  }
})

watch(() => route.query.skill, syncSkillFromRoute)

defineExpose({ useWorkspaceFile })
</script>

<template>
  <div
    ref="rootRef"
    class="conversation-starter"
    :class="{ 'conversation-starter--embedded': embedded }"
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

        <TaskComposer
          v-if="composerReady"
          :key="composerKey"
          class="workbench-composer"
          :initial-prompt="presetPrompt"
          :initial-workspace-id="composerWorkspaceId"
          :initial-workspace-name="composerWorkspaceName"
          :workspaces="selectableWorkspaces"
          :workspace-locked="workspaceLocked"
          :selected-skill-name="selectedSkill?.name"
          :blocked-reason="blockedReason"
          :mention-options="workspaceLocked ? mentionOptions : []"
          :files-require-mention="workspaceLocked && requiresAgentMember && effectivePresetAgentMember?.status !== 'available'"
          @submit="submitTask"
          @clear-skill="clearSelectedSkill"
        />
        <el-skeleton v-else class="workbench-composer" :rows="3" animated />

        <footer class="workbench-trust">
          <span>支持 PDF、DOCX、XLSX、CSV，单文件不超过 20 MB</span>
          <span>Enter 发送 · Shift + Enter 换行</span>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
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
