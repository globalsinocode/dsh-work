import { ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { ConversationTarget } from '../types/domain'

/**
 * 协作模式对话列表（S5c，D24）：本人的单聊（按 AI 同事聚合）与群组，按最近活动排序、服务端
 * 分页与搜索。聊天区发送消息或执行结束后调用 `refresh` 更新预览与排序；迟到的旧请求不覆盖新结果。
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

  return { targets, nextCursor, query, loading, loadingMore, error, loaded, load, loadMore, refresh, reset }
})
