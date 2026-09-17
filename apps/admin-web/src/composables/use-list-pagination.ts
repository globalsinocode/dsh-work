import { computed, ref, watch, type Ref, type WatchSource } from 'vue'

export function useListPagination<T>(
  source: Ref<readonly T[]>,
  options: { pageSize?: number; resetOn?: WatchSource | WatchSource[] } = {},
) {
  const pageSize = options.pageSize ?? 10
  const currentPage = ref(1)
  const pageCount = computed(() => Math.max(1, Math.ceil(source.value.length / pageSize)))
  const pagedItems = computed(() =>
    source.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize),
  )
  watch(source, () => {
    if (currentPage.value > pageCount.value) currentPage.value = pageCount.value
  })
  if (options.resetOn) {
    watch(options.resetOn, () => { currentPage.value = 1 })
  }
  return { currentPage, pageSize, pageCount, pagedItems }
}
