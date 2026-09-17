import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'

import { useListPagination } from './use-list-pagination'

describe('useListPagination', () => {
  it('slices the source into pages and follows currentPage', () => {
    const items = ref(range(25))
    const { currentPage, pageCount, pagedItems } = useListPagination(items)

    expect(pageCount.value).toBe(3)
    expect(pagedItems.value).toEqual(range(10))

    currentPage.value = 2
    expect(pagedItems.value).toEqual(range(10, 10))

    currentPage.value = 3
    expect(pagedItems.value).toEqual(range(5, 20))
  })

  it('resets to page 1 when a watched filter changes', async () => {
    const items = ref(range(25))
    const filter = ref('')
    const { currentPage, pagedItems } = useListPagination(items, { resetOn: filter })

    currentPage.value = 3
    filter.value = 'keyword'
    await Promise.resolve()

    expect(currentPage.value).toBe(1)
    expect(pagedItems.value).toEqual(range(10))
  })

  it('clamps currentPage when the filtered result shrinks', async () => {
    const items = ref(range(25))
    const { currentPage, pageCount, pagedItems } = useListPagination(items)

    currentPage.value = 3
    items.value = range(12)
    await Promise.resolve()

    expect(pageCount.value).toBe(2)
    expect(currentPage.value).toBe(2)
    expect(pagedItems.value).toEqual(range(2, 10))
  })

  it('supports a custom page size', () => {
    const items = ref(range(30))
    const { pageSize, pageCount, pagedItems } = useListPagination(items, { pageSize: 20 })

    expect(pageSize).toBe(20)
    expect(pageCount.value).toBe(2)
    expect(pagedItems.value).toHaveLength(20)
  })

  it('keeps a single page for empty or small lists', () => {
    const items = ref<number[]>([])
    const { pageCount, pagedItems } = useListPagination(computed(() => items.value))

    expect(pageCount.value).toBe(1)
    expect(pagedItems.value).toEqual([])
  })
})

function range(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => i + offset)
}
