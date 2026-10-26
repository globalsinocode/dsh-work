<script setup lang="ts">
import { computed } from 'vue'
import { AssistantMessageContent } from '@dsh-work/ui-core'

import '@/styles/conversation-thread.css'

/** 消息展示所需的字段：Run 消息（ChatMessage）与共享线程消息（SessionThreadMessage）都满足。 */
export interface ConversationMessageView {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  senderName?: string | null
  agentName?: string | null
  runRequesterName?: string | null
}

/**
 * 一条对话消息（S5b 从 ConversationView 拆出）：人员消息与 Agent 回复共用「身份行 + 卡片」，
 * 本人消息镜像到右侧。A 的对话详情、任务对话与 B 的对话页共用。
 */
const props = withDefaults(defineProps<{
  message: ConversationMessageView
  /** 本人发送的消息（右侧）；由调用方按发送者与会话类型判定。 */
  own?: boolean
  /** 替换身份行下方的时间说明（例如本轮回复的业务结论与耗时）。 */
  meta?: string
  /** 身份行右侧的标签（任务对话中的“补充要求”等）。 */
  tag?: string
  /** Agent 回复是否显示“由某人发起”。 */
  showRequester?: boolean
}>(), { own: false, meta: undefined, tag: undefined, showRequester: true })

const isUser = computed(() => props.message.role === 'user')
const name = computed(() => isUser.value ? props.message.senderName ?? '我' : props.message.agentName ?? 'dsh-work')
</script>

<template>
  <article
    class="conversation-message"
    :class="[`conversation-message--${message.role}`, { 'conversation-message--own': own }]"
  >
    <div class="assistant-identity">
      <span class="assistant-avatar" :class="{ 'assistant-avatar--user': isUser }">{{ name.slice(0, 1) }}</span>
      <div>
        <strong>{{ name }}</strong>
        <span v-if="meta !== undefined">{{ meta }}</span>
        <span v-else>
          {{ message.createdAt }}
          <template v-if="!isUser && showRequester && message.runRequesterName"> · 由 {{ message.runRequesterName }} 发起</template>
        </span>
      </div>
      <span v-if="tag" class="task-conversation-tag" data-testid="task-conversation-tag">{{ tag }}</span>
    </div>
    <div v-if="isUser" class="assistant-answer user-message">
      <p>{{ message.content }}</p>
    </div>
    <div v-else class="assistant-answer">
      <AssistantMessageContent :text="message.content" />
      <slot />
    </div>
  </article>
</template>
