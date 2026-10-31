import type { Artifact, PersonalFile } from '@/types/domain'

/** 执行隔离 2b-5：成果卡“预览”的方式。html 走隔离沙箱渲染，text 为 Office/PDF 解析文本，image 为图片。 */
export type ArtifactPreviewKind = 'html' | 'text' | 'image'

export const OFFICE_ARTIFACT_TYPES = ['xlsx', 'docx', 'pptx', 'pdf'] as const
export type OfficeArtifactType = typeof OFFICE_ARTIFACT_TYPES[number]

export function isOfficeArtifact(type: Artifact['type']): type is OfficeArtifactType {
  return (OFFICE_ARTIFACT_TYPES as readonly string[]).includes(type)
}

export function isImageArtifact(type: Artifact['type']) {
  return type === 'png' || type === 'jpg'
}

/**
 * How a card can preview the artifact, or the note shown instead: Office/PDF only once their text
 * was extracted; a failed or pending extraction explains itself. Other types have no card preview.
 */
export function artifactPreview(artifact: Pick<Artifact, 'type' | 'textPreview' | 'textPreviewError'>): { kind: ArtifactPreviewKind | null; note?: string } {
  if (artifact.type === 'html') return { kind: 'html' }
  if (isImageArtifact(artifact.type)) return { kind: 'image' }
  if (!isOfficeArtifact(artifact.type)) return { kind: null }
  if (artifact.textPreview === 'available') return { kind: 'text' }
  return { kind: null, note: artifact.textPreview === 'failed' ? `无法预览：${artifact.textPreviewError || '文件解析失败'}` : '正文暂未生成' }
}

/** 预览正文的取法：html 沙箱渲染原文，text 为 Office/PDF 解析文本，raw 为 Markdown/文本/CSV 原文，image 为原图。 */
export type ArtifactBodyKind = 'html' | 'text' | 'raw' | 'image'

/**
 * 预览侧栏需要的最小成果信息：对话与成果库里是完整成果；“我的文件”列表只有
 * id、版本、名称与类型（personalFilePreview），大小与解析状态可有可无。
 */
export type ArtifactPreviewTarget = Pick<Artifact, 'id' | 'version' | 'name' | 'type'>
  & Partial<Pick<Artifact, 'size' | 'textPreview'>>

export function artifactBodyKind(type: Artifact['type']): ArtifactBodyKind {
  if (type === 'html') return 'html'
  if (isImageArtifact(type)) return 'image'
  if (isOfficeArtifact(type)) return 'text'
  return 'raw'
}

const PERSONAL_FILE_TYPES: Record<string, Artifact['type']> = {
  XLSX: 'xlsx', DOCX: 'docx', PPTX: 'pptx', PDF: 'pdf', PNG: 'png', JPG: 'jpg', JPEG: 'jpg',
}

/**
 * “我的文件”中可以预览的生成成果：解析成功的 Office/PDF 与图片。返回预览侧栏需要的成果版本；
 * 解析失败或尚未解析的，列表本身已有说明，不提供“预览”。
 */
export function personalFilePreview(file: PersonalFile): Pick<Artifact, 'id' | 'version' | 'name' | 'type'> | null {
  if (file.source !== 'artifact' || !file.artifactId || !file.version || file.scanStatus !== 'clean') return null
  const type = PERSONAL_FILE_TYPES[file.type.toUpperCase()]
  if (!type) return null
  if (isOfficeArtifact(type) && file.parseStatus !== 'succeeded') return null
  if (!isOfficeArtifact(type) && !isImageArtifact(type)) return null
  return { id: file.artifactId, version: file.version, name: file.name, type }
}

/** “查看正文”不可用时的说明；解析失败带上原因，尚未解析时说明会补齐。 */
export function unavailableTextNote(artifact: Pick<Artifact, 'textPreview' | 'textPreviewError'>) {
  if (artifact.textPreview === 'failed') return `无法生成正文：${artifact.textPreviewError || '文件解析失败'}，请下载查看`
  return '正文暂未生成，请稍后再看或下载查看'
}

/** What the extracted text leaves out, shown above every Office/PDF text preview. */
export const TEXT_PREVIEW_HINTS: Record<OfficeArtifactType, string> = {
  xlsx: '解析文本 · 只含单元格内容，不含格式、图表与批注；没有计算结果的公式显示为公式本身',
  docx: '解析文本 · 只含文字与表格内容，不含标题样式、图片和页面版式',
  pptx: '解析文本 · 按页列出文字、表格与备注，不含版式和图片',
  pdf: '解析文本 · 只含可提取的文字，不含版式、图片与表格线',
}

export interface ParsedSheet { name: string; header: string[]; rows: string[][] }
export interface ParsedSlide { no: number; lines: string[]; notes: string[] }
export type ParsedArtifactText =
  | { kind: 'sheets'; sheets: ParsedSheet[] }
  | { kind: 'slides'; slides: ParsedSlide[] }
  | { kind: 'plain'; text: string }

/**
 * Structures extracted text for display. Spreadsheets and decks follow the extractor's format
 * (`## <sheet>` sections of tab-separated rows; `## 第 N 页` sections with `备注：` lines); text in
 * any other shape is shown as it is.
 */
export function parseArtifactText(type: OfficeArtifactType, text: string): ParsedArtifactText {
  const sections = text.split(/\n(?=## )/).slice(1)
  if (type === 'xlsx' && sections.length) {
    return {
      kind: 'sheets',
      sheets: sections.map((section) => {
        const [title = '', ...lines] = section.split('\n')
        const rows = lines.filter(line => line.trim()).map(line => line.split('\t'))
        return { name: title.slice(3).trim() || '工作表', header: rows[0] ?? [], rows: rows.slice(1) }
      }),
    }
  }
  if (type === 'pptx' && sections.length) {
    return {
      kind: 'slides',
      slides: sections.map((section, index) => {
        const [title = '', ...lines] = section.split('\n')
        const no = Number(/第\s*(\d+)\s*页/.exec(title)?.[1]) || index + 1
        const content = lines.filter(line => line.trim())
        return {
          no,
          lines: content.filter(line => !line.startsWith('备注：')),
          notes: content.filter(line => line.startsWith('备注：')).map(line => line.slice(3)),
        }
      }),
    }
  }
  return { kind: 'plain', text }
}

export { CSV_PREVIEW_MAX_ROWS, parseCsvPreview } from './artifact-preview-csv'
export { renderMarkdownPreview } from '@dsh-work/ui-core'
