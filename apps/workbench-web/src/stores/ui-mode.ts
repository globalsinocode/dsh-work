import { ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { UiMode } from '../types/domain'

const cachePrefix = 'dsh-work:ui-mode:'

/**
 * 员工端界面模式（项目空间方案 D18、D19）。
 *
 * 服务端偏好为准，跨设备一致；浏览器按账号缓存一份，只用于首屏直接渲染正确的壳层。
 * 有缓存时先用缓存、后台向服务端核对；本设备从未缓存时等待服务端（读取失败按缺省的
 * 工作模式）。切换等服务端保存成功后才生效，失败时保持原模式。
 */
export const useUiModeStore = defineStore('workbench-ui-mode', () => {
  const mode = ref<UiMode>('work')
  const switching = ref(false)
  let userId: string | undefined
  // 本设备没有缓存时，首个导航等待服务端偏好，避免先渲染错误的壳层再跳转。
  let blockingLoad: Promise<void> | undefined
  // 每次本地确定模式（切换或换账号）都递增；迟到的服务端读取不得覆盖较新的结果。
  let revision = 0

  async function ensureLoaded(nextUserId: string) {
    if (userId === nextUserId) return blockingLoad
    userId = nextUserId
    const current = ++revision
    const cached = readCache(nextUserId)
    mode.value = cached ?? 'work'
    const load = refresh(nextUserId, current)
    if (cached) return
    blockingLoad = load.finally(() => {
      if (current === revision) blockingLoad = undefined
    })
    return blockingLoad
  }

  async function refresh(forUserId: string, current: number) {
    try {
      const preferences = await workbenchApi.getPreferences()
      if (current !== revision || forUserId !== userId) return
      mode.value = preferences.uiMode
      writeCache(forUserId, preferences.uiMode)
    } catch {
      // 偏好读取失败不阻断工作台：保留缓存或缺省的工作模式，下次进入时再核对。
    }
  }

  /** 保存为本人偏好；成功返回 true。界面与地址由壳层随 `mode` 变化切换。 */
  async function setMode(next: UiMode) {
    if (next === mode.value || switching.value) return next === mode.value
    switching.value = true
    const forUserId = userId
    try {
      const saved = await workbenchApi.updatePreferences({ uiMode: next })
      if (forUserId !== userId) return false
      revision++
      mode.value = saved.uiMode
      if (forUserId) writeCache(forUserId, saved.uiMode)
      return true
    } finally {
      switching.value = false
    }
  }

  return { mode, switching, ensureLoaded, setMode }
})

function readCache(userId: string): UiMode | undefined {
  try {
    const value = window.localStorage.getItem(`${cachePrefix}${userId}`)
    return value === 'work' || value === 'collab' ? value : undefined
  } catch {
    return undefined
  }
}

function writeCache(userId: string, value: UiMode) {
  try {
    window.localStorage.setItem(`${cachePrefix}${userId}`, value)
  } catch {
    // 无法写本地缓存（隐私模式等）时只影响首屏，服务端偏好仍然生效。
  }
}
