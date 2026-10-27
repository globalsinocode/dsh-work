import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import ArtifactContentDialog from './ArtifactContentDialog.vue'

const notifyActionFailure = vi.hoisted(() => vi.fn())
const downloadArtifactFile = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure, downloadArtifactFile }))

const sheet = { id: 'artifact-xlsx', version: 3, name: '华东营收.xlsx', type: 'xlsx' as const }
const chart = { id: 'artifact-png', version: 1, name: '营收趋势.png', type: 'png' as const }

function mountDialog(artifact: typeof sheet | typeof chart | { id: string; version: number; name: string; type: 'pdf' | 'docx' }) {
  // el-dialog 渲染到 body：挂到文档中，断言读 document。
  return mount(ArtifactContentDialog, {
    props: { open: true, artifact },
    global: { plugins: [ElementPlus] },
    attachTo: document.body,
  })
}

function dialogText() {
  return document.querySelector('[data-testid="artifact-content-dialog"]')?.textContent ?? ''
}

describe('ArtifactContentDialog (2b-5)', () => {
  beforeEach(() => {
    notifyActionFailure.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('shows every sheet of the extracted text, saying what it leaves out', async () => {
    vi.spyOn(workbenchApi, 'getArtifactText').mockResolvedValue({
      status: 'available', type: 'xlsx', pageCount: null, sheetCount: 2, rowCount: 3,
      text: '# XLSX 文件摘要\n工作表：2\n\n## 营收\n区域\t收入\n华东\t1200\n\n## 明细\n月份\t收入\n7月\t380',
    })
    const wrapper = mountDialog(sheet)
    await flushPromises()
    expect(workbenchApi.getArtifactText).toHaveBeenCalledWith('artifact-xlsx', 3)
    const text = dialogText()
    expect(text).toContain('解析文本 · 只含单元格内容')
    expect(text).toContain('工作表：营收')
    expect(text).toContain('工作表：明细')
    expect(text).toContain('华东')
    expect(text).toContain('7月')
    expect(document.querySelectorAll('.artifact-text__table')).toHaveLength(2)
    wrapper.unmount()
  })

  it('explains a failed or pending extraction instead of showing text', async () => {
    const spy = vi.spyOn(workbenchApi, 'getArtifactText').mockResolvedValueOnce({ status: 'failed', type: 'pdf', message: 'PDF 无法读取' })
    const failed = mountDialog({ ...sheet, type: 'pdf', name: '报告.pdf' })
    await flushPromises()
    expect(dialogText()).toContain('无法生成正文：PDF 无法读取，请下载查看')
    failed.unmount()
    document.body.innerHTML = ''

    spy.mockResolvedValueOnce({ status: 'pending', type: 'docx' })
    const pending = mountDialog({ ...sheet, type: 'docx', name: '说明.docx' })
    await flushPromises()
    expect(dialogText()).toContain('正文暂未生成')
    pending.unmount()
  })

  it('offers a retry when loading fails', async () => {
    const spy = vi.spyOn(workbenchApi, 'getArtifactText')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ status: 'available', type: 'docx', text: '季度报告正文', pageCount: null, sheetCount: null, rowCount: null })
    const wrapper = mountDialog({ ...sheet, type: 'docx', name: '季度报告.docx' })
    await flushPromises()
    expect(dialogText()).toContain('成果内容加载失败')
    expect(notifyActionFailure).toHaveBeenCalledTimes(1)
    ;(document.querySelector('[data-testid="artifact-content-retry"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(dialogText()).toContain('季度报告正文')
    wrapper.unmount()
  })

  it('shows an image from the authenticated download as a local object URL and releases it', async () => {
    vi.spyOn(workbenchApi, 'downloadArtifact').mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const text = vi.spyOn(workbenchApi, 'getArtifactText')
    const wrapper = mountDialog(chart)
    await flushPromises()
    expect(workbenchApi.downloadArtifact).toHaveBeenCalledWith('artifact-png', 1)
    expect(create).toHaveBeenCalledTimes(1)
    const image = document.querySelector('.artifact-content__image') as HTMLImageElement
    expect(image.getAttribute('src')).toBe('blob:chart')
    expect(image.getAttribute('alt')).toBe('营收趋势.png')
    expect(text).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:chart')
  })
})
