<script setup lang="ts">
import { StatusTag } from '@dsh-work/ui-core'

import ConversationMessageItem from './ConversationMessageItem.vue'
import { useAuthStore } from '@/stores/auth'
import type { SessionThread, SessionThreadMessage } from '@/types/domain'
import { mentionsUser } from '@/utils/mentions'
import '@/styles/conversation-thread.css'

/**
 * 共享讨论线程（S5b 从 ConversationView 拆出）：讨论消息与本讨论的执行记录入口。
 * A 的空间内讨论与 B 的群聊共用；点击执行记录只发事件，由调用方导航到执行详情。
 */
const props = defineProps<{
  thread: SessionThread
  isOwn: (message: SessionThreadMessage) => boolean
}>()

const authStore = useAuthStore()

/** D38：他人 @ 本人的发言在身份行标“@了你”。 */
function mentionTag(message: SessionThreadMessage) {
  return !props.isOwn(message) && mentionsUser(message, authStore.user.id) ? '@了你' : undefined
}

const emit = defineEmits<{ 'open-run': [runId: string] }>()

function formatSessionRunTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <p v-if="!thread.messages.length" class="thread-empty">
    还没有讨论内容。直接发送即发表全员可见的讨论消息；@ Agent 成员则发起一次执行。
  </p>
  <ConversationMessageItem
    v-for="message in thread.messages"
    :key="message.id"
    :message="message"
    :own="isOwn(message)"
    :tag="mentionTag(message)"
  />
  <section
    v-if="thread.runs.length"
    class="session-run-list"
    aria-label="本讨论的执行记录"
  >
    <button
      v-for="run in thread.runs"
      :key="run.runId"
      type="button"
      class="session-run"
      data-testid="session-run"
      @click="emit('open-run', run.runId)"
    >
      <StatusTag :status="run.status" dot />
      <span class="session-run__requester">
        {{ run.requesterName }} 发起<template v-if="run.stoppedByName"> · {{ run.stoppedByName }} 停止</template>
      </span>
      <time>{{ formatSessionRunTime(run.createdAt) }}</time>
    </button>
  </section>
</template>
