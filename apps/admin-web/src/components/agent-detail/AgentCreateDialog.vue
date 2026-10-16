<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { AGENT_DRAFT_BOUNDS, emptyAgentDraftForm, validateAgentDraft } from '@/composables/use-agent-draft'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition } from '@/types/domain'

const emit = defineEmits<{ created: [agent: AgentDefinition] }>()
const open = defineModel<boolean>({ default: false })

const authStore = useAuthStore()
const contentStore = useContentStore()
const saving = ref(false)
const attempted = ref(false)
const form = reactive({ name: '', description: '', systemPrompt: '' })

const errors = computed(() => {
  if (!attempted.value) return {}
  const all = validateAgentDraft({ ...emptyAgentDraftForm(), ...form })
  return { name: all.name, description: all.description, systemPrompt: all.systemPrompt }
})

watch(open, value => {
  if (!value) return
  Object.assign(form, { name: '', description: '', systemPrompt: '' })
  attempted.value = false
})

function createAgentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `agent-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

async function create() {
  attempted.value = true
  if (Object.values(errors.value).some(Boolean)) return
  saving.value = true
  try {
    const defaults = emptyAgentDraftForm()
    const agent = await contentStore.createAgentDraft({
      ...defaults,
      id: createAgentId(),
      name: form.name.trim(),
      description: form.description.trim(),
      systemPrompt: form.systemPrompt.trim(),
      owner: authStore.user.name,
      department: authStore.user.department,
      changeSummary: '创建 Agent 初始版本',
    })
    open.value = false
    emit('created', agent)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Agent 创建失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="open" title="创建 Agent" width="min(640px, calc(100vw - 32px))" :close-on-click-modal="false" destroy-on-close>
    <p class="intro">先填写基础定义，创建后在详情页继续配置能力、岗位权限并验证发布。平台会自动创建独立执行身份，不继承你的权限。</p>
    <el-form label-position="top" @submit.prevent="create">
      <el-form-item label="Agent 名称" :error="errors.name" required>
        <el-input v-model="form.name" :maxlength="AGENT_DRAFT_BOUNDS.name.max" show-word-limit placeholder="例如：质量异常分析助手" />
      </el-form-item>
      <el-form-item label="Agent 说明" :error="errors.description" required>
        <el-input v-model="form.description" type="textarea" :rows="3" :maxlength="AGENT_DRAFT_BOUNDS.description.max" show-word-limit placeholder="说明这个 Agent 面向谁、能够解决什么问题" />
      </el-form-item>
      <el-form-item label="SOUL.md（人格与工作原则）" :error="errors.systemPrompt" required>
        <el-input v-model="form.systemPrompt" type="textarea" :rows="6" :maxlength="AGENT_DRAFT_BOUNDS.instructions.max" show-word-limit placeholder="定义 Agent 的稳定职责、工作原则、沟通风格、禁止事项和转人工条件" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" data-action="confirm-create-agent" @click="create">创建并继续配置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.intro { margin: 0 0 14px; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
</style>
