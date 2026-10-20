import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'
import XLSX from 'xlsx'

import { extractDocument } from './document-extractor.ts'
import { readWorkbookStream } from './workbook-images.ts'

/**
 * 把只含 Workbook 流的 BIFF8 数据包成最小 CFB 容器。测试要的是「能被解析」，
 * 不是把 Excel 的完整容器写对：一个常规流 + 目录扇区 + FAT 扇区就够了。
 */
function wrapWorkbookStream(stream: Buffer) {
  const sectorSize = 512
  assert.ok(stream.length >= 4096, 'Legacy fixture must exceed the mini-stream cutoff')
  const streamSectors = Math.ceil(stream.length / sectorSize)
  const directorySector = streamSectors
  const fatSector = streamSectors + 1
  const totalSectors = streamSectors + 2
  const header = Buffer.alloc(sectorSize)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0)
  header.writeUInt16LE(0x003e, 0x18)
  header.writeUInt16LE(0x0003, 0x1a)
  header.writeUInt16LE(0xfffe, 0x1c)
  header.writeUInt16LE(9, 0x1e)
  header.writeUInt16LE(6, 0x20)
  header.writeUInt32LE(1, 0x2c)
  header.writeUInt32LE(directorySector, 0x30)
  header.writeUInt32LE(4096, 0x38)
  header.writeUInt32LE(0xfffffffe, 0x3c)
  header.writeUInt32LE(0, 0x40)
  header.writeUInt32LE(0xfffffffe, 0x44)
  header.writeUInt32LE(0, 0x48)
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(0xffffffff, 0x4c + index * 4)
  header.writeUInt32LE(fatSector, 0x4c)

  const fat = Buffer.alloc(sectorSize, 0xff)
  for (let index = 0; index < streamSectors; index += 1) {
    fat.writeUInt32LE(index === streamSectors - 1 ? 0xfffffffe : index + 1, index * 4)
  }
  fat.writeUInt32LE(0xfffffffe, directorySector * 4)
  fat.writeUInt32LE(0xfffffffd, fatSector * 4)

  const paddedStream = Buffer.alloc(streamSectors * sectorSize)
  stream.copy(paddedStream, 0)

  const directory = Buffer.alloc(sectorSize)
  const rootEntry = Buffer.alloc(128)
  rootEntry.write('Root Entry', 0, 'utf16le')
  rootEntry.writeUInt16LE(22, 64)
  rootEntry.writeUInt8(5, 66)
  rootEntry.writeUInt8(1, 67)
  rootEntry.writeUInt32LE(0xffffffff, 68)
  rootEntry.writeUInt32LE(0xffffffff, 72)
  rootEntry.writeUInt32LE(1, 76)
  rootEntry.writeUInt32LE(0xfffffffe, 116)
  rootEntry.writeUInt32LE(0, 120)
  directory.set(rootEntry, 0)
  const streamEntry = Buffer.alloc(128)
  streamEntry.write('Workbook', 0, 'utf16le')
  streamEntry.writeUInt16LE(18, 64)
  streamEntry.writeUInt8(2, 66)
  streamEntry.writeUInt8(1, 67)
  streamEntry.writeUInt32LE(0xffffffff, 68)
  streamEntry.writeUInt32LE(0xffffffff, 72)
  streamEntry.writeUInt32LE(0xffffffff, 76)
  streamEntry.writeUInt32LE(0, 116)
  streamEntry.writeUInt32LE(stream.length, 120)
  directory.set(streamEntry, 128)

  assert.ok(totalSectors * sectorSize < 64 * 1024)
  return Buffer.concat([header, paddedStream, directory, fat])
}

/** 在 BIFF8 流里插入图形层记录：绘图组带一张 PNG，工作表锚点指向第 4 行。 */
function injectPictureRecords(stream: Buffer) {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5000, 0x20)])
  const fbseFixed = Buffer.alloc(36)
  fbseFixed.writeUInt16LE(1, 0)
  const fbse = escherRecord(0xf007, Buffer.concat([fbseFixed, png]))
  const store = escherContainer(0xf001, 1, [fbse])
  const group = escherContainer(0xf000, 0, [store])
  const groupRecord = biffRecord(0x00eb, group)

  const properties = Buffer.from([0x04, 0x41, 0x01, 0x00, 0x00, 0x00])
  const anchor = Buffer.alloc(18)
  anchor.writeInt16LE(3, 6)
  anchor.writeInt16LE(3, 14)
  const shape = escherContainer(0xf004, 1, [
    escherRecord(0xf00a, Buffer.alloc(8)),
    escherRecord(0xf00b, properties),
    escherRecord(0xf010, anchor),
  ])
  const drawing = escherContainer(0xf002, 0, [shape])
  const drawingRecord = biffRecord(0x00ec, drawing)

  // 绘图组紧跟全局 BOF（整条记录之后）；工作表图形紧挨工作表 EOF 之前。
  const globalsBofEnd = 4 + stream.readUInt16LE(2)
  const withGroup = Buffer.concat([stream.subarray(0, globalsBofEnd), groupRecord, stream.subarray(globalsBofEnd)])
  const delta = groupRecord.length
  const boundsheetOffset = findRecordOffset(withGroup, 0x0085)
  assert.ok(boundsheetOffset >= 0)
  withGroup.writeUInt32LE(withGroup.readUInt32LE(boundsheetOffset + 4) + delta, boundsheetOffset + 4)

  const eofOffset = findSheetEof(withGroup)
  assert.ok(eofOffset >= 0)
  return Buffer.concat([withGroup.subarray(0, eofOffset), drawingRecord, withGroup.subarray(eofOffset)])
}

function findSheetEof(stream: Buffer) {
  let position = 0
  let inSheet = false
  while (position + 4 <= stream.length) {
    const type = stream.readUInt16LE(position)
    const length = stream.readUInt16LE(position + 2)
    if (type === 0x0809 && length >= 4) {
      inSheet = stream.readUInt16LE(position + 6) === 0x0010
    } else if (type === 0x000a && inSheet) {
      return position
    }
    position += 4 + length
  }
  return -1
}

function findRecordOffset(stream: Buffer, type: number) {
  let position = 0
  while (position + 4 <= stream.length) {
    if (stream.readUInt16LE(position) === type) return position
    position += 4 + stream.readUInt16LE(position + 2)
  }
  return -1
}

function biffRecord(type: number, payload: Buffer) {
  const header = Buffer.alloc(4)
  header.writeUInt16LE(type, 0)
  header.writeUInt16LE(payload.length, 2)
  return Buffer.concat([header, payload])
}

function escherRecord(type: number, payload: Buffer, instance = 0, version = 2) {
  const header = Buffer.alloc(8)
  header.writeUInt16LE((instance << 4) | version, 0)
  header.writeUInt16LE(type, 2)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function escherContainer(type: number, instance: number, children: Buffer[]) {
  return escherRecord(type, Buffer.concat(children), instance, 0x0f)
}

function legacyWorkbookFixture() {
  const workbook = XLSX.utils.book_new()
  const rows: (string | number)[][] = [['日期', '内容', '照片']]
  for (let index = 0; index < 120; index += 1) rows.push(['2026-10-01', `更换轴承 ${index}`, ''])
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, sheet, 'S1')
  const container = XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) as Buffer
  // SheetJS 直接写出完整 .xls 容器；拿回 Workbook 流后注入图形层，再包成本测试用的最小容器。
  const stream = readWorkbookStream(container)
  assert.ok(stream && stream.length >= 4096)
  return wrapWorkbookStream(injectPictureRecords(stream))
}

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

  it('keeps embedded workbook pictures as attachments the agent can read', () => {
    const bytes = legacyWorkbookFixture()
    const result = extractDocument('跟进记录.xls', bytes)
    assert.equal(result.detectedType, 'xlsx')
    assert.equal(result.attachments?.length, 1)
    const attachment = result.attachments?.[0]
    assert.equal(attachment?.name, 'image-1.png')
    assert.equal(attachment?.mediaType, 'image/png')
    assert.ok((attachment?.bytes.length ?? 0) > 4096)
    assert.equal(attachment?.source, 'S1 第 4 行')
    assert.match(result.text, /内嵌图片（1 张）/)
    assert.match(result.text, /attachments\/image-1\.png：S1 第 4 行/)
  })

  it('keeps XLSX drawing pictures as attachments too', () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>照片</t></is></c></row></sheetData></worksheet>'
    const bytes = createStoredZip({
      'xl/workbook.xml': Buffer.from('<workbook><sheets><sheet name="客诉" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': Buffer.from(sheet),
      'xl/worksheets/_rels/sheet1.xml.rels': Buffer.from('<Relationships><Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>'),
      'xl/drawings/drawing1.xml': Buffer.from(
        '<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:row>1</xdr:row></xdr:from>'
        + '<xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>',
      ),
      'xl/drawings/_rels/drawing1.xml.rels': Buffer.from('<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>'),
      'xl/media/image1.png': Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 0x20)]),
    })
    const result = extractDocument('客诉.xlsx', bytes)
    assert.equal(result.attachments?.length, 1)
    assert.equal(result.attachments?.[0]?.name, 'image-1.png')
    assert.equal(result.attachments?.[0]?.source, '客诉 第 2 行')
    assert.match(result.text, /内嵌图片：1 张/)
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
