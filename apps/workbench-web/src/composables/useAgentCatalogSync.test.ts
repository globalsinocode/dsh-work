import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentCatalogSync } from './useAgentCatalogSync'

function mountSync(refresh: () => Promise<unknown>, intervalMs?: number) {
  return mount(defineComponent({
    setup() {
      useAgentCatalogSync(refresh, intervalMs)
      return () => h('div')
    },
  }))
}

describe('useAgentCatalogSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rechecks the catalog on an interval while the page stays open', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const wrapper = mountSync(refresh, 60_000)
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)

    wrapper.unmount()
  })

  it('pauses while the tab is hidden and rechecks when it becomes visible again', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const wrapper = mountSync(refresh, 60_000)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(refresh).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('does not keep refreshing after unmount', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const wrapper = mountSync(refresh, 60_000)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(refresh).not.toHaveBeenCalled()
  })
})
