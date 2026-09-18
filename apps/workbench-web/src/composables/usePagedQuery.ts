import { onBeforeUnmount, ref, shallowRef, watch, type WatchSource } from 'vue'

/** Shared request lifecycle for personal history/files. Sources include identity;
 * a changed source invalidates both first-page and load-more replies. */
export function usePagedQuery<T>(source: WatchSource<unknown>, fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>) {
  const items = shallowRef<T[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const error = ref('')
  let generation = 0
  async function reload() {
    const current = ++generation
    items.value = []; nextCursor.value = null; error.value = ''; loading.value = true
    try {
      const page = await fetchPage()
      if (current !== generation) return
      items.value = page.items; nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause.message : '加载失败'
    } finally { if (current === generation) loading.value = false }
  }
  async function loadMore() {
    if (loading.value || !nextCursor.value) return
    const current = generation
    loading.value = true; error.value = ''
    try {
      const page = await fetchPage(nextCursor.value)
      if (current !== generation) return
      items.value = [...items.value, ...page.items]; nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '加载失败'
      const status = (cause as { status?: number })?.status
      if (status === 401 || status === 403) { items.value = []; nextCursor.value = null }
    } finally { if (current === generation) loading.value = false }
  }
  watch(source, () => { void reload() }, { immediate: true })
  onBeforeUnmount(() => { generation++ })
  return { items, nextCursor, loading, error, reload, loadMore }
}
