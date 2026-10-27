import { inflateRawSync, inflateSync } from 'node:zlib'
import { extname } from 'node:path'

const maxExtractedCharacters = 512_000
const maxSpreadsheetCells = 20_000
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
    throw extractionError('FILE_EXTRACTED_TEXT_TOO_LARGE', '文件解析后的文本超过 512000 字符，请拆分后重试')
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
  const xml = document.toString('utf8')
  const text = decodeXmlEntities(xml
    .replaceAll(/<w:tab\b[^>]*\/>/g, '\t')
    .replaceAll(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replaceAll(/<\/w:p>/g, '\n')
    .replaceAll(/<[^>]+>/g, ''))
  return { detectedType: 'docx', text, pageCount: null, sheetCount: null, rowCount: lineCount(text) }
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
  let totalCells = 0
  const sections: string[] = []
  for (const [path, sheet] of sheets) {
    const rows = parseSheet(sheet.toString('utf8'), sharedStrings)
    totalRows += rows.length
    totalCells += rows.reduce((count, row) => count + row.length, 0)
    if (totalCells > maxSpreadsheetCells) {
      throw extractionError('XLSX_CELL_LIMIT_EXCEEDED', `XLSX 超过 ${maxSpreadsheetCells} 个单元格限制`)
    }
    sections.push(`## ${path.split('/').at(-1)?.replace('.xml', '') ?? '工作表'}\n${rows.map(row => row.join('\t')).join('\n')}`)
  }
  const text = `# XLSX 文件摘要\n工作表：${sheets.length}；数据行：${totalRows}；单元格：${totalCells}\n\n${sections.join('\n\n')}`
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
    decodeXmlEntities([...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => item[1] ?? '').join('')),
  )
}

function parseSheet(xml: string, sharedStrings: string[]) {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1]
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1]
      let value = decodeXmlEntities(inline ?? raw ?? '')
      if (type === 's' && raw && Number.isInteger(Number(raw))) value = sharedStrings[Number(raw)] ?? ''
      if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE'
      row.push(value.replaceAll(/[\r\n\t]+/g, ' '))
    }
    rows.push(row)
  }
  return rows
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
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll(/[ \t]+\n/g, '\n').replaceAll(/\n{4,}/g, '\n\n\n').trim()
}

function lineCount(value: string) {
  return value ? value.split(/\r?\n/).length : 0
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
