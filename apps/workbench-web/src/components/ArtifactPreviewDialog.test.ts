import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { Artifact } from '@/types/domain'
import ArtifactPreviewDialog from './ArtifactPreviewDialog.vue'

// 反馈提示走 mock：本文件要断言「关闭/卸载后不得再弹提示」，不能依赖真实 ElMessage。
const notifyActionFailure = vi.hoisted(() => vi.fn())
const downloadArtifactFile = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure, downloadArtifactFile }))

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    name: '华东区交付风险看板.html',
    type: 'html',
    version: 2,
    size: '4 KB',
    createdAt: '今天 09:23',
    runId: 'run-1',
    workspaceId: 'ws-supply',
    summary: '交互式风险看板',
    ...overrides,
  }
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(ArtifactPreviewDialog, {
    props: {
      open: true,
      artifact: artifact(),
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('ArtifactPreviewDialog HTML 成果预览', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'downloadArtifact').mockResolvedValue(
      new Blob(['<!DOCTYPE html><html><body><h1>风险看板</h1></body></html>'], { type: 'text/html' }),
    )
  })

  it('按成果 id 与版本取回内容，并在 allow-scripts 沙箱 iframe 中渲染', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(workbenchApi.downloadArtifact).toHaveBeenCalledWith('artifact-1', 2)
    const frame = wrapper.find('[data-testid="artifact-preview-frame"]')
    expect(frame.exists()).toBe(true)
    // opaque origin：允许脚本但不同源——不能加 allow-same-origin。
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    expect(frame.attributes('referrerpolicy')).toBe('no-referrer')
    expect(frame.attributes('srcdoc')).toContain('<h1>风险看板</h1>')
    // 注入的预览 CSP：禁网络子资源与外发，仅放内联脚本/样式与 data: 图片。
    expect(frame.attributes('srcdoc')).toContain('Content-Security-Policy')
    expect(frame.attributes('srcdoc')).toContain("default-src 'none'")
    expect(frame.attributes('title')).toContain('华东区交付风险看板.html')
  })

  it('「源代码」视图展示原始标记，「渲染预览」切回 iframe', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const radios = wrapper.findAll('input[type="radio"]')
    await radios[1]!.setValue()
    await flushPromises()

    const source = wrapper.find('[data-testid="artifact-preview-source"]')
    expect(source.exists()).toBe(true)
    expect(source.text()).toContain('<!DOCTYPE html>')
    // 源代码视图展示原始标记，不含为渲染注入的 CSP meta。
    expect(source.text()).not.toContain('Content-Security-Policy')
    expect(wrapper.find('[data-testid="artifact-preview-frame"]').exists()).toBe(false)
  })

  it('加载失败就地报错，「重试」真的重新请求', async () => {
    vi.mocked(workbenchApi.downloadArtifact)
      .mockRejectedValueOnce(new Error('服务暂不可用'))
      .mockResolvedValueOnce(new Blob(['<p>ok</p>']))
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-testid="artifact-preview-error"]').exists()).toBe(true)

    await wrapper.find('[data-testid="artifact-preview-retry"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.downloadArtifact).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="artifact-preview-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="artifact-preview-frame"]').exists()).toBe(true)
  })

  it('下载按钮复用既有鉴权下载通道', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.find('[data-testid="artifact-preview-download"]').trigger('click')

    expect(downloadArtifactFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'artifact-1' }))
  })

  it('弹窗具备含文件名的可访问名称', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    const labelledby = dialog.attributes('aria-labelledby')
    expect(labelledby).toBeTruthy()
    const labelled = wrapper.find(`[id="${labelledby}"]`)
    expect(labelled.text()).toContain('成果预览')
    expect(labelled.text()).toContain('华东区交付风险看板.html')
  })
})

describe('ArtifactPreviewDialog 竞态', () => {
  it('关闭对话框后晚到的失败不得再弹提示', async () => {
    let rejectRequest!: (reason: unknown) => void
    vi.spyOn(workbenchApi, 'downloadArtifact').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRequest = reject }),
    )
    notifyActionFailure.mockClear()
    const wrapper = mountDialog()

    await wrapper.setProps({ open: false })
    rejectRequest(new Error('boom'))
    await flushPromises()

    expect(notifyActionFailure).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="artifact-preview-error"]').exists()).toBe(false)
  })

  it('切换到另一个成果时清空上一份内容并重新加载', async () => {
    vi.spyOn(workbenchApi, 'downloadArtifact').mockImplementation(async (id: string) =>
      new Blob([`<h1>${id}</h1>`]))
    const wrapper = mountDialog({ artifact: artifact({ id: 'artifact-a', version: 1 }) })
    await flushPromises()

    expect(wrapper.find('[data-testid="artifact-preview-frame"]').attributes('srcdoc')).toContain('artifact-a')

    await wrapper.setProps({ artifact: artifact({ id: 'artifact-b', version: 3 }) })
    // 新内容到达前不得还渲染 A 的文档。
    expect(wrapper.find('[data-testid="artifact-preview-frame"]').exists()).toBe(false)
    await flushPromises()
    expect(wrapper.find('[data-testid="artifact-preview-frame"]').attributes('srcdoc')).toContain('artifact-b')
  })
})
