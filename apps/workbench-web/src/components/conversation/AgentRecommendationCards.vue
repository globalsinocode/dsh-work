<script setup lang="ts">
import { ref } from 'vue'
import { Right, User } from '@element-plus/icons-vue'

import type { AgentRecommendation } from '@/types/domain'

/**
 * 推荐 AI 同事卡片（推荐方案 4.2）：名称与说明取同事当前启用版本，推荐理由按纯文本显示。
 * “去聊天”只发事件，跳转由调用方按当前模式决定；同事已不可用时就地提示，不跳转。
 */
defineProps<{ recommendations: AgentRecommendation[] }>()
const emit = defineEmits<{ open: [recommendation: AgentRecommendation] }>()

const unavailableId = ref('')

function open(recommendation: AgentRecommendation) {
  if (!recommendation.available) {
    unavailableId.value = recommendation.id
    return
  }
  unavailableId.value = ''
  emit('open', recommendation)
}
</script>

<template>
  <section v-if="recommendations.length" class="agent-recommendations" aria-labelledby="agent-recommendations-title" data-testid="agent-recommendations">
    <h3 id="agent-recommendations-title" class="agent-recommendations__title">
      <el-icon aria-hidden="true"><User /></el-icon>推荐的 AI 同事
    </h3>
    <div class="agent-recommendations__grid">
      <article
        v-for="recommendation in recommendations"
        :key="recommendation.id"
        class="agent-recommendation"
        :aria-label="`推荐的 AI 同事：${recommendation.name}`"
      >
        <div class="agent-recommendation__head">
          <span class="agent-recommendation__avatar" aria-hidden="true">{{ recommendation.name.slice(0, 1) }}</span>
          <span class="agent-recommendation__identity">
            <strong>{{ recommendation.name }}</strong>
            <small>AI 同事</small>
          </span>
        </div>
        <p v-if="recommendation.description" class="agent-recommendation__description">{{ recommendation.description }}</p>
        <p class="agent-recommendation__reason"><span>推荐理由：</span>{{ recommendation.reason }}</p>
        <p v-if="unavailableId === recommendation.id" class="agent-recommendation__unavailable" role="status">
          该 AI 同事暂不可用：你已没有使用权限，或它已停用。
        </p>
        <el-button
          class="agent-recommendation__open"
          type="primary"
          :aria-label="`去和${recommendation.name}聊天`"
          @click="open(recommendation)"
        >
          去聊天<el-icon class="el-icon--right" aria-hidden="true"><Right /></el-icon>
        </el-button>
      </article>
    </div>
    <p class="agent-recommendations__hint">只列出你可以使用的 AI 同事；点击后开始新的对话，原对话记录与附件不会带入。</p>
  </section>
</template>

<style scoped>
.agent-recommendations { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.agent-recommendations__title { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--dsh-color-text); font-size: var(--dsh-font-size-caption); font-weight: 600; }
.agent-recommendations__title .el-icon { color: var(--dsh-color-brand); }
.agent-recommendations__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.agent-recommendation { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-md); background: var(--dsh-color-panel); }
.agent-recommendation__head { display: flex; align-items: center; gap: 10px; }
.agent-recommendation__avatar { display: inline-flex; flex: 0 0 36px; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; background: var(--dsh-color-brand-soft); color: var(--dsh-color-brand-dark); font-weight: 700; }
.agent-recommendation__identity { display: flex; flex-direction: column; min-width: 0; }
.agent-recommendation__identity strong { color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); overflow-wrap: anywhere; }
.agent-recommendation__identity small { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.agent-recommendation__description { margin: 0; color: var(--dsh-color-text); font-size: var(--dsh-font-size-caption); line-height: 1.6; }
.agent-recommendation__reason { margin: 0; padding: 8px 10px; border-radius: var(--dsh-radius-sm); background: var(--dsh-color-canvas); color: var(--dsh-color-text); font-size: var(--dsh-font-size-caption); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-recommendation__reason span { color: var(--dsh-color-muted); }
.agent-recommendation__unavailable { margin: 0; padding: 8px 10px; border-radius: var(--dsh-radius-sm); background: var(--dsh-color-warning-soft); color: var(--dsh-color-warning); font-size: var(--dsh-font-size-badge); }
.agent-recommendation__open { align-self: flex-start; min-height: 40px; }
.agent-recommendations__hint { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
</style>
