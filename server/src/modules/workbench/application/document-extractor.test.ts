import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'
import XLSX from 'xlsx'

import { extractDocument } from './document-extractor.ts'

describe('document extractor', () => {
  it('preserves quoted CSV fields and reports the row count', () => {
    const result = extractDocument('inventory.csv', Buffer.from('物料,说明,库存\nA-01,"华东,成品",120\n'))
    assert.equal(result.detectedType, 'csv')
    assert.equal(result.rowCount, 2)
    assert.match(result.text, /A-01\t华东,成品\t120/)
  })

  it('extracts DOCX paragraph text from a valid Office container', () => {
    const bytes = createStoredZip({
      'word/document.xml': Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>供应链风险</w:t></w:r></w:p><w:p><w:r><w:t>缺料 3 项</w:t></w:r></w:p></w:body></w:document>',
      ),
    })
    const result = extractDocument('report.docx', bytes)
    assert.equal(result.detectedType, 'docx')
    assert.match(result.text, /供应链风险\n缺料 3 项/)
  })

  it('extracts shared and numeric XLSX cells', () => {
    const bytes = createStoredZip({
      'xl/sharedStrings.xml': Buffer.from('<sst><si><t>物料</t></si><si><t>A-01</t></si></sst>'),
      'xl/worksheets/sheet1.xml': Buffer.from(
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>库存</v></c></row><row><c t="s"><v>1</v></c><c><v>120</v></c></row></sheetData></worksheet>',
      ),
    })
    const result = extractDocument('inventory.xlsx', bytes)
    assert.equal(result.detectedType, 'xlsx')
    assert.equal(result.sheetCount, 1)
    assert.match(result.text, /物料\t库存/)
    assert.match(result.text, /A-01\t120/)
  })

  it('extracts basic PDF text operators and rejects disguised PDFs', () => {
    const result = extractDocument('report.pdf', Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (Inventory risk) Tj ET\n%%EOF', 'latin1'))
    assert.equal(result.detectedType, 'pdf')
    assert.equal(result.pageCount, 1)
    assert.match(result.text, /Inventory risk/)
    assert.throws(() => extractDocument('fake.pdf', Buffer.from('not a pdf')), /PDF 文件签名无效/)
  })

  it('rejects invalid UTF-8 and unterminated CSV quotes with actionable codes', () => {
    assert.throws(() => extractDocument('binary.txt', Buffer.from([0xff, 0xfe, 0x00])), errorWithCode('TEXT_BINARY_CONTENT'))
    assert.throws(() => extractDocument('broken.csv', Buffer.from('name,value\n"broken,1')), errorWithCode('CSV_QUOTE_INVALID'))
  })

  it('rejects compressed Office and PDF payloads before they can expand without bounds', () => {
    const oversizedOfficeXml = Buffer.alloc(32 * 1024 * 1024 + 1, 0x41)
    const office = createZip({ 'word/document.xml': oversizedOfficeXml }, 8)
    assert.throws(() => extractDocument('bomb.docx', office), errorWithCode('ZIP_ENTRY_TOO_LARGE'))

    const oversizedPdfStream = deflateSync(Buffer.alloc(8 * 1024 * 1024 + 1, 0x41))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj <</Filter /FlateDecode>>\nstream\n', 'latin1'),
      oversizedPdfStream,
      Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
    ])
    assert.throws(() => extractDocument('bomb.pdf', pdf), errorWithCode('PDF_DECOMPRESSED_SIZE_LIMIT_EXCEEDED'))
  })

  it('reads legacy .xls workbooks by signature even when they were renamed to .csv', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet(
      [
        ['序号', '机种型号', '出货时间'],
        [1, 'TSX30', new Date(2025, 6, 1)],
        [2, 'TSX60', new Date(2026, 8, 1)],
      ],
      { cellDates: true },
    )
    sheet['!merges'] = [{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }]
    XLSX.utils.book_append_sheet(workbook, sheet, '客诉')
    const bytes = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer

    const result = extractDocument('跟进记录.csv', bytes)
    assert.equal(result.detectedType, 'xlsx')
    assert.equal(result.sheetCount, 1)
    assert.equal(result.rowCount, 2)
    assert.match(result.text, /合并单元格：B2:B3/)
    assert.match(result.text, /1\tTSX30\t2025-07-01/)
    assert.match(result.text, /2\tTSX30\t2026-09-01/)
  })

  it('renders form-shaped workbooks as label and value lines', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['供应商整改行动报告', '', '', ''],
      ['物料', 'MT4000.C2', '数量', 504],
      ['结论', '合格', '', ''],
      ['', '', '', ''],
    ])
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 0 }, e: { r: 2, c: 0 } },
      { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },
      { s: { r: 1, c: 2 }, e: { r: 1, c: 2 } },
    ]
    XLSX.utils.book_append_sheet(workbook, sheet, '报告')
    const bytes = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer

    const result = extractDocument('整改报告.xls', bytes)
    assert.match(result.text, /形态：表单/)
    assert.match(result.text, /A1:D1=供应商整改行动报告/)
    assert.match(result.text, /MT4000\.C2/)
  })

  it('merges a two-row grouped header into column names', () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['物料', '出货信息', '', '备注'],
      ['', '日期', '数量', ''],
      ['A-01', new Date(2026, 0, 5), 12, '首批'],
    ])
    sheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } },
      { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } },
      { s: { r: 0, c: 3 }, e: { r: 1, c: 3 } },
    ]
    XLSX.utils.book_append_sheet(workbook, sheet, '出货')
    const bytes = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer

    const result = extractDocument('shipment.xls', bytes)
    assert.equal(result.rowCount, 1)
    assert.match(result.text, /物料\t出货信息 日期\t出货信息 数量\t备注/)
    assert.match(result.text, /A-01\t2026-01-05\t12\t首批/)
  })

  it('rejects a .xls that is not an Excel container and caps legacy cell counts', () => {
    assert.throws(() => extractDocument('old.xls', Buffer.from('not an excel file')), errorWithCode('FILE_TYPE_UNSUPPORTED'))

    const legacyWord = Buffer.concat([
      Buffer.from('d0cf11e0a1b11ae1', 'hex'),
      Buffer.alloc(504),
      Buffer.from('WordDocument', 'utf16le'),
    ])
    assert.throws(() => extractDocument('旧稿.doc', legacyWord), /Word 97-2003/)

    const workbook = XLSX.utils.book_new()
    const rows = Array.from({ length: 300 }, (_, row) => Array.from({ length: 100 }, (_, column) => row * 100 + column))
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'big')
    const bytes = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer
    assert.throws(() => extractDocument('big.xls', bytes), errorWithCode('XLSX_CELL_LIMIT_EXCEEDED'))
  })
})

function errorWithCode(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code
}

function createStoredZip(entries: Record<string, Buffer>) {
  return createZip(entries, 0)
}

function createZip(entries: Record<string, Buffer>, method: 0 | 8) {
  const localParts: Buffer[] = []
  const directoryParts: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const checksum = crc32(content)
    const payload = method === 8 ? deflateRawSync(content) : content
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, payload)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(content.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28)
    directory.writeUInt32LE(offset, 42)
    directoryParts.push(directory, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const directory = Buffer.concat(directoryParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, end])
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
