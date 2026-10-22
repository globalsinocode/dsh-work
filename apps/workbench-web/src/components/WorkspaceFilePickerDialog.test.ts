import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listWorkspaceFiles = vi.fn()

vi.mock('@/api/client', () => ({
  workbenchApi: { listWorkspaceFiles },
}))

import WorkspaceFilePickerDialog from './WorkspaceFilePickerDialog.vue'

describe('WorkspaceFilePickerDialog', () => {
  beforeEach(() => {
    listWorkspaceFiles.mockReset()
    listWorkspaceFiles.mockResolvedValue({
      items: [{
        id: 'file-row-1',
        logicalFileId: 'lf-1',
        name: '月报.csv',
        canReference: true,
        parseStatus: 'ready',
        versionNo: 1,
        versionCount: 1,
        uploadedAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:00.000Z',
      }],
      nextCursor: null,
    })
  })

  it('loads workspace files when opened and emits a projection on select', async () => {
    const wrapper = mount(WorkspaceFilePickerDialog, {
      props: { workspaceId: 'ws-team', modelValue: true },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(listWorkspaceFiles).toHaveBeenCalledWith('ws-team', { cursor: undefined })
    await wrapper.getByRole('button', { name: '选择 月报.csv' }).click()
    const selected = wrapper.emitted('select')?.[0]?.[0] as { logicalFileId: string; name: string }
    expect(selected.logicalFileId).toBe('lf-1')
    expect(selected.name).toBe('月报.csv')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })
})
