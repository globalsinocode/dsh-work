import { createRequire } from 'node:module'
import type { CellObject, Range, WorkBook, WorkSheet } from 'xlsx'

// SheetJS costs ~50 ms and ~70 MB at import time, so it is loaded on the first legacy
// workbook instead of on server start.
const nodeRequire = createRequire(import.meta.url)
let sheetjs: typeof import('xlsx') | null = null
function xlsx(): typeof import('xlsx') {
  sheetjs ??= nodeRequire('xlsx') as typeof import('xlsx')
  return sheetjs
}

const maxSpreadsheetCells = 20_000
const maxSheets = 30
const fullTableRowLimit = 200
const headRows = 20
const tailRows = 5

export interface LegacyWorkbookExtraction {
  text: string
  sheetCount: number
  rowCount: number
}

/** OLE2 / Compound File Binary signature: shared by legacy .xls and legacy .doc. */
export function isCompoundFile(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0 && bytes.readUInt32BE(4) === 0xa1b11ae1
}

/** Legacy Word stores its main stream as UTF-16LE "WordDocument" in the OLE2 directory. */
export function isLegacyWordDocument(bytes: Buffer): boolean {
  return bytes.includes(Buffer.from('WordDocument', 'utf16le'))
}

/**
 * Legacy .xls workbooks (BIFF8 inside an OLE2 container) are not readable by the ZIP
 * based XLSX extractor, and they are frequently renamed to .csv or .xlsx by mistake.
 * SheetJS handles the cell layer for both formats, so the representation below is
 * shared with the modern path.
 */
export function extractLegacyWorkbook(bytes: Buffer): LegacyWorkbookExtraction {
  let workbook: WorkBook
  try {
    // cellDates is deliberately off: SheetJS converts serials through the local time
    // zone, which shifts dates near midnight. Serials are converted below with UTC math.
    workbook = xlsx().read(bytes, { type: 'buffer', cellNF: true, cellText: true })
  } catch {
    throw extractionError('XLS_STRUCTURE_INVALID', '这个 Excel 文件无法读取，请用 Excel 打开后另存为 .xlsx 再上传')
  }

  const sheetNames = workbook.SheetNames.slice(0, maxSheets)
  if (!sheetNames.length) throw extractionError('XLS_STRUCTURE_INVALID', 'Excel 文件中没有可读取的工作表')

  let cellCount = 0
  let rowCount = 0
  const sections: string[] = []
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const rendered = renderSheet(sheet, sheetName)
    cellCount += rendered.cellCount
    if (cellCount > maxSpreadsheetCells) {
      throw extractionError('XLSX_CELL_LIMIT_EXCEEDED', `Excel 超过 ${maxSpreadsheetCells} 个单元格限制，请拆分后上传`)
    }
    rowCount += rendered.rowCount
    sections.push(rendered.text)
  }
  if (!sections.length) throw extractionError('XLS_STRUCTURE_INVALID', 'Excel 文件中没有可读取的工作表')

  const header = [
    '# Excel 工作簿',
    `工作表：${sections.length}${workbook.SheetNames.length > sections.length ? `（仅解析前 ${sections.length} 个）` : ''}`,
    '说明：本次只提供表格文字，工作簿内嵌的图片不会随文本提供；图片列为空不代表原文件没有图片。',
  ].join('\n') + '\n\n'
  return { text: `${header}${sections.join('\n\n')}`, sheetCount: sections.length, rowCount }
}

interface RenderedSheet {
  text: string
  rowCount: number
  cellCount: number
}

function renderSheet(sheet: WorkSheet, sheetName: string): RenderedSheet {
  const ref = sheet['!ref']
  if (!ref) return { text: `## ${sheetName}\n（空工作表）`, rowCount: 0, cellCount: 0 }
  const range = xlsx().utils.decode_range(ref)
  const merges = (sheet['!merges'] ?? []).filter((merge) => merge.e.r <= range.e.r && merge.e.c <= range.e.c)

  const width = range.e.c - range.s.c + 1
  const height = range.e.r - range.s.r + 1
  const grid: string[][] = []
  let cellCount = 0
  for (let row = 0; row < height; row += 1) {
    const cells: string[] = []
    for (let column = 0; column < width; column += 1) {
      const cell = sheet[xlsx().utils.encode_cell({ r: range.s.r + row, c: range.s.c + column })] as CellObject | undefined
      const value = cellText(cell)
      if (value) cellCount += 1
      cells.push(value)
    }
    grid.push(cells)
  }
  if (!cellCount) return { text: `## ${sheetName}\n（空工作表）`, rowCount: 0, cellCount: 0 }

  // BIFF marks formatted-but-empty rows in the used range; trim them so the table
  // does not report dozens of blank records.
  let lastRow = grid.length - 1
  while (lastRow >= 0 && !grid[lastRow]?.some(Boolean)) lastRow -= 1
  let lastColumn = width - 1
  while (lastColumn >= 0 && !grid.some((row) => row[lastColumn])) lastColumn -= 1
  const trimmed = grid.slice(0, lastRow + 1).map((row) => row.slice(0, lastColumn + 1))
  const trimmedRange: Range = { s: range.s, e: { r: range.s.r + lastRow, c: range.s.c + lastColumn } }
  const trimmedMerges = merges.filter((merge) => merge.e.r <= trimmedRange.e.r && merge.e.c <= trimmedRange.e.c)

  const headerRows = detectHeaderRows(trimmedMerges, trimmedRange)
  const { merged, covered, span } = applyMerges(trimmed, trimmedMerges, trimmedRange)
  const formLike = isFormLike(merged, headerRows, lastColumn + 1, trimmedMerges.length)

  const label = (index: number) => columnLetters(index)
  const lines: string[] = [`## ${sheetName}`]
  if (trimmedMerges.length) {
    const shown = trimmedMerges.slice(0, 12).map((merge) => xlsx().utils.encode_range(merge)).join('、')
    lines.push(`合并单元格：${shown}${trimmedMerges.length > 12 ? ` 等共 ${trimmedMerges.length} 处` : ''}`)
  }

  if (formLike) {
    const rows = formRows(merged, covered, span, trimmedRange)
    lines.push(`形态：表单（标签-值布局，共 ${rows.length} 个非空行）`, '')
    for (const row of rows) lines.push(`r${row.sheetRow + 1}: ${row.text}`)
    return { text: lines.join('\n'), rowCount: rows.length, cellCount }
  }

  const header = Array.from({ length: lastColumn + 1 }, (_, index) => {
    const names: string[] = []
    for (let row = 0; row < headerRows; row += 1) {
      const value = merged[row]?.[index]
      if (value && !names.includes(value)) names.push(value)
    }
    return names.join(' ') || `列${label(index)}`
  })
  const body = merged.slice(headerRows).map((cells) => Array.from({ length: lastColumn + 1 }, (_, index) => cells[index] ?? ''))
  lines.push(`形态：表格（${body.length} 行 × ${lastColumn + 1} 列）`, '')
  if (body.length <= fullTableRowLimit) {
    lines.push(tsv([header, ...body]))
  } else {
    lines.push(profileLines(header, body))
    lines.push(`### 前 ${headRows} 行`, tsv([header, ...body.slice(0, headRows)]))
    lines.push(`### 末 ${tailRows} 行`, tsv([header, ...body.slice(-tailRows)]))
  }
  return { text: lines.join('\n'), rowCount: body.length, cellCount }
}

/**
 * A grouped header merges cells vertically from the first row (e.g. "出货信息" over
 * "日期" and "数量"), which is what makes the header span more than one row.
 */
function detectHeaderRows(merges: Range[], range: Range): number {
  let headerRows = 1
  for (const merge of merges) {
    if (merge.s.r !== range.s.r || merge.e.r === range.s.r) continue
    headerRows = Math.max(headerRows, merge.e.r - range.s.r + 1)
  }
  return Math.min(headerRows, 3, range.e.r - range.s.r + 1)
}

function isFormLike(grid: string[][], headerRows: number, width: number, mergeCount: number): boolean {
  const distinct = new Set(grid.slice(0, headerRows).flat().filter(Boolean)).size
  return distinct / Math.max(1, width) < 0.6 && mergeCount >= 4
}

function applyMerges(grid: string[][], merges: Range[], range: Range) {
  const merged = grid.map((row) => [...row])
  const covered = new Set<string>()
  const span = new Map<string, string>()
  for (const merge of merges) {
    const top = merge.s.r - range.s.r
    const left = merge.s.c - range.s.c
    const value = merged[top]?.[left] ?? ''
    span.set(`${top},${left}`, xlsx().utils.encode_range(merge))
    for (let row = top; row <= merge.e.r - range.s.r; row += 1) {
      for (let column = left; column <= merge.e.c - range.s.c; column += 1) {
        if (row === top && column === left) continue
        covered.add(`${row},${column}`)
        if (merged[row] && value) merged[row][column] = value
      }
    }
  }
  return { merged, covered, span }
}

function formRows(grid: string[][], covered: Set<string>, span: Map<string, string>, range: Range) {
  const rows: { sheetRow: number; text: string }[] = []
  for (let row = 0; row < grid.length; row += 1) {
    const parts: string[] = []
    for (let column = 0; column < (grid[row]?.length ?? 0); column += 1) {
      const key = `${row},${column}`
      if (covered.has(key)) continue
      const value = grid[row]?.[column]
      if (!value) continue
      parts.push(`${span.get(key) ?? columnLetters(range.s.c + column)}=${value}`)
    }
    if (parts.length) rows.push({ sheetRow: range.s.r + row, text: parts.join(' | ') })
  }
  return rows
}

function profileLines(header: string[], body: string[][]): string {
  const lines = [`### 列画像（共 ${body.length} 行）`]
  header.forEach((name, index) => {
    const values = body.map((row) => row[index] ?? '').filter(Boolean)
    const distinct = [...new Set(values)]
    const sample = distinct.slice(0, 3).join(' / ')
    lines.push(`- ${name}：非空 ${values.length}，不同值 ${distinct.length}${sample ? `，示例：${sample}` : ''}`)
  })
  return lines.join('\n')
}

function tsv(rows: string[][]): string {
  return ['```', ...rows.map((row) => row.map((cell) => cell.replaceAll('\t', ' ')).join('\t')), '```'].join('\n')
}

function cellText(cell: CellObject | undefined): string {
  if (!cell) return ''
  if (cell.t === 'n' && typeof cell.v === 'number' && isDateCell(cell)) {
    const days = Math.floor(cell.v)
    const minutes = Math.round((cell.v - days) * 1_440)
    return formatSerial(days, minutes, showsTime(cell))
  }
  if (cell.t === 'd' && cell.v instanceof Date) {
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${cell.v.getFullYear()}-${pad(cell.v.getMonth() + 1)}-${pad(cell.v.getDate())}`
  }
  const text = cell.w ?? (cell.v == null ? '' : String(cell.v))
  return text.replaceAll(/\r?\n/g, ' / ').trim()
}

function isDateCell(cell: CellObject): boolean {
  if (cell.t !== 'n' || typeof cell.v !== 'number') return false
  const format = numberFormat(cell)
  if (/[ymd]/i.test(format)) return true
  if (format) return false
  const display = cell.w ?? ''
  return /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(display) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(display)
}

function showsTime(cell: CellObject): boolean {
  const format = numberFormat(cell)
  if (format) return /[hs]/i.test(format)
  return /:\d{2}/.test(cell.w ?? '')
}

/** Number format without quoted literals or locale/colour brackets. */
function numberFormat(cell: CellObject): string {
  return (typeof cell.z === 'string' ? cell.z : '').replaceAll(/"[^"]*"/g, '').replaceAll(/\[[^\]]*\]/g, '')
}

// Excel's 1900 date system counts from 1899-12-30 (the 1900 leap-year bug is folded into
// that epoch for serials above 60). UTC math keeps the result independent of server TZ.
function formatSerial(days: number, minutes: number, withTime: boolean): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const adjusted = days < 61 ? days + 1 : days
  const date = new Date(Date.UTC(1899, 11, 30) + adjusted * 86_400_000 + minutes * 60_000)
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return withTime ? `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day
}

function columnLetters(index: number): string {
  let value = index
  let letters = ''
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return letters
}

function extractionError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}
