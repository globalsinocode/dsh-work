import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getWorkspaces: vi.fn(),
    getArtifacts: vi.fn(),
    getAgents: vi.fn(),
  },
}))

describe('content store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  it('keeps successful workspaces when artifacts fail', async () => {
    const teamWorkspace = { id: 'ws-1', type: 'team', files: [] } as const
    vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([teamWorkspace] as never)
    vi.mocked(workbenchApi.getArtifacts).mockRejectedValue(new Error('503'))
    vi.mocked(workbenchApi.getAgents).mockResolvedValue([] as never)
    const store = useContentStore()
    await store.refresh()
    expect(store.workspaces).toEqual([teamWorkspace])
    expect(store.workspaceError).toBe('')
    expect(store.artifactsError).toContain('503')
  })
})
