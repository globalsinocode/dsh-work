import { useRouter } from 'vue-router'

import { useUiModeStore } from '@/stores/ui-mode'
import type { AgentRecommendation } from '@/types/domain'
import { recommendationPrefillState } from '@/utils/recommendation-prefill'

/**
 * 按当前模式直接进入与某位 AI 同事的新对话：A 为新对话页并选中该同事，B 为与该同事的单聊。
 * 不经模式重定向，以免历史状态在重定向中丢失。问题经历史状态预填，不进入地址栏；为空时明确不预填，
 * 也不用同事的示例问题补位。
 */
export function useOpenAgentChat() {
  const router = useRouter()
  const uiMode = useUiModeStore()
  return (agentId: string, prompt = '') => {
    const state = recommendationPrefillState(prompt)
    return uiMode.mode === 'collab'
      ? router.push({ name: 'collab-agent-chat', params: { agentId }, state })
      : router.push({ path: '/workbench', query: { agent: agentId }, state })
  }
}

/** 推荐卡片“去聊天”（推荐方案 4.3）：进入与被推荐同事的新对话，预填推荐的问题。 */
export function useOpenRecommendedAgent() {
  const openAgentChat = useOpenAgentChat()
  return (recommendation: AgentRecommendation, prompt: string) => openAgentChat(recommendation.agentId, prompt)
}
