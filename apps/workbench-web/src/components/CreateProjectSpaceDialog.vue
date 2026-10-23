<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { workbenchApi } from '@/api/client'
import MemberPicker, { type MemberPickerItem, type MemberPickerLoader } from '@/components/MemberPicker.vue'
import { useContentStore } from '@/stores/content'
import type { Workspace } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 创建项目空间 / 新建群组（A、B 共用，方案 12.8 #4）：至少选择一位 AI 同事，同事可一并选入。
 * 成员选择器与群组“添加成员”共用（MemberPicker）。选了同事时提交前预览数据范围影响，
 * 与创建后邀请同事同一口径。
 */
const props = defineProps<{ modelValue: boolean; mode: 'work' | 'collab' }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [workspace: Workspace]
}>()

const PEOPLE_PAGE_SIZE = 30
const contentStore = useContentStore()
const name = ref('')
const description = ref('')
const selectedAgents = ref<MemberPickerItem[]>([])
const selectedPeople = ref<MemberPickerItem[]>([])
const agentsReady = ref(false)
const submitting = ref(false)
let agentsFetch: Promise<void> | null = null

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
})
const noun = computed(() => (props.mode === 'collab' ? '群组' : '项目空间'))
const title = computed(() => (props.mode === 'collab' ? '新建群组' : '创建项目空间'))
const trimmedName = computed(() => name.value.trim())
const nameValid = computed(() => trimmedName.value.length >= 2 && trimmedName.value.length <= 60)
const canSubmit = computed(() => nameValid.value && selectedAgents.value.length > 0)
const showAgentHint = computed(() => selectedAgents.value.length === 0 && agentsReady.value && contentStore.agents.length > 0)

/** AI 同事：员工可用的全部 AI 同事（每次打开刷新一次），按关键词在本地过滤。 */
const loadAgents: MemberPickerLoader = async ({ query }) => {
  agentsFetch ??= contentStore.refreshAgents().then(() => undefined)
  try {
    await agentsFetch
  } catch (cause) {
    agentsFetch = null
    throw cause instanceof Error ? cause : new Error('AI 同事加载失败')
  }
  const text = query?.toLowerCase() ?? ''
  const items = contentStore.agents
    .filter(agent => !text || `${agent.name} ${agent.description}`.toLowerCase().includes(text))
    .map(agent => ({ id: agent.id, name: agent.name, description: agent.description }))
  return { items, nextCursor: null }
}

/** 同事：服务端按关键词检索并分页，不含本人。 */
const loadPeople: MemberPickerLoader = async ({ query, cursor }) => {
  const page = await workbenchApi.listNewSpaceMemberCandidates({ query, cursor, limit: PEOPLE_PAGE_SIZE })
  return {
    items: page.items.map(person => ({ id: person.id, name: person.displayName, description: person.department })),
    nextCursor: page.nextCursor,
  }
}

/** 只有一位 AI 同事时默认选中。 */
function onAgentsLoaded(items: MemberPickerItem[]) {
  agentsReady.value = true
  if (items.length === 1 && selectedAgents.value.length === 0) selectedAgents.value = [items[0]!]
}

function resetForm() {
  name.value = ''
  description.value = ''
  selectedAgents.value = []
  selectedPeople.value = []
}

watch(() => props.modelValue, open => {
  if (!open) return
  agentsFetch = null
  agentsReady.value = false
}, { immediate: true })

/** 选了同事时先预览数据范围影响；有影响需确认，取消则不创建。 */
async function confirmDisclosureImpact(agentIds: string[], memberUserIds: string[]) {
  if (!memberUserIds.length) return true
  const impacts = await workbenchApi.previewNewSpaceDisclosureImpact({ agentIds, memberUserIds })
  if (!impacts.length) return true
  const lines = impacts.map(item => `“${item.name}”将不能再使用：${item.lostDataScopes.join('、')}`)
  try {
    await ElMessageBox.confirm(
      `Agent 在本${noun.value}只能使用全体成员共同拥有的数据范围。加入所选同事后：\n${lines.join('\n')}`,
      '加入后 Agent 的可用数据范围会缩小',
      { confirmButtonText: `仍然创建`, cancelButtonText: '返回修改', type: 'warning', customStyle: { whiteSpace: 'pre-line' } },
    )
    return true
  } catch {
    return false
  }
}

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const finalName = trimmedName.value
  const agentIds = selectedAgents.value.map(agent => agent.id)
  const memberUserIds = selectedPeople.value.map(person => person.id)
  try {
    if (!(await confirmDisclosureImpact(agentIds, memberUserIds))) return
    const workspace = await contentStore.createTeamWorkspace({
      name: finalName,
      description: description.value.trim(),
      agentIds,
      memberUserIds,
    })
    ElMessage.success(`已创建${noun.value}“${finalName}”`)
    resetForm()
    visible.value = false
    emit('created', workspace)
  } catch (cause) {
    notifyActionFailure('创建', `${noun.value}“${finalName}”`, cause, '检查所选 AI 同事与同事是否仍可加入后重试。')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="min(880px, calc(100vw - 32px))" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item :label="`${noun}名称`" required>
        <el-input v-model="name" maxlength="60" show-word-limit :aria-label="`${noun}名称`" placeholder="例如：九月交付风险分析" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input
          v-model="description"
          type="textarea"
          :rows="2"
          maxlength="120"
          show-word-limit
          aria-label="说明"
          placeholder="说明这个项目的目标与范围"
        />
      </el-form-item>
      <el-form-item label="成员" required>
        <p class="create-space__helper">
          {{ noun }}至少需要一位 AI 同事；同事可现在选择，也可创建后在{{ mode === 'collab' ? '群组' : '成员管理' }}中添加。
        </p>
        <MemberPicker
          v-model:agents="selectedAgents"
          v-model:people="selectedPeople"
          :active="modelValue"
          :load-agents="loadAgents"
          :load-people="loadPeople"
          @agents-loaded="onAgentsLoaded"
        />
        <p v-if="showAgentHint" class="create-space__hint" role="alert">至少选择一位 AI 同事</p>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">
        {{ mode === 'collab' ? '创建群组' : '创建项目空间' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.create-space__helper { width: 100%; margin: 0 0 8px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); line-height: 1.5; }
.create-space__hint { margin: 6px 0 0; color: var(--dsh-color-danger, var(--el-color-danger)); font-size: var(--dsh-font-size-caption); }
</style>
