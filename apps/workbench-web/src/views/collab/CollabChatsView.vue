<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import CollabAgentChat from '@/components/collab/CollabAgentChat.vue'
import CollabGroupPage from '@/components/collab/CollabGroupPage.vue'
import CollabTargetList from '@/components/collab/CollabTargetList.vue'
import { workbenchApi } from '@/api/client'
import { useCollabConversationStore } from '@/stores/collab-conversations'
import { useContentStore } from '@/stores/content'

/**
 * 协作模式对话页（S5c～S5e，D24～D29）：左栏统一对话列表，右栏为选中的单聊或群组。窄屏为
 * “列表 → 聊天”两级。打开中的对话对象在页面可见时标记已读；列表在页面重新可见时及每分钟
 * 刷新一次预览与未读（不新增推送通道，12.6）。
 */
const route = useRoute()
const router = useRouter()
const conversations = useCollabConversationStore()
const contentStore = useContentStore()

const agentId = computed(() => route.name === 'collab-agent-chat' ? String(route.params.agentId ?? '') : '')
const groupId = computed(() => ['collab-group-chat', 'collab-group-conversation', 'collab-group-task', 'collab-group-task-thread'].includes(String(route.name)) ? String(route.params.id ?? '') : '')
const activeKey = computed(() => agentId.value ? `agent:${agentId.value}` : groupId.value ? `group:${groupId.value}` : undefined)
const focusSessionId = computed(() => {
  const value = route.query.session
  return typeof value === 'string' && value ? value : undefined
})

/** 打开了尚无对话的 AI 同事：列表顶部临时显示它，发送第一条消息后成为正式的一行（D25）。 */
const pendingAgent = computed(() => {
  if (!agentId.value || conversations.targets.some(item => item.type === 'agent' && item.id === agentId.value)) return null
  const profile = contentStore.agents.find(item => item.id === agentId.value)
  return profile ? { id: profile.id, name: profile.name, description: profile.description } : null
})

const resolving = ref(false)
const resolveError = ref('')

function openTarget(target: { type: 'agent' | 'group'; id: string }) {
  resolveError.value = ''
  if (target.type === 'agent') void router.push({ name: 'collab-agent-chat', params: { agentId: target.id } })
  else void router.push({ name: 'collab-group-chat', params: { id: target.id } })
}

function startAgent(id: string) {
  void router.push({ name: 'collab-agent-chat', params: { agentId: id } })
}

/** `/c/chats?conversation=:id`：A 的对话链接（通知、复制的链接、旧书签）定位到所属对象。 */
watch(() => route.name === 'collab-chats' ? route.query.conversation : undefined, async (value) => {
  // 解析失败后会回到 /c/chats（不带参数）：此时保留提示，直到打开下一个链接或对话。
  if (typeof value !== 'string' || !value) return
  resolveError.value = ''
  resolving.value = true
  try {
    const location = await workbenchApi.resolveConversation(value)
    if (location.type === 'agent') {
      await router.replace({ name: 'collab-agent-chat', params: { agentId: location.agentId }, query: { session: location.sessionId } })
    } else {
      await router.replace({ name: 'collab-group-chat', params: { id: location.workspaceId }, query: { session: location.sessionId } })
    }
  } catch (cause) {
    resolveError.value = cause instanceof Error && 'status' in cause && cause.status === 404
      ? '对话不存在或你没有访问权限'
      : cause instanceof Error ? cause.message : '无法打开该对话'
    await router.replace({ name: 'collab-chats' })
  } finally {
    resolving.value = false
  }
}, { immediate: true })

/** 打开中的对话对象有未读、且页面可见时标记已读（窄屏只显示列表时没有打开的对象）。 */
const pageVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const activeUnread = computed(() => {
  const key = activeKey.value
  const target = key ? conversations.targets.find(item => `${item.type}:${item.id}` === key) : undefined
  // @ 提醒（D38）同样在打开时清除：只有提醒没有未读数时也要标记。
  return target ? target.unreadCount + (target.mentioned ? 1 : 0) : 0
})
watch([activeKey, activeUnread, pageVisible], ([key, unread, visible]) => {
  if (!key || unread <= 0 || !visible) return
  const [type, ...rest] = key.split(':')
  void conversations.markRead(type as 'agent' | 'group', rest.join(':'))
}, { immediate: true })

const listRefreshMs = 60_000
let listTimer: ReturnType<typeof setInterval> | undefined
function onVisibilityChange() {
  pageVisible.value = document.visibilityState !== 'hidden'
  if (pageVisible.value && conversations.loaded) void conversations.refresh()
}
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  listTimer = setInterval(() => {
    if (pageVisible.value && conversations.loaded) void conversations.refresh()
  }, listRefreshMs)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearInterval(listTimer)
})

if (!contentStore.agents.length) void contentStore.refreshAgents().catch(() => undefined)
</script>

<template>
  <div class="collab-chats" :class="{ 'collab-chats--has-target': Boolean(activeKey) }">
    <CollabTargetList
      class="collab-chats__list"
      :active-key="activeKey"
      :pending-agent="pendingAgent"
      @select="openTarget"
      @start-agent="startAgent"
    />
    <div class="collab-chats__pane">
      <CollabAgentChat
        v-if="agentId"
        :key="agentId"
        :agent-id="agentId"
        :focus-session-id="focusSessionId"
        @back="router.push({ name: 'collab-chats' })"
      />
      <CollabGroupPage
        v-else-if="groupId"
        :workspace-id="groupId"
        @back="router.push({ name: 'collab-chats' })"
      />
      <div v-else class="collab-chats__empty">
        <el-skeleton v-if="resolving" :rows="4" animated />
        <el-alert v-else-if="resolveError" type="warning" :closable="false" :title="resolveError" show-icon />
        <el-empty v-else description="选择一个对话，或点“＋”发起与 AI 同事的对话" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.collab-chats {
  display: grid;
  height: 100vh;
  grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
  background: #fff;
}

.collab-chats__list {
  min-height: 0;
  border-right: 1px solid var(--dsh-color-border);
}

.collab-chats__pane {
  min-width: 0;
  min-height: 0;
}

.collab-chats__empty {
  display: grid;
  height: 100%;
  padding: 24px;
  place-items: center;
}

@media (max-width: 820px) {
  /* 窄屏两级：没有选中对象时只显示列表，选中后只显示聊天（壳层已留出顶栏与底部标签栏）。 */
  .collab-chats {
    height: calc(100vh - 52px - 60px);
    grid-template-columns: minmax(0, 1fr);
  }

  .collab-chats__list { border-right: 0; }
  .collab-chats__pane { display: none; }
  .collab-chats--has-target .collab-chats__list { display: none; }
  .collab-chats--has-target .collab-chats__pane { display: block; }
}
</style>
