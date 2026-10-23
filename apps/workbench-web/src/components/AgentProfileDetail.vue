<script setup lang="ts">
import { UserFilled } from '@element-plus/icons-vue'

import type { WorkbenchAgent } from '@/types/domain'

/** AI 同事详情内容（A 的 AI 同事广场抽屉与 B 的 AI 同事页共用）。 */
defineProps<{ agent: WorkbenchAgent }>()
</script>

<template>
  <div class="agent-detail">
    <div class="agent-detail__header">
      <span class="agent-detail__icon"><el-icon><UserFilled /></el-icon></span>
      <div>
        <h2>{{ agent.name }}</h2>
        <p>已发布 · v{{ agent.version }}</p>
      </div>
    </div>
    <p class="agent-detail__description">{{ agent.description }}</p>
    <div class="agent-detail__welcome">
      <span>开场提示</span>
      <p>{{ agent.welcomeMessage }}</p>
    </div>
    <div v-if="agent.examplePrompts.length" class="agent-detail__examples">
      <span>你可以这样问</span>
      <ul>
        <li v-for="prompt in agent.examplePrompts" :key="prompt">{{ prompt }}</li>
      </ul>
    </div>
    <div v-if="$slots.actions" class="agent-detail__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.agent-detail { display: flex; flex-direction: column; gap: 18px; }
.agent-detail__header { display: flex; align-items: center; gap: 10px; }
.agent-detail__icon { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #245e4d; background: #dff3e9; font-size: var(--dsh-font-size-section); }
.agent-detail__header h2 { margin: 0; color: #222522; font-size: var(--dsh-font-size-section); }
.agent-detail__header p { margin: 5px 0 0; color: #899089; font-size: var(--dsh-font-size-caption); }
.agent-detail__description { margin: 0; color: #555d57; font-size: var(--dsh-font-size-body); line-height: 1.7; }
.agent-detail__welcome { padding: 14px; border-radius: 10px; background: #f4f8f5; }
.agent-detail__welcome span,
.agent-detail__examples > span { color: #6c8578; font-size: var(--dsh-font-size-micro); }
.agent-detail__welcome p { margin: 7px 0 0; color: #345d4c; line-height: 1.6; }
.agent-detail__examples { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.agent-detail__examples ul { margin: 0; padding-left: 18px; color: #4b655a; line-height: 1.7; }
.agent-detail__actions { align-self: flex-start; }
</style>
