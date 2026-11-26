import assert from 'node:assert/strict'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, it } from 'node:test'

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

  it('places XLSX cells by their column reference when empty cells are omitted', () => {
    const bytes = createStoredZip({
      'xl/worksheets/sheet1.xml': Buffer.from([
        '<worksheet><sheetData>',
        '<row r="1"><c r="A1" t="inlineStr"><is><t>合同</t></is></c><c r="B1" t="inlineStr"><is><t>签约金额</t></is></c><c r="C1" t="inlineStr"><is><t>成本</t></is></c></row>',
        '<row r="2"><c r="A2" t="inlineStr"><is><t>C1</t></is></c><c r="B2"><v>100</v></c><c r="C2"><v>60</v></c></row>',
        '<row r="3"><c r="A3" t="inlineStr"><is><r><t>C</t></r><r><t>2</t></r></is></c><c r="B3" s="1"/><c r="C3"><v>70</v></c></row>',
        '<row r="4"><c r="C4"><v>5</v></c></row>',
        '<row r="5"/>',
        '</sheetData></worksheet>',
      ].join('')),
    })
    const result = extractDocument('contracts.xlsx', bytes)
    const lines = result.text.split('\n')
    assert.ok(lines.includes('C1\t100\t60'))
    assert.ok(lines.includes('C2\t\t70'), '成本 70 必须仍在第三列，签约金额为空')
    assert.ok(lines.includes('\t\t5'))
    assert.equal(result.rowCount, 4)
    assert.match(result.text, /单元格：9/)
  })

  it('rejects a sparse XLSX sheet that would expand into an enormous number of empty columns', () => {
    const row = (index: number) => `<row r="${index}"><c r="XFD${index}"><v>1</v></c></row>`
    const bytes = createStoredZip({
      'xl/worksheets/sheet1.xml': Buffer.from(`<worksheet><sheetData>${Array.from({ length: 40 }, (_, index) => row(index + 1)).join('')}</sheetData></worksheet>`),
    })
    assert.throws(() => extractDocument('sparse.xlsx', bytes), { code: 'FILE_EXTRACTED_TEXT_TOO_LARGE' })
    // 同样稀疏但展开后仍在文本上限内的表照常解析，不比修改前的文本上限更严格。
    const fits = createStoredZip({
      'xl/worksheets/sheet1.xml': Buffer.from(`<worksheet><sheetData>${Array.from({ length: 20 }, (_, index) => row(index + 1)).join('')}</sheetData></worksheet>`),
    })
    assert.equal(extractDocument('sparse.xlsx', fits).rowCount, 20)
  })

  it('skips phonetic runs in shared and inline rich strings', () => {
    const phonetic = '<r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh>'
    const bytes = createStoredZip({
      'xl/sharedStrings.xml': Buffer.from(`<sst><si>${phonetic}</si></sst>`),
      'xl/worksheets/sheet1.xml': Buffer.from(`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is>${phonetic}</is></c></row></sheetData></worksheet>`),
    })
    assert.ok(extractDocument('cities.xlsx', bytes).text.split('\n').includes('東京\t東京'))
  })

  it('keeps the leading empty cell when a DOCX opens with a table', () => {
    const cell = (text: string) => `<w:tc><w:p>${text ? `<w:r><w:t>${text}</w:t></w:r>` : ''}</w:p></w:tc>`
    const bytes = createStoredZip({
      'word/document.xml': Buffer.from(`<w:document xmlns:w="urn:w"><w:body><w:tbl><w:tr>${cell('')}${cell('金额')}${cell('期限')}</w:tr><w:tr>${cell('A')}${cell('1')}${cell('2')}</w:tr></w:tbl></w:body></w:document>`),
    })
    assert.equal(extractDocument('matrix.docx', bytes).text, '\t金额\t期限\nA\t1\t2')
  })

  it('keeps DOCX table rows and columns, padding merged cells so columns stay aligned', () => {
    const cell = (text: string, properties = '') => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ''}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
    const bytes = createStoredZip({
      'word/document.xml': Buffer.from([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="urn:w"><w:body>',
        '<w:p><w:r><w:t>合同条款</w:t></w:r></w:p>',
        '<w:tbl><w:tblPr/>',
        `<w:tr>${cell('条款')}${cell('金额')}${cell('期限')}</w:tr>`,
        `<w:tr>${cell('付款与交付', '<w:gridSpan w:val="2"/>')}${cell('30 天')}</w:tr>`,
        `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell('1,200')}<w:tc><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:tc></w:tr>`,
        `<w:tr>${cell('附表')}<w:tc><w:tbl><w:tr>${cell('甲')}${cell('乙')}</w:tr></w:tbl><w:p/></w:tc>${cell('')}</w:tr>`,
        '</w:tbl>',
        '<w:p><w:r><w:t>以上 &amp; 以下</w:t></w:r></w:p>',
        '</w:body></w:document>',
      ].join('')),
    })
    const result = extractDocument('contract.docx', bytes)
    const lines = result.text.split('\n')
    assert.ok(!result.text.includes('xml version'))
    assert.equal(lines[0], '合同条款')
    assert.ok(lines.includes('条款\t金额\t期限'))
    assert.ok(lines.includes('付款与交付\t\t30 天'), '横向合并后“期限”仍在第三列')
    assert.ok(lines.includes('\t1,200\t第一段 第二段'), '行首跳过的网格补空，单元格内多段以空格连接')
    assert.ok(lines.includes('附表\t甲 乙'), '嵌套表格压成一行放进外层单元格（行尾空单元格的制表符随文本规范化去掉）')
    assert.ok(lines.includes('以上 & 以下'))
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
