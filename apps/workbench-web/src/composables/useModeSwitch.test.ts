import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useUiModeStore } from '@/stores/ui-mode'
import { useModeSwitch } from './useModeSwitch'

vi.mock('@/api/client', () => ({
  workbenchApi: { getPreferences: vi.fn(), updatePreferences: vi.fn() },
}))
const feedback = vi.hoisted(() => ({ notifyActionFailure: vi.fn() }))
vi.mock('@/utils/feedback', () => feedback)

function setup() {
  setActivePinia(createPinia())
  const uiMode = useUiModeStore()
  const { switchLabel, switchMode } = useModeSwitch()
  return { uiMode, switchLabel, switchMode }
}

describe('useModeSwitch', () => {
  beforeEach(() => {
    feedback.notifyActionFailure.mockReset()
  })

  it('offers the other mode as target: work → 协作, collab → 工作', () => {
    const { uiMode, switchLabel } = setup()
    expect(switchLabel.value).toBe('切换至协作模式')
    uiMode.mode = 'collab'
    expect(switchLabel.value).toBe('切换至工作模式')
  })

  it('switches to the other mode and persists the preference', async () => {
    const { uiMode, switchMode } = setup()
    vi.mocked(workbenchApi.updatePreferences).mockResolvedValue({ uiMode: 'collab' } as never)

    await switchMode()

    expect(workbenchApi.updatePreferences).toHaveBeenCalledWith({ uiMode: 'collab' })
    expect(uiMode.mode).toBe('collab')
  })

  it('keeps the current mode and reports failure when saving fails', async () => {
    const { uiMode, switchMode } = setup()
    vi.mocked(workbenchApi.updatePreferences).mockRejectedValue(new Error('网络异常'))

    await switchMode()

    expect(uiMode.mode).toBe('work')
    expect(feedback.notifyActionFailure).toHaveBeenCalledWith('切换模式', '协作模式', expect.any(Error), expect.any(String))
  })
})
