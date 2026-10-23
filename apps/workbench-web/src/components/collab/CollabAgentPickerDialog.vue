<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useContentStore } from '@/stores/content'

/** 协作模式「发起对话」：从可用 AI 同事中选一位单聊，选中后由上层决定如何打开。 */
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; pick: [agentId: string] }>()

const content = useContentStore()
const keyword = ref('')
const loading = ref(false)
const error = ref('')

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
})

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return content.agents
  return content.agents.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(text))
})

async function loadAgents() {
  loading.value = true
  error.value = ''
  try {
    await content.refreshAgents()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'AI 同事加载失败'
  } finally {
    loading.value = false
  }
}

watch(() => props.modelValue, open => {
  if (!open) return
  keyword.value = ''
  void loadAgents()
}, { immediate: true })

function pick(agentId: string) {
  emit('pick', agentId)
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" class="collab-agent-picker" title="发起对话" width="440px" append-to-body>
    <el-input v-model="keyword" aria-label="搜索 AI 同事" placeholder="搜索 AI 同事" clearable />
    <el-alert v-if="error" class="collab-agent-picker__alert" type="error" :closable="false" show-icon :title="error">
      <el-button link type="primary" @click="loadAgents">重试</el-button>
    </el-alert>
    <el-skeleton v-else-if="loading && !content.agents.length" :rows="3" animated />
    <p v-else-if="!filtered.length" class="collab-agent-picker__empty">没有可用的 AI 同事</p>
    <ul v-else class="collab-agent-picker__list" aria-label="AI 同事">
      <li v-for="agent in filtered" :key="agent.id">
        <button type="button" class="collab-agent-picker__item" :aria-label="`与 ${agent.name} 对话`" @click="pick(agent.id)">
          <span class="collab-agent-picker__avatar" aria-hidden="true">{{ agent.name.slice(0, 1) }}</span>
          <span class="collab-agent-picker__copy">
            <strong>{{ agent.name }}</strong>
            <small>{{ agent.description }}</small>
          </span>
        </button>
      </li>
    </ul>
  </el-dialog>
</template>

<style scoped>
.collab-agent-picker__alert { margin-top: 12px; }
.collab-agent-picker__empty { margin: 24px 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-body); text-align: center; }
.collab-agent-picker__list { max-height: 50vh; margin: 12px 0 0; padding: 0; overflow: auto; list-style: none; }
.collab-agent-picker__item {
  display: flex; width: 100%; align-items: center; gap: 12px; padding: 10px 8px;
  border: 0; border-radius: 10px; color: inherit; background: transparent; cursor: pointer; text-align: left;
}
.collab-agent-picker__item:hover, .collab-agent-picker__item:focus-visible { background: var(--dsh-color-brand-soft); }
.collab-agent-picker__avatar {
  display: grid; width: 40px; height: 40px; flex: 0 0 auto; place-items: center; border-radius: 50%;
  color: #fff; background: var(--dsh-color-brand); font-size: var(--dsh-font-size-title); font-weight: 700;
}
.collab-agent-picker__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.collab-agent-picker__copy strong { overflow: hidden; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.collab-agent-picker__copy small {
  display: -webkit-box; overflow: hidden; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption);
  -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
}
</style>
