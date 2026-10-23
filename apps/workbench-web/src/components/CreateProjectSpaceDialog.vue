<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { useContentStore } from '@/stores/content'
import type { Workspace } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/** 创建项目空间 / 新建群组（A、B 共用，方案 12.8 #4）：至少选择一位 AI 同事。 */
const props = defineProps<{ modelValue: boolean; mode: 'work' | 'collab' }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [workspace: Workspace]
}>()

const SEARCH_THRESHOLD = 6
const contentStore = useContentStore()
const name = ref('')
const description = ref('')
const selectedIds = ref<string[]>([])
const keyword = ref('')
const loadingAgents = ref(false)
const agentError = ref('')
const submitting = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
})
const noun = computed(() => (props.mode === 'collab' ? '群组' : '项目空间'))
const title = computed(() => (props.mode === 'collab' ? '新建群组' : '创建项目空间'))
const agents = computed(() => contentStore.agents)
const showSearch = computed(() => agents.value.length > SEARCH_THRESHOLD)
const filteredAgents = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return agents.value
  return agents.value.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(text))
})
const trimmedName = computed(() => name.value.trim())
const nameValid = computed(() => trimmedName.value.length >= 2 && trimmedName.value.length <= 60)
const canSubmit = computed(() => nameValid.value && selectedIds.value.length > 0)
const showAgentHint = computed(() => selectedIds.value.length === 0 && !loadingAgents.value && !agentError.value && agents.value.length > 0)

function resetForm() {
  name.value = ''
  description.value = ''
  selectedIds.value = []
  keyword.value = ''
}

async function loadAgents() {
  loadingAgents.value = true
  agentError.value = ''
  try {
    await contentStore.refreshAgents()
    if (agents.value.length === 1 && selectedIds.value.length === 0) {
      selectedIds.value = [agents.value[0]!.id]
    }
  } catch (cause) {
    agentError.value = cause instanceof Error ? cause.message : 'AI 同事加载失败'
  } finally {
    loadingAgents.value = false
  }
}

watch(() => props.modelValue, open => {
  if (open) void loadAgents()
}, { immediate: true })

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const finalName = trimmedName.value
  try {
    const workspace = await contentStore.createTeamWorkspace({
      name: finalName,
      description: description.value.trim(),
      agentIds: [...selectedIds.value],
    })
    ElMessage.success(`已创建${noun.value}“${finalName}”`)
    resetForm()
    visible.value = false
    emit('created', workspace)
  } catch (cause) {
    notifyActionFailure('创建', `${noun.value}“${finalName}”`, cause, '检查所选 AI 同事是否仍可用后重试。')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="min(520px, calc(100vw - 32px))" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item :label="`${noun}名称`" required>
        <el-input v-model="name" maxlength="60" show-word-limit :aria-label="`${noun}名称`" placeholder="例如：九月交付风险分析" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input
          v-model="description"
          type="textarea"
          :rows="3"
          maxlength="120"
          show-word-limit
          aria-label="说明"
          placeholder="说明这个项目的目标与范围"
        />
      </el-form-item>
      <el-form-item label="AI 同事" required>
        <div class="create-space__agents">
          <p class="create-space__helper">
            {{ mode === 'collab' ? '群组至少需要一位 AI 同事；创建后可在群信息中邀请同事。' : '项目空间至少需要一位 AI 同事；创建后可在成员管理中邀请同事。' }}
          </p>
          <el-alert v-if="agentError" type="error" :closable="false" show-icon :title="agentError">
            <el-button link type="primary" @click="loadAgents">重试</el-button>
          </el-alert>
          <el-skeleton v-else-if="loadingAgents && !agents.length" :rows="3" animated />
          <p v-else-if="!agents.length" class="create-space__empty">没有可用的 AI 同事</p>
          <template v-else>
            <el-input v-if="showSearch" v-model="keyword" aria-label="搜索 AI 同事" placeholder="搜索 AI 同事" clearable />
            <el-checkbox-group v-model="selectedIds" class="create-space__list" aria-label="选择 AI 同事">
              <el-checkbox v-for="agent in filteredAgents" :key="agent.id" :value="agent.id" :label="agent.name" class="create-space__item">
                <span class="create-space__copy">
                  <strong>{{ agent.name }}</strong>
                  <small>{{ agent.description }}</small>
                </span>
              </el-checkbox>
            </el-checkbox-group>
            <p v-if="showSearch && !filteredAgents.length" class="create-space__empty">没有匹配的 AI 同事</p>
          </template>
          <p v-if="showAgentHint" class="create-space__hint" role="alert">至少选择一位 AI 同事</p>
        </div>
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
.create-space__agents { display: flex; width: 100%; flex-direction: column; gap: 8px; }
.create-space__helper { margin: 0; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); line-height: 1.5; }
.create-space__list { display: flex; max-height: 220px; flex-direction: column; gap: 4px; overflow: auto; }
.create-space__item { height: auto; min-height: 40px; margin: 0; padding: 6px 10px; border: 1px solid var(--dsh-color-border); border-radius: 8px; white-space: normal; }
.create-space__copy { display: flex; min-width: 0; flex-direction: column; line-height: 1.4; }
.create-space__copy strong { font-size: var(--dsh-font-size-body); }
.create-space__copy small { overflow: hidden; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.create-space__empty { margin: 0; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); }
.create-space__hint { margin: 0; color: var(--dsh-color-danger, var(--el-color-danger)); font-size: var(--dsh-font-size-caption); }
</style>
