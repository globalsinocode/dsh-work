import { ref, shallowRef } from 'vue'

import type { ListPage } from '@/types/domain'

interface PagedListOptions<T, R extends ListPage<T>> {
  pageSize?: number
  fetch: (page: number, pageSize: number) => Promise<R>
}

export function usePagedList<T, R extends ListPage<T> = ListPage<T>>(options: PagedListOptions<T, R>) {
  const pageSize = options.pageSize ?? 10
  const items = shallowRef<T[]>([]) as { value: T[] }
  const total = ref(0)
  const currentPage = ref(1)
  const loading = ref(false)
  const error = ref('')
  const result = shallowRef<R>()

  async function reload(resetPage = false): Promise<R | undefined> {
    if (resetPage) currentPage.value = 1
    loading.value = true
    error.value = ''
    try {
      const response = await options.fetch(currentPage.value, pageSize)
      result.value = response
      items.value = response.items
      total.value = response.total
      currentPage.value = response.page
      return response
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '列表加载失败，请稍后重试'
      return undefined
    } finally {
      loading.value = false
    }
  }

  function changePage(page: number) {
    currentPage.value = page
    void reload()
  }

  return { items, total, currentPage, pageSize, loading, error, result, reload, changePage }
}
