import { describe, expect, it } from 'vitest'

import type { PersonalFile } from '@/types/domain'
import { artifactPreview, parseArtifactText, personalFilePreview, unavailableTextNote } from './artifact-preview'

describe('parseArtifactText (2b-5)', () => {
  it('turns spreadsheet sections into sheets with a header row', () => {
    const parsed = parseArtifactText('xlsx', '# XLSX 文件摘要\n工作表：2；数据行：3\n\n## 营收\n区域\t收入\n华东\t1200\n合计\t=SUM(B2:B2)\n\n## 空表')
    expect(parsed).toEqual({
      kind: 'sheets',
      sheets: [
        { name: '营收', header: ['区域', '收入'], rows: [['华东', '1200'], ['合计', '=SUM(B2:B2)']] },
        { name: '空表', header: [], rows: [] },
      ],
    })
  })

  it('lists deck slides with their notes', () => {
    const parsed = parseArtifactText('pptx', '# PPTX 文件摘要\n幻灯片：2\n\n## 第 1 页\n经营概览\n收入 1200 万元\n备注：先讲增长\n\n## 第 2 页\n下季度重点')
    expect(parsed).toEqual({
      kind: 'slides',
      slides: [
        { no: 1, lines: ['经营概览', '收入 1200 万元'], notes: ['先讲增长'] },
        { no: 2, lines: ['下季度重点'], notes: [] },
      ],
    })
  })

  it('shows documents, PDFs and text in any other shape as it is', () => {
    expect(parseArtifactText('docx', '季度报告\n区域\t收入')).toEqual({ kind: 'plain', text: '季度报告\n区域\t收入' })
    expect(parseArtifactText('xlsx', '没有工作表标题的文本')).toEqual({ kind: 'plain', text: '没有工作表标题的文本' })
  })
})

describe('artifactPreview (2b-5)', () => {
  it('previews HTML in the sandbox, images directly and Office/PDF only once their text exists', () => {
    expect(artifactPreview({ type: 'html' })).toEqual({ kind: 'html' })
    expect(artifactPreview({ type: 'png' })).toEqual({ kind: 'image' })
    expect(artifactPreview({ type: 'jpg' })).toEqual({ kind: 'image' })
    expect(artifactPreview({ type: 'xlsx', textPreview: 'available' })).toEqual({ kind: 'text' })
    expect(artifactPreview({ type: 'pdf', textPreview: 'failed', textPreviewError: 'PDF 无法读取' })).toEqual({ kind: null, note: '无法预览：PDF 无法读取' })
    expect(artifactPreview({ type: 'docx', textPreview: 'pending' })).toEqual({ kind: null, note: '正文暂未生成' })
    expect(artifactPreview({ type: 'markdown' })).toEqual({ kind: null })
  })

  it('explains in the conversation why there is no body to view', () => {
    expect(unavailableTextNote({ textPreview: 'failed', textPreviewError: 'PDF 无法读取' })).toBe('无法生成正文：PDF 无法读取，请下载查看')
    expect(unavailableTextNote({ textPreview: 'failed' })).toBe('无法生成正文：文件解析失败，请下载查看')
    expect(unavailableTextNote({ textPreview: 'pending' })).toBe('正文暂未生成，请稍后再看或下载查看')
  })
})

describe('personalFilePreview (2b-5)', () => {
  const file = (overrides: Partial<PersonalFile>): PersonalFile => ({
    id: 'file-1', name: '营收.xlsx', type: 'XLSX', size: '18 KB', createdAt: '10-27', source: 'artifact',
    sessionId: 's-1', sourceSessionState: 'active', artifactId: 'artifact-1', version: 2,
    scanStatus: 'clean', parseStatus: 'succeeded', canDownload: true, canReference: true, removable: true,
    ...overrides,
  })

  it('offers a preview for generated Office files with text and for images', () => {
    expect(personalFilePreview(file({}))).toEqual({ id: 'artifact-1', version: 2, name: '营收.xlsx', type: 'xlsx' })
    expect(personalFilePreview(file({ name: '图.jpeg', type: 'JPEG', parseStatus: 'not_parsed' }))).toEqual({ id: 'artifact-1', version: 2, name: '图.jpeg', type: 'jpg' })
  })

  it('offers none for uploads, failed extractions, unscanned files or other types', () => {
    expect(personalFilePreview(file({ source: 'attachment', artifactId: null, version: null }))).toBeNull()
    expect(personalFilePreview(file({ parseStatus: 'failed' }))).toBeNull()
    expect(personalFilePreview(file({ scanStatus: 'pending' }))).toBeNull()
    expect(personalFilePreview(file({ name: '纪要.md', type: 'MD' }))).toBeNull()
  })
})
