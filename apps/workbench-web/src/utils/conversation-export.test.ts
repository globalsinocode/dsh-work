import { describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { exportConversation } from './conversation-export'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    downloadSessionExport: vi.fn(async () => ({ blob: new Blob(['full']), filename: '发布讨论-完整会话.txt' })),
    downloadRunExport: vi.fn(),
  },
}))

vi.mock('@/utils/download-file', () => ({
  triggerBlobDownload: vi.fn(),
}))

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn() },
}))

describe('conversation-export', () => {
  it('downloads full Session from the server instead of TaskRun.messages', async () => {
    vi.mocked(workbenchApi.downloadSessionExport).mockResolvedValue({ blob: new Blob(['full']), filename: '发布讨论-完整会话.txt' })
    await exportConversation({ scope: 'session', sessionId: 's1', title: '发布讨论' })
    expect(workbenchApi.downloadSessionExport).toHaveBeenCalledWith('s1')
  })
})
