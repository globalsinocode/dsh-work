import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { KnowledgeLevel } from '../types/knowledge'

/**
 * 企业知识库的可用性与本人权限级别（weknora-knowledge-plan 第 8 节）。未配置 WeKnora、AI Hub 账号或
 * 不具备查看级别时 enabled 为 false：主导航不显示“知识库”，输入框不显示“添加知识库”。读取失败按
 * 不可用处理，不影响其他页面。
 */
export const useKnowledgeStore = defineStore('workbench-knowledge', () => {
  const enabled = ref(false)
  const level = ref<KnowledgeLevel>('none')
  const loaded = ref(false)
  let pending: Promise<void> | null = null

  async function refresh() {
    try {
      const status = await workbenchApi.getKnowledgeStatus()
      enabled.value = status.enabled
      level.value = status.level
    } catch {
      enabled.value = false
      level.value = 'none'
    } finally {
      loaded.value = true
    }
  }

  function ensureLoaded() {
    if (loaded.value) return Promise.resolve()
    pending ??= refresh().finally(() => { pending = null })
    return pending
  }

  const canCreate = computed(() => enabled.value && level.value === 'bases')

  return { enabled, level, loaded, canCreate, refresh, ensureLoaded }
})
