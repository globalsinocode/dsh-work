import { ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { ConversationTarget } from '../types/domain'

/**
 * 协作模式对话列表（S5c，D24）：本人的单聊（按 AI 同事聚合）与群组，按最近活动排序、服务端
 * 分页与搜索。聊天区发送消息或执行结束后调用 `refresh` 更新预览与排序；迟到的旧请求不覆盖新结果。
 * 未读（S5e）：服务端按本人已读位置计数；打开的对话对象经 `markRead` 前进已读位置。
 */
export const useCollabConversationStore = defineStore('workbench-collab-conversations', () => {
  const targets = ref<ConversationTarget[]>([])
  const nextCursor = ref<string | null>(null)
  const query = ref('')
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  const loaded = ref(false)
  let generation = 0

  async function load(nextQuery = query.value) {
    const current = ++generation
    query.value = nextQuery
    loading.value = true
    error.value = ''
    try {
      const page = await workbenchApi.listConversationTargets({ query: nextQuery.trim() || undefined })
      if (current !== generation) return
      targets.value = page.items
      nextCursor.value = page.nextCursor
      loaded.value = true
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '对话列表加载失败'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value) return
    const current = generation
    loadingMore.value = true
    try {
      const page = await workbenchApi.listConversationTargets({ query: query.value.trim() || undefined, cursor: nextCursor.value })
      if (current !== generation) return
      const known = new Set(targets.value.map(item => `${item.type}:${item.id}`))
      targets.value = [...targets.value, ...page.items.filter(item => !known.has(`${item.type}:${item.id}`))]
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause.message : '对话列表加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  /** 重新取第一页（保持当前搜索）：发送消息、执行结束后调用。 */
  function refresh() {
    return load(query.value)
  }

  /**
   * 打开的对话对象有未读时标记已读：只读到列表中最后一条消息的时间，之后到达的消息在下次
   * 刷新时仍算未读（再由打开中的页面标记）。本地先清零，失败时由下次刷新纠正。
   */
  async function markRead(type: ConversationTarget['type'], id: string) {
    const target = targets.value.find(item => item.type === type && item.id === id)
    if (!target || target.unreadCount <= 0) return
    target.unreadCount = 0
    try {
      await workbenchApi.markConversationTargetRead(type, id, target.lastMessage?.sentAt)
    } catch {
      // 已读位置写入失败不打扰用户：下次刷新会重新显示未读并再次尝试。
    }
  }

  function reset() {
    generation++
    targets.value = []
    nextCursor.value = null
    query.value = ''
    loading.value = false
    loadingMore.value = false
    error.value = ''
    loaded.value = false
  }

  return { targets, nextCursor, query, loading, loadingMore, error, loaded, load, loadMore, refresh, markRead, reset }
})
