import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserPreferences } from '../types/domain'
import { useUiModeStore } from './ui-mode'

const api = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

vi.mock('../api/client', () => ({ workbenchApi: api }))

function preferences(uiMode: UserPreferences['uiMode']): UserPreferences {
  return { uiMode, updatedAt: uiMode === 'work' ? null : '2026-10-22T08:00:00.000Z' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('workbench UI mode store (D18, D19)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    api.getPreferences.mockReset()
    api.updatePreferences.mockReset()
  })

  it('defaults to work mode when the user never switched', async () => {
    api.getPreferences.mockResolvedValue(preferences('work'))
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    expect(store.mode).toBe('work')
  })

  it('waits for the server on a device without a cached mode', async () => {
    const response = deferred<UserPreferences>()
    api.getPreferences.mockReturnValue(response.promise)
    const store = useUiModeStore()
    let settled = false
    const loading = store.ensureLoaded('U1').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    response.resolve(preferences('collab'))
    await loading
    expect(store.mode).toBe('collab')
    expect(window.localStorage.getItem('dsh-work:ui-mode:U1')).toBe('collab')
  })

  it('renders from the per-account cache first and lets the server decide', async () => {
    window.localStorage.setItem('dsh-work:ui-mode:U1', 'collab')
    const response = deferred<UserPreferences>()
    api.getPreferences.mockReturnValue(response.promise)
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    expect(store.mode).toBe('collab')
    response.resolve(preferences('work'))
    await vi.waitFor(() => expect(store.mode).toBe('work'))
    expect(window.localStorage.getItem('dsh-work:ui-mode:U1')).toBe('work')
  })

  it('keeps the cached or default mode when the preference cannot be read', async () => {
    api.getPreferences.mockRejectedValue(new Error('offline'))
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    expect(store.mode).toBe('work')
  })

  it('does not reuse another account cache', async () => {
    window.localStorage.setItem('dsh-work:ui-mode:U1', 'collab')
    api.getPreferences.mockResolvedValue(preferences('work'))
    const store = useUiModeStore()
    await store.ensureLoaded('U2')
    expect(store.mode).toBe('work')
  })

  it('switches only after the server saved the preference', async () => {
    api.getPreferences.mockResolvedValue(preferences('work'))
    const save = deferred<UserPreferences>()
    api.updatePreferences.mockReturnValue(save.promise)
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    const switching = store.setMode('collab')
    expect(store.mode).toBe('work')
    expect(store.switching).toBe(true)
    save.resolve(preferences('collab'))
    await expect(switching).resolves.toBe(true)
    expect(api.updatePreferences).toHaveBeenCalledWith({ uiMode: 'collab' })
    expect(store.mode).toBe('collab')
    expect(window.localStorage.getItem('dsh-work:ui-mode:U1')).toBe('collab')
  })

  it('stays in the current mode when saving fails', async () => {
    api.getPreferences.mockResolvedValue(preferences('work'))
    api.updatePreferences.mockRejectedValue(new Error('保存失败'))
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    await expect(store.setMode('collab')).rejects.toThrow('保存失败')
    expect(store.mode).toBe('work')
    expect(store.switching).toBe(false)
    expect(window.localStorage.getItem('dsh-work:ui-mode:U1')).toBe('work')
  })

  it('ignores a late server read after the user switched', async () => {
    window.localStorage.setItem('dsh-work:ui-mode:U1', 'work')
    const read = deferred<UserPreferences>()
    api.getPreferences.mockReturnValue(read.promise)
    api.updatePreferences.mockResolvedValue(preferences('collab'))
    const store = useUiModeStore()
    await store.ensureLoaded('U1')
    await store.setMode('collab')
    read.resolve(preferences('work'))
    await read.promise
    await Promise.resolve()
    expect(store.mode).toBe('collab')
  })
})
