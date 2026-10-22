import { describe, expect, it, vi } from 'vitest'

import { AdminApiError } from '../api/client'
import { createAuthorizationChangeHandler } from './authorization-change'

describe('authorization change handler', () => {
  it('coalesces refresh notification and never invokes the failed request again', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const replay = vi.fn()
    const handler = createAuthorizationChangeHandler(refresh)
    await Promise.all([
      handler(new AdminApiError({ code: 'authorization_denied' }, 403, 'denied')),
      handler(new AdminApiError({ code: 'authorization_denied' }, 403, 'denied')),
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(replay).not.toHaveBeenCalled()
  })
})
