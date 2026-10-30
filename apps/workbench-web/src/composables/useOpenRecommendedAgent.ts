import { useRouter } from 'vue-router'

import { useUiModeStore } from '@/stores/ui-mode'
import type { AgentRecommendation } from '@/types/domain'
import { recommendationPrefillState } from '@/utils/recommendation-prefill'

/**
 * 推荐卡片“去聊天”（推荐方案 4.3）：按当前模式直接进入与该同事的新对话，不经模式重定向，
 * 以免历史状态在重定向中丢失。问题经历史状态预填，不进入地址栏。
 */
export function useOpenRecommendedAgent() {
  const router = useRouter()
  const uiMode = useUiModeStore()
  return (recommendation: AgentRecommendation, prompt: string) => {
    const state = prompt ? recommendationPrefillState(prompt) : {}
    return uiMode.mode === 'collab'
      ? router.push({ name: 'collab-agent-chat', params: { agentId: recommendation.agentId }, state })
      : router.push({ path: '/workbench', query: { agent: recommendation.agentId }, state })
  }
}
