import { describe, expect, it, vi } from 'vitest'

import type { ListPage } from '@/types/domain'

import { usePagedList } from './use-paged-list'

function page<T>(items: T[], page: number, total = items.length): ListPage<T> {
  return { items, total, page, pageSize: 10 }
}

describe('usePagedList', () => {
  it('loads the requested page and exposes items/total', async () => {
    const fetch = vi.fn().mockResolvedValue(page(['a', 'b'], 1, 25))
    const list = usePagedList<string>({ fetch })

    await list.reload()

    expect(fetch).toHaveBeenCalledWith(1, 10)
    expect(list.items.value).toEqual(['a', 'b'])
    expect(list.total.value).toBe(25)
    expect(list.currentPage.value).toBe(1)
    expect(list.loading.value).toBe(false)
    expect(list.error.value).toBe('')
  })

  it('changePage fetches the target page', async () => {
    const fetch = vi.fn().mockResolvedValue(page(['x'], 3, 25))
    const list = usePagedList<string>({ fetch })

    list.changePage(3)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(3, 10))
    expect(list.currentPage.value).toBe(3)
    expect(list.items.value).toEqual(['x'])
  })

  it('reload(true) resets to page 1', async () => {
    const fetch = vi.fn().mockResolvedValue(page(['x'], 1, 25))
    const list = usePagedList<string>({ fetch })
    list.currentPage.value = 4

    await list.reload(true)

    expect(fetch).toHaveBeenLastCalledWith(1, 10)
    expect(list.currentPage.value).toBe(1)
  })

  it('captures fetch errors into error ref', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('列表加载失败'))
    const list = usePagedList<string>({ fetch })

    await list.reload()

    expect(list.error.value).toBe('列表加载失败')
    expect(list.loading.value).toBe(false)
  })
})
