import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Artifact } from '@/types/domain'
import ArtifactPreviewBody from './ArtifactPreviewBody.vue'

const { downloadArtifact, getArtifactText } = vi.hoisted(() => ({ downloadArtifact: vi.fn(), getArtifactText: vi.fn() }))
vi.mock('@/api/client', () => ({ workbenchApi: { downloadArtifact, getArtifactText } }))
const notifyActionFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure }))

type Previewable = Pick<Artifact, 'id' | 'version' | 'name' | 'type'>
const memo: Previewable = { id: 'a-md', version: 2, name: '备忘.md', type: 'markdown' }

function mountBody(artifact: Previewable | null, props: Record<string, unknown> = {}) {
  return mount(ArtifactPreviewBody, { props: { artifact, active: true, ...props }, global: { plugins: [ElementPlus] } })
}

describe('ArtifactPreviewBody', () => {
  beforeEach(() => {
    downloadArtifact.mockReset()
    getArtifactText.mockReset()
    notifyActionFailure.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads markdown and text from the authenticated download and renders it', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['# 备忘正文\n\n- 第一项']))
    const wrapper = mountBody(memo)
    expect(wrapper.find('[data-testid="artifact-preview-skeleton"]').exists()).toBe(true)
    await flushPromises()
    expect(downloadArtifact).toHaveBeenCalledWith('a-md', 2)
    expect(getArtifactText).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('备忘正文')
    expect(wrapper.text()).toContain('第一项')
  })

  it('says an empty file has nothing to show', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['  \n']))
    const wrapper = mountBody({ ...memo, type: 'text', name: '空.txt' })
    await flushPromises()
    expect(wrapper.get('[data-testid="artifact-preview-empty"]').text()).toContain('没有可显示的内容')
  })

  it('shows CSV as plain text without markdown rendering', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['区域,收入\n华东,1200']))
    const wrapper = mountBody({ ...memo, type: 'csv', name: '营收.csv' })
    await flushPromises()
    expect(wrapper.get('.artifact-preview-body__plain').text()).toBe('区域,收入\n华东,1200')
  })

  it('reports a failed load, notifies once and retries on request', async () => {
    downloadArtifact.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(new Blob(['恢复后的正文']))
    const wrapper = mountBody(memo)
    await flushPromises()
    expect(wrapper.get('[data-testid="artifact-preview-error"]').text()).toContain('成果内容加载失败')
    expect(notifyActionFailure).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="artifact-preview-retry"]').trigger('click')
    await flushPromises()
    expect(downloadArtifact).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('恢复后的正文')
  })

  it('shows Office text with sheet tabs when asked, and only the extracted text', async () => {
    getArtifactText.mockResolvedValue({
      status: 'available', type: 'xlsx', pageCount: null, sheetCount: 2, rowCount: 2,
      text: '# XLSX 文件摘要\n工作表：2\n\n## 营收\n区域\t收入\n华东\t1200\n\n## 明细\n月份\t收入\n7月\t380',
    })
    const wrapper = mountBody({ id: 'a-xlsx', version: 1, name: '营收.xlsx', type: 'xlsx' }, { textLayout: 'tabs' })
    await flushPromises()
    expect(getArtifactText).toHaveBeenCalledWith('a-xlsx', 1)
    expect(downloadArtifact).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('解析文本 · 只含单元格内容')
    const tabs = wrapper.findAll('.artifact-text__tab')
    expect(tabs.map(tab => tab.text())).toEqual(['营收', '明细'])
    await tabs[1]!.trigger('click')
    expect(wrapper.get('table').text()).toContain('7月')
  })

  it('explains a failed or pending extraction', async () => {
    getArtifactText.mockResolvedValueOnce({ status: 'failed', type: 'pdf', message: 'PDF 无法读取' })
    const failed = mountBody({ id: 'a-pdf', version: 1, name: '报告.pdf', type: 'pdf' })
    await flushPromises()
    expect(failed.text()).toContain('无法生成正文：PDF 无法读取，请下载查看')

    getArtifactText.mockResolvedValueOnce({ status: 'pending', type: 'docx' })
    const pending = mountBody({ id: 'a-docx', version: 1, name: '说明.docx', type: 'docx' })
    await flushPromises()
    expect(pending.text()).toContain('正文暂未生成')
  })

  it('does not load while inactive, and drops a late response after switching artifacts', async () => {
    let resolveFirst!: (blob: Blob) => void
    downloadArtifact
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(new Blob(['第二个成果']))
    const wrapper = mountBody(memo, { active: false })
    await flushPromises()
    expect(downloadArtifact).not.toHaveBeenCalled()

    await wrapper.setProps({ active: true })
    await wrapper.setProps({ artifact: { ...memo, id: 'a-other', name: '另一个.md' } })
    await flushPromises()
    resolveFirst(new Blob(['第一个成果']))
    await flushPromises()
    expect(wrapper.text()).toContain('第二个成果')
    expect(wrapper.text()).not.toContain('第一个成果')
  })

  it('renders HTML in an allow-scripts sandbox with the preview CSP, and shows the raw source on request', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['<html><head></head><body><h1>看板</h1></body></html>']))
    const wrapper = mountBody({ id: 'a-html', version: 1, name: '看板.html', type: 'html' })
    await flushPromises()
    const frame = wrapper.get('[data-testid="artifact-preview-frame"]')
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    expect(frame.attributes('srcdoc')).toContain("default-src 'none'")

    await wrapper.setProps({ htmlView: 'source' })
    expect(wrapper.get('[data-testid="artifact-preview-source"]').text()).not.toContain('Content-Security-Policy')
  })
})
