import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { ProjectArchiveVersion } from '@/types/domain'
import ProjectArchivePanel from './ProjectArchivePanel.vue'

function version(overrides: Partial<ProjectArchiveVersion> = {}): ProjectArchiveVersion {
  return {
    versionId: 'warch-3',
    versionNo: 3,
    items: ['缺货集中在高周转类目', '术语：安全库存'],
    sourceKind: 'archivist',
    sourceTasks: [{ id: 'ptask-1', title: '分析缺货原因' }],
    rollbackFromVersionNo: null,
    createdBy: null,
    createdAt: '2026-10-17T06:20:00.000Z',
    ...overrides,
  }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ProjectArchivePanel, {
    props: { workspaceId: 'ws-team', workspaceName: '供应链项目', canWrite: true, ...props },
    global: { plugins: [ElementPlus] },
  })
}

function buttonByText(wrapper: ReturnType<typeof mountPanel>, text: string) {
  return wrapper.findAll('button').filter(button => button.text() === text)
}

describe('ProjectArchivePanel（项目空间 S2）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(workbenchApi, 'getProjectArchive').mockResolvedValue({ current: version(), archivistRunning: false })
  })

  it('lists items with the version source and reports the count', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.findAll('[data-testid="project-archive-item"]').map(item => item.text())).toEqual([
      expect.stringContaining('缺货集中在高周转类目'),
      expect.stringContaining('术语：安全库存'),
    ])
    const meta = wrapper.get('[data-testid="project-archive-meta"]').text()
    expect(meta).toContain('第 3 版')
    expect(meta).toContain('项目档案员')
    expect(meta).toContain('依据任务「分析缺货原因」的成果')
    expect(meta).not.toContain('档案员整理中')
    expect(wrapper.emitted('count')?.at(-1)).toEqual([2])
  })

  it('shows the running tag and an empty state without write entries for read-only members', async () => {
    vi.mocked(workbenchApi.getProjectArchive).mockResolvedValue({ current: null, archivistRunning: true })
    const empty = mountPanel({ canWrite: false })
    await flushPromises()
    expect(empty.text()).toContain('还没有档案条目')
    expect(empty.find('[data-testid="project-archive-add"]').exists()).toBe(false)
    expect(empty.find('[data-testid="project-archive-history"]').exists()).toBe(false)

    vi.mocked(workbenchApi.getProjectArchive).mockResolvedValue({ current: version(), archivistRunning: true })
    const reader = mountPanel({ canWrite: false })
    await flushPromises()
    expect(reader.get('[data-testid="project-archive-meta"]').text()).toContain('档案员整理中')
    expect(buttonByText(reader, '编辑')).toHaveLength(0)
    expect(buttonByText(reader, '删除')).toHaveLength(0)
    expect(reader.find('[data-testid="project-archive-add"]').exists()).toBe(false)
  })

  it('edits an item in place against the current version and keeps the draft when saving fails', async () => {
    const save = vi.spyOn(workbenchApi, 'saveProjectArchive')
      .mockRejectedValueOnce(new Error('档案已被更新，请刷新后再修改'))
      .mockResolvedValueOnce(version({
        versionId: 'warch-4', versionNo: 4, sourceKind: 'manual', sourceTasks: [],
        items: ['缺货集中在高周转 SKU 类目', '术语：安全库存'], createdBy: { userId: 'u-1', displayName: '林岚' },
      }))
    const wrapper = mountPanel()
    await flushPromises()
    await buttonByText(wrapper, '编辑')[0]!.trigger('click')
    const input = wrapper.get('textarea[aria-label="修改第 1 条"]')
    await input.setValue('  缺货集中在高周转 SKU 类目  ')

    await buttonByText(wrapper, '保存')[0]!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenLastCalledWith('ws-team', { baseVersionNo: 3, items: ['缺货集中在高周转 SKU 类目', '术语：安全库存'] })
    expect((wrapper.get('textarea[aria-label="修改第 1 条"]').element as HTMLTextAreaElement).value).toBe('  缺货集中在高周转 SKU 类目  ')

    await buttonByText(wrapper, '保存')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea[aria-label="修改第 1 条"]').exists()).toBe(false)
    const meta = wrapper.get('[data-testid="project-archive-meta"]').text()
    expect(meta).toContain('第 4 版')
    expect(meta).toContain('林岚手动编辑')
  })

  it('confirms before deleting and appends a new item', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as never)
    const save = vi.spyOn(workbenchApi, 'saveProjectArchive')
      .mockResolvedValueOnce(version({ versionId: 'warch-4', versionNo: 4, sourceKind: 'manual', items: ['术语：安全库存'] }))
      .mockResolvedValueOnce(version({ versionId: 'warch-5', versionNo: 5, sourceKind: 'manual', items: ['术语：安全库存', '决策：按类目设置'] }))
    const wrapper = mountPanel()
    await flushPromises()

    await buttonByText(wrapper, '删除')[0]!.trigger('click')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    await buttonByText(wrapper, '删除')[0]!.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('ws-team', { baseVersionNo: 3, items: ['术语：安全库存'] })

    await wrapper.get('[data-testid="project-archive-add"]').trigger('click')
    await wrapper.get('textarea[aria-label="新条目"]').setValue('决策：按类目设置')
    await buttonByText(wrapper, '添加')[0]!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenLastCalledWith('ws-team', { baseVersionNo: 4, items: ['术语：安全库存', '决策：按类目设置'] })
    expect(wrapper.emitted('count')?.at(-1)).toEqual([2])
  })

  it('shows version history with changes against the previous version and rolls back after confirming', async () => {
    const history = [
      version(),
      version({ versionId: 'warch-2', versionNo: 2, sourceKind: 'manual', sourceTasks: [], items: ['术语：安全库存', '旧结论'], createdBy: { userId: 'u-1', displayName: '林岚' } }),
      version({ versionId: 'warch-1', versionNo: 1, sourceKind: 'manual', sourceTasks: [], items: ['旧结论'], createdBy: { userId: 'u-1', displayName: '林岚' } }),
    ]
    vi.spyOn(workbenchApi, 'listProjectArchiveVersions').mockResolvedValue(history)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const rollback = vi.spyOn(workbenchApi, 'rollbackProjectArchive').mockResolvedValue(version({
      versionId: 'warch-4', versionNo: 4, sourceKind: 'rollback', sourceTasks: [], rollbackFromVersionNo: 1,
      items: ['旧结论'], createdBy: { userId: 'u-2', displayName: '周衡' },
    }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="project-archive-history"]').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="project-archive-version"]')
    expect(rows.map(row => row.get('strong').text())).toEqual(['第 3 版', '第 2 版', '第 1 版'])
    expect(rows[0]!.text()).toContain('当前')
    expect(rows[0]!.findAll('button').map(button => button.text())).not.toContain('回退到此版')
    const changes = wrapper.get('[data-testid="project-archive-changes"]').text()
    expect(changes).toContain('新增缺货集中在高周转类目')
    expect(changes).toContain('删除旧结论')

    await rows[2]!.findAll('button').find(button => button.text() === '回退到此版')!.trigger('click')
    await flushPromises()
    expect(rollback).toHaveBeenCalledWith('ws-team', { versionNo: 1, baseVersionNo: 3 })
    const meta = wrapper.get('[data-testid="project-archive-meta"]').text()
    expect(meta).toContain('第 4 版')
    expect(meta).toContain('周衡回退到第 1 版')
  })
})
