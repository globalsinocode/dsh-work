import { inflateRawSync, inflateSync } from 'node:zlib'
import { extname } from 'node:path'

const maxExtractedCharacters = 512_000
const maxSpreadsheetCells = 20_000
/**
 * 按列号补空后的总格数上限，与解析文本字符上限相同：每个格至少占一个分隔符，超过时文本本来也会超限。
 * 提前判断只是为了不在内存中展开“单元格位于 XFD 列”一类稀疏表。
 */
const maxSpreadsheetLayoutCells = maxExtractedCharacters
const maxCsvRows = 10_000
const maxPdfInflatedStreamBytes = 8 * 1024 * 1024
const maxPdfInflatedTotalBytes = 32 * 1024 * 1024
const maxZipEntries = 2_048
const maxZipEntryBytes = 32 * 1024 * 1024
const maxZipTotalBytes = 64 * 1024 * 1024

export interface DocumentExtractionResult {
  detectedType: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text'
  text: string
  pageCount: number | null
  sheetCount: number | null
  rowCount: number | null
}

export function extractDocument(name: string, bytes: Buffer): DocumentExtractionResult {
  const extension = extname(name).toLowerCase()
  let result: DocumentExtractionResult
  if (extension === '.pdf') result = extractPdf(bytes)
  else if (extension === '.docx') result = extractDocx(bytes)
  else if (extension === '.xlsx') result = extractXlsx(bytes)
  else if (extension === '.csv') result = extractCsv(bytes)
  else if (extension === '.txt' || extension === '.md') result = extractText(bytes)
  else throw extractionError('FILE_TYPE_UNSUPPORTED', '当前仅支持 PDF、DOCX、XLSX、CSV、TXT 和 Markdown')

  const text = normalizeExtractedText(result.text)
  if (!text) throw extractionError('FILE_NO_EXTRACTABLE_TEXT', '文件中没有可提取的文本内容')
  if (text.length > maxExtractedCharacters) {
    throw extractedTextTooLarge()
  }
  return { ...result, text }
}

function extractText(bytes: Buffer): DocumentExtractionResult {
  const text = decodeUtf8(bytes)
  return { detectedType: 'text', text, pageCount: null, sheetCount: null, rowCount: lineCount(text) }
}

function extractCsv(bytes: Buffer): DocumentExtractionResult {
  const source = decodeUtf8(bytes)
  const rows = parseCsv(source)
  if (rows.length > maxCsvRows) throw extractionError('CSV_ROW_LIMIT_EXCEEDED', `CSV 超过 ${maxCsvRows} 行限制`)
  if (rows.some(row => row.length > 200)) throw extractionError('CSV_COLUMN_LIMIT_EXCEEDED', 'CSV 超过 200 列限制')
  const text = [
    `# CSV 文件摘要\n行数：${rows.length}；最大列数：${Math.max(0, ...rows.map(row => row.length))}`,
    rows.map(row => row.map(value => value.replaceAll('\t', ' ')).join('\t')).join('\n'),
  ].join('\n\n')
  return { detectedType: 'csv', text, pageCount: null, sheetCount: 1, rowCount: rows.length }
}

function extractDocx(bytes: Buffer): DocumentExtractionResult {
  const archive = readZip(bytes)
  const document = archive.get('word/document.xml')
  if (!document) throw extractionError('DOCX_STRUCTURE_INVALID', 'DOCX 缺少 word/document.xml')
  const text = docxText(document.toString('utf8'))
  return { detectedType: 'docx', text, pageCount: null, sheetCount: null, rowCount: lineCount(text) }
}

interface DocxTable { rows: string[][]; row: string[] | null; cell: string[] | null; span: number }

/**
 * 正文按段落换行；表格按行输出、单元格以制表符分隔（与 XLSX 文本一致），横向合并（gridSpan）与行首
 * 跳过的网格（gridBefore）补空单元格，使同一列上下对齐。单元格内多个段落以空格连接；嵌套表格压成
 * 一行放进外层单元格。
 */
function docxText(xml: string) {
  const output: string[] = []
  const tables: DocxTable[] = []
  const current = () => tables.at(-1)
  const write = (value: string) => {
    const table = current()
    if (table?.cell) table.cell.push(value)
    else if (!table) output.push(value)
  }
  const cellValue = (value: string) => value.replaceAll(/\s+/g, ' ').trim()
  // 第二个分支吞掉 XML 声明、注释等其他 <...>，不当作正文。
  for (const token of xml.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9:]*)\b([^>]*?)(\/?)>|<[^>]*>|([^<]+)/g)) {
    const [, closing, name, attributes = '', selfClosing, textNode] = token
    if (textNode !== undefined) { write(decodeXmlEntities(textNode)); continue }
    if (name === undefined) continue
    const table = current()
    if (name === 'w:tab' && selfClosing) write(table ? ' ' : '\t')
    else if ((name === 'w:br' || name === 'w:cr') && selfClosing) write(table ? ' ' : '\n')
    else if (name === 'w:p' && closing) write(table ? ' ' : '\n')
    else if (name === 'w:tbl' && !closing && !selfClosing) tables.push({ rows: [], row: null, cell: null, span: 1 })
    else if (name === 'w:tbl' && closing && table) {
      tables.pop()
      const rendered = table.rows.map(row => row.join('\t'))
      const parent = current()
      if (parent?.cell) parent.cell.push(` ${rendered.join(' / ')} `)
      else if (!parent) output.push(`\n${rendered.join('\n')}\n`)
    } else if (!table) continue
    else if (name === 'w:tr' && !closing && !selfClosing) table.row = []
    else if (name === 'w:tr' && closing && table.row) { table.rows.push(table.row); table.row = null }
    else if (name === 'w:gridBefore' && table.row && !table.cell) {
      const count = gridCount(attributes)
      for (let index = 0; index < count; index += 1) table.row.push('')
    } else if (name === 'w:tc' && !closing && !selfClosing) { table.cell = []; table.span = 1 }
    else if (name === 'w:gridSpan' && table.cell) table.span = gridCount(attributes)
    else if (name === 'w:tc' && closing && table.cell) {
      table.row ??= []
      table.row.push(cellValue(table.cell.join('')))
      for (let index = 1; index < table.span; index += 1) table.row.push('')
      table.cell = null
    }
  }
  return output.join('')
}

function gridCount(attributes: string) {
  const value = Number(/\bw:val="(\d+)"/.exec(attributes)?.[1] ?? '1')
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 64) : 1
}

function extractXlsx(bytes: Buffer): DocumentExtractionResult {
  const archive = readZip(bytes)
  const sharedStrings = parseSharedStrings(archive.get('xl/sharedStrings.xml'))
  const sheets = [...archive.entries()]
    .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
  if (!sheets.length) throw extractionError('XLSX_STRUCTURE_INVALID', 'XLSX 中没有可读取的工作表')
  if (sheets.length > 30) throw extractionError('XLSX_SHEET_LIMIT_EXCEEDED', 'XLSX 超过 30 个工作表限制')

  let totalRows = 0
  const budget = { cells: 0, layoutCells: 0 }
  const sections: string[] = []
  for (const [path, sheet] of sheets) {
    const rows = parseSheet(sheet.toString('utf8'), sharedStrings, budget)
    totalRows += rows.length
    sections.push(`## ${path.split('/').at(-1)?.replace('.xml', '') ?? '工作表'}\n${rows.map(row => row.join('\t')).join('\n')}`)
  }
  const text = `# XLSX 文件摘要\n工作表：${sheets.length}；数据行：${totalRows}；单元格：${budget.cells}\n\n${sections.join('\n\n')}`
  return { detectedType: 'xlsx', text, pageCount: null, sheetCount: sheets.length, rowCount: totalRows }
}

function extractPdf(bytes: Buffer): DocumentExtractionResult {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw extractionError('PDF_SIGNATURE_INVALID', 'PDF 文件签名无效')
  }
  const source = bytes.toString('latin1')
  const pageCount = (source.match(/\/Type\s*\/Page\b/g) ?? []).length
  if (pageCount > 200) throw extractionError('PDF_PAGE_LIMIT_EXCEEDED', 'PDF 超过 200 页限制')
  const parts: string[] = []
  let inflatedBytes = 0
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  for (const match of source.matchAll(streamPattern)) {
    const raw = Buffer.from(match[1] ?? '', 'latin1')
    const dictionary = source.slice(Math.max(0, (match.index ?? 0) - 500), match.index)
    let content = raw
    if (/\/FlateDecode\b/.test(dictionary)) {
      try {
        content = inflateSync(raw, { maxOutputLength: maxPdfInflatedStreamBytes })
      } catch (cause) {
        if (isOutputLimitExceeded(cause)) {
          throw extractionError('PDF_DECOMPRESSED_SIZE_LIMIT_EXCEEDED', 'PDF 单个压缩流解压后超过 8 MB 限制')
        }
        continue
      }
      inflatedBytes += content.length
      if (inflatedBytes > maxPdfInflatedTotalBytes) {
        throw extractionError('PDF_DECOMPRESSED_SIZE_LIMIT_EXCEEDED', 'PDF 压缩流累计解压后超过 32 MB 限制')
      }
    }
    parts.push(extractPdfTextOperators(content.toString('latin1')))
  }
  if (!parts.some(part => part.trim())) parts.push(extractPdfTextOperators(source))
  return { detectedType: 'pdf', text: parts.join('\n'), pageCount: pageCount || null, sheetCount: null, rowCount: null }
}

function extractPdfTextOperators(content: string) {
  const values: string[] = []
  for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) values.push(decodePdfLiteral(match[1] ?? ''))
  for (const match of content.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)) {
    const array = match[1] ?? ''
    const text = [...array.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map(item => decodePdfLiteral(item[1] ?? '')).join('')
    if (text) values.push(text)
  }
  for (const match of content.matchAll(/<([A-Fa-f0-9\s]+)>\s*Tj/g)) {
    const hex = (match[1] ?? '').replaceAll(/\s/g, '')
    if (hex.length % 2 === 0) values.push(decodePdfHex(Buffer.from(hex, 'hex')))
  }
  return values.join('\n')
}

function decodePdfLiteral(value: string) {
  return value
    .replaceAll(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\n')
    .replaceAll('\\t', '\t')
    .replaceAll('\\(', '(')
    .replaceAll('\\)', ')')
    .replaceAll('\\\\', '\\')
}

function decodePdfHex(bytes: Buffer) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = ''
    for (let index = 2; index + 1 < bytes.length; index += 2) result += String.fromCharCode(bytes.readUInt16BE(index))
    return result
  }
  return bytes.toString('latin1')
}

/**
 * Bounded ZIP reader for OOXML: entry count, per-entry and total inflated size are capped.
 * Duplicate names and encrypted entries are refused (a duplicate would silently shadow a part).
 */
export function readZip(bytes: Buffer) {
  const signature = 0x06054b50
  let eocdOffset = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === signature) { eocdOffset = index; break }
  }
  if (eocdOffset < 0) throw extractionError('ZIP_STRUCTURE_INVALID', 'Office 文件不是有效的 ZIP 容器')
  const entryCount = bytes.readUInt16LE(eocdOffset + 10)
  if (entryCount > maxZipEntries) {
    throw extractionError('ZIP_ENTRY_LIMIT_EXCEEDED', `Office 文件超过 ${maxZipEntries} 个 ZIP 条目限制`)
  }
  let offset = bytes.readUInt32LE(eocdOffset + 16)
  let totalUncompressedBytes = 0
  const entries = new Map<string, Buffer>()
  for (let entry = 0; entry < entryCount; entry += 1) {
    assertBufferRange(bytes, offset, 46, 'ZIP_DIRECTORY_INVALID', 'Office 文件目录结构无效')
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw extractionError('ZIP_DIRECTORY_INVALID', 'Office 文件目录结构无效')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    if (uncompressedSize > maxZipEntryBytes) {
      throw extractionError('ZIP_ENTRY_TOO_LARGE', `Office 文件单个 ZIP 条目解压后超过 32 MB 限制`)
    }
    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > maxZipTotalBytes) {
      throw extractionError('ZIP_TOTAL_SIZE_LIMIT_EXCEEDED', 'Office 文件 ZIP 条目累计解压后超过 64 MB 限制')
    }
    assertBufferRange(bytes, offset + 46, nameLength + extraLength + commentLength, 'ZIP_DIRECTORY_INVALID', 'Office 文件目录结构无效')
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (flags & 0x1) throw extractionError('ZIP_ENTRY_ENCRYPTED', `Office 文件条目已加密：${name}`)
    if (entries.has(name)) throw extractionError('ZIP_DUPLICATE_ENTRY', `Office 文件条目重复：${name}`)
    assertBufferRange(bytes, localOffset, 30, 'ZIP_ENTRY_INVALID', `Office 文件条目无效：${name}`)
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw extractionError('ZIP_ENTRY_INVALID', `Office 文件条目无效：${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    assertBufferRange(bytes, dataOffset, compressedSize, 'ZIP_ENTRY_INVALID', `Office 文件条目无效：${name}`)
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
    let value: Buffer
    if (method === 0) {
      if (compressedSize !== uncompressedSize) throw extractionError('ZIP_ENTRY_SIZE_MISMATCH', `Office 文件条目大小不一致：${name}`)
      value = Buffer.from(compressed)
    } else if (method === 8) {
      try {
        value = inflateRawSync(compressed, { maxOutputLength: maxZipEntryBytes })
      } catch (cause) {
        if (isOutputLimitExceeded(cause)) {
          throw extractionError('ZIP_ENTRY_TOO_LARGE', `Office 文件条目解压后超过 32 MB 限制：${name}`)
        }
        throw extractionError('ZIP_ENTRY_INVALID', `Office 文件条目无法解压：${name}`)
      }
    }
    else throw extractionError('ZIP_COMPRESSION_UNSUPPORTED', `Office 文件使用了不支持的压缩方法：${method}`)
    if (value.length !== uncompressedSize) throw extractionError('ZIP_ENTRY_SIZE_MISMATCH', `Office 文件条目大小不一致：${name}`)
    entries.set(name, value)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function parseSharedStrings(bytes: Buffer | undefined) {
  if (!bytes) return []
  const xml = bytes.toString('utf8')
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match =>
    decodeXmlEntities(richText(match[1] ?? '')),
  )
}

/**
 * XLSX 省略空单元格，单元格按 `r`（如 F3）给出的列号放置，中间缺的补空，否则右侧的值会左移到错误的列。
 * 没有 `r` 的单元格紧接上一个单元格。`cells` 只计实际出现的单元格；`layoutCells` 另计补空后的格数，
 * 用来拦住“稀疏但列号极大”的表（例如单个单元格位于 XFD 列）在内存与文本中展开。
 */
function parseSheet(xml: string, sharedStrings: string[], budget: { cells: number; layoutCells: number }) {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = []
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const reference = /\br="([A-Za-z]{1,3})\d*"/.exec(attributes)?.[1]
      // 列号不递增（不合规范的生成器）时退回紧接上一个单元格，与修改前一致，不拒收文件。
      const column = Math.max(reference ? columnIndex(reference) : row.length, row.length)
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1]
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const inline = type === 'inlineStr' ? richText(body) : undefined
      let value = decodeXmlEntities(inline ?? raw ?? '')
      if (type === 's' && raw && Number.isInteger(Number(raw))) value = sharedStrings[Number(raw)] ?? ''
      if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE'
      if (!value && !cellMatch[2]) continue
      budget.layoutCells += column + 1 - row.length
      budget.cells += 1
      if (budget.cells > maxSpreadsheetCells) {
        throw extractionError('XLSX_CELL_LIMIT_EXCEEDED', `XLSX 超过 ${maxSpreadsheetCells} 个单元格限制`)
      }
      if (budget.layoutCells > maxSpreadsheetLayoutCells) throw extractedTextTooLarge()
      while (row.length < column) row.push('')
      row.push(value.replaceAll(/[\r\n\t]+/g, ' '))
    }
    while (row.length && !row.at(-1)) row.pop()
    if (row.length) rows.push(row)
  }
  return rows
}

/** A → 0、Z → 25、AA → 26；XLSX 最多到 XFD（16384 列）。 */
function columnIndex(letters: string) {
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function parseCsv(source: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted && character === '"' && source[index + 1] === '"') { value += '"'; index += 1 }
    else if (character === '"') quoted = !quoted
    else if (!quoted && character === ',') { row.push(value); value = '' }
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(value); rows.push(row); row = []; value = ''
    } else value += character
  }
  if (value || row.length) { row.push(value); rows.push(row) }
  if (quoted) throw extractionError('CSV_QUOTE_INVALID', 'CSV 存在未闭合的引号')
  return rows.filter(candidate => candidate.some(cell => cell.trim()))
}

function decodeUtf8(bytes: Buffer) {
  if (bytes.includes(0)) throw extractionError('TEXT_BINARY_CONTENT', '文本文件包含二进制内容')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([A-Fa-f0-9]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

/** Line endings, trailing blanks and runs of blank lines, as every stored extraction is normalized. */
export function normalizeExtractedText(value: string) {
  // 开头只去掉整行空白：首行的前导制表符是空单元格的占位（例如以左上角为空的表格开头的 DOCX），去掉会让该行整体左移。
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll(/[ \t]+\n/g, '\n').replaceAll(/\n{4,}/g, '\n\n\n')
    .replace(/^\s*\n/, '').trimEnd()
}

function lineCount(value: string) {
  return value ? value.split(/\r?\n/).length : 0
}

function extractedTextTooLarge() {
  return extractionError('FILE_EXTRACTED_TEXT_TOO_LARGE', `文件解析后的文本超过 ${maxExtractedCharacters} 字符，请拆分后重试`)
}

/** 富文本中的全部文本段；跳过注音（rPh，例如日文假名读音），只保留正文。 */
function richText(xml: string) {
  return [...xml.replaceAll(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => item[1] ?? '').join('')
}

function extractionError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

function assertBufferRange(
  bytes: Buffer,
  offset: number,
  length: number,
  code: string,
  message: string,
) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw extractionError(code, message)
  }
}

function isOutputLimitExceeded(cause: unknown) {
  return cause instanceof Error && 'code' in cause && cause.code === 'ERR_BUFFER_TOO_LARGE'
}
