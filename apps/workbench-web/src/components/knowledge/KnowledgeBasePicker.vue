<script setup lang="ts">
import { computed, ref } from 'vue'
import { Notebook } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { KnowledgeBase, SessionKnowledgeBase } from '@/types/knowledge'

/**
 * 对话输入框旁的“添加知识库”（weknora-knowledge-plan 5.7）：只列出本人当前可见的知识库，多选后
 * 整体交给调用方保存。已选但已不可见的知识库保留在结果中，由调用方决定是否移除。
 */
const props = defineProps<{ selected: SessionKnowledgeBase[] }>()
const emit = defineEmits<{ change: [items: SessionKnowledgeBase[]] }>()

const open = ref(false)
const loading = ref(false)
const error = ref('')
const bases = ref<KnowledgeBase[]>([])
const checked = ref<string[]>([])

const unavailable = computed(() => props.selected.filter(item => !bases.value.some(base => base.id === item.id)))

async function show() {
  open.value = true
  checked.value = props.selected.map(item => item.id)
  loading.value = true
  error.value = ''
  try {
    bases.value = await workbenchApi.listKnowledgeBases({ stats: false })
  } catch (cause) {
    bases.value = []
    error.value = cause instanceof Error ? cause.message : '知识库服务暂不可用，请稍后重试'
  } finally {
    loading.value = false
  }
}

function confirm() {
  const chosen = new Set(checked.value)
  const items: SessionKnowledgeBase[] = [
    ...unavailable.value.filter(item => chosen.has(item.id)),
    ...bases.value.filter(base => chosen.has(base.id)).map(base => ({ id: base.id, name: base.name, available: true })),
  ]
  open.value = false
  emit('change', items)
}
</script>

<template>
  <button class="knowledge-picker__trigger" type="button" @click="show">
    <el-icon aria-hidden="true"><Notebook /></el-icon>
    <span>添加知识库</span>
  </button>
  <el-dialog v-model="open" title="添加知识库" width="480px" append-to-body>
    <p class="knowledge-picker__hint">只列出你当前可以查看的知识库。添加后本对话的每次提问都会在其中检索，可随时移除。</p>
    <el-skeleton v-if="loading" :rows="3" animated />
    <el-empty v-else-if="error" :description="error" :image-size="64" />
    <el-empty v-else-if="!bases.length" description="还没有你可以查看的知识库" :image-size="64" />
    <el-checkbox-group v-else v-model="checked" class="knowledge-picker__list">
      <el-checkbox v-for="base in bases" :key="base.id" :value="base.id" :aria-label="base.name" class="knowledge-picker__item" border>
        <span class="knowledge-picker__name">{{ base.name }}</span>
        <span class="knowledge-picker__meta">归属 {{ base.ownerDepartmentName }}</span>
      </el-checkbox>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :disabled="loading" @click="confirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.knowledge-picker__trigger {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 8px;
  background: var(--dsh-color-panel);
  color: var(--dsh-color-text);
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
}

.knowledge-picker__trigger:hover {
  border-color: var(--dsh-color-border-strong);
  background: var(--dsh-color-canvas);
}

.knowledge-picker__hint {
  margin: 0 0 12px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.knowledge-picker__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.knowledge-picker__item {
  width: 100%;
  height: auto;
  min-height: 48px;
  margin-right: 0;
  padding: 8px 12px;
}

.knowledge-picker__item :deep(.el-checkbox__label) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.knowledge-picker__name {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
}

.knowledge-picker__meta {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}
</style>
