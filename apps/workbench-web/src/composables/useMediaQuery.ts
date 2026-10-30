import { onBeforeUnmount, ref } from 'vue'

/** 媒体查询是否匹配，随窗口变化更新；没有 matchMedia 的环境（如单测）按 `fallback`。 */
export function useMediaQuery(query: string, fallback = false) {
  const list = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
  const matches = ref(list?.matches ?? fallback)
  function onChange(event: MediaQueryListEvent) {
    matches.value = event.matches
  }
  list?.addEventListener?.('change', onChange)
  onBeforeUnmount(() => list?.removeEventListener?.('change', onChange))
  return matches
}
