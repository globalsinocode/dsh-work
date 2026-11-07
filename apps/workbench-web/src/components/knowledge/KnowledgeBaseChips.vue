<script setup lang="ts">
import { Close, Notebook } from '@element-plus/icons-vue'

import type { SessionKnowledgeBase } from '@/types/knowledge'

/** 输入框上方“本对话检索”的知识库标签（weknora-knowledge-plan 5.7）；已不可用的标出原因，仍可移除。 */
defineProps<{ items: SessionKnowledgeBase[] }>()
const emit = defineEmits<{ remove: [id: string] }>()
</script>

<template>
  <div v-if="items.length" class="knowledge-chips" aria-label="本对话检索的知识库">
    <span class="knowledge-chips__label">本对话检索：</span>
    <span
      v-for="item in items"
      :key="item.id"
      class="knowledge-chip"
      :class="{ 'knowledge-chip--unavailable': !item.available }"
    >
      <el-icon aria-hidden="true"><Notebook /></el-icon>
      <span>{{ item.name }}<template v-if="!item.available">（已无权查看）</template></span>
      <button type="button" :aria-label="`移除知识库 ${item.name}`" @click="emit('remove', item.id)">
        <el-icon><Close /></el-icon>
      </button>
    </span>
  </div>
</template>

<style scoped>
.knowledge-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  /* 与输入框文字对齐（TaskComposer 的输入区左右内边距约 13～17px）。 */
  padding: 12px 15px 0;
}

.knowledge-chips__label {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.knowledge-chip {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 4px;
  padding: 0 2px 0 9px;
  border-radius: 999px;
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
  font-size: var(--dsh-font-size-caption);
}

.knowledge-chip--unavailable {
  background: var(--dsh-color-canvas);
  color: var(--dsh-color-muted);
  text-decoration: line-through;
}

.knowledge-chip button {
  display: inline-grid;
  width: 22px;
  height: 22px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.knowledge-chip button:hover {
  background: rgb(53 100 232 / 12%);
}
</style>
