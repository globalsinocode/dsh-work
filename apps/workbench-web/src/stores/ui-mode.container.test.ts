import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUiModeStore } from './ui-mode'

const api = vi.hoisted(() => ({ getPreferences: vi.fn(), updatePreferences: vi.fn() }))
vi.mock('../api/client', () => ({ workbenchApi: api }))

// 钉钉接入方案 DT25：在钉钉容器内一律使用协作模式，不读取、不修改员工保存的模式偏好。
describe('UI mode inside the DingTalk container', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) AliApp(DingTalk/7.6.0) DingTalk(7.6.0)' })
    setActivePinia(createPinia())
    api.getPreferences.mockReset()
    api.updatePreferences.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('always uses collaboration mode without reading or saving the preference', async () => {
    api.getPreferences.mockResolvedValue({ uiMode: 'work', updatedAt: null })
    const store = useUiModeStore()
    expect(store.containerLocked).toBe(true)
    await store.ensureLoaded('U1')
    expect(store.mode).toBe('collab')
    expect(api.getPreferences).not.toHaveBeenCalled()
    expect(await store.setMode('work')).toBe(false)
    expect(store.mode).toBe('collab')
    expect(api.updatePreferences).not.toHaveBeenCalled()
  })

  it('keeps the saved preference outside the container', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130' })
    setActivePinia(createPinia())
    expect(useUiModeStore().containerLocked).toBe(false)
  })
})
