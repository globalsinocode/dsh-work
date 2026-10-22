import { describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError } from '../api/client'
import { createAuthorizationChangeHandler } from './authorization-change'

describe('workbench authorization change handler', () => {
  it('coalesces refresh notification', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const handler = createAuthorizationChangeHandler(refresh)
    await Promise.all([
      handler(new WorkbenchApiError({ code: 'data_scope_revoked' }, 403, 'denied')),
      handler(new WorkbenchApiError({ code: 'data_scope_revoked' }, 403, 'denied')),
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
