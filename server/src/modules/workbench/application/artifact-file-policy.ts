import { inflateSync } from 'node:zlib'
import { extname } from 'node:path'
import type { Artifact } from '../../../domain/types.ts'
import { readZip } from './document-extractor.ts'
import type { ArtifactSkipReason } from '../../../domain/artifact-skip-reasons.ts'

export type { ArtifactSkipReason }

/**
 * Which files under `output/` become artifacts (execution isolation 2b-2, plan 4.6).
 *
 * Pure policy over a file name and its bytes; the caller does the file system checks
 * (regular file, no links) and the AV port runs separately. Anything this module cannot
 * check completely is treated as non-compliant: the caller skips the file and says why.
 */

export const ARTIFACT_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  /** Longest file name accepted, in UTF-8 bytes. */
  maxNameBytes: 200,
} as const

type ArtifactFamily = 'text' | 'ooxml' | 'pdf' | 'image'

interface ArtifactFormat {
  type: Artifact['type']
  mimeType: string
  family: ArtifactFamily
}

const FORMATS = new Map<string, ArtifactFormat>([
  ['.md', { type: 'markdown', mimeType: 'text/markdown; charset=utf-8', family: 'text' }],
  ['.txt', { type: 'text', mimeType: 'text/plain; charset=utf-8', family: 'text' }],
  ['.csv', { type: 'csv', mimeType: 'text/csv; charset=utf-8', family: 'text' }],
  ['.html', { type: 'html', mimeType: 'text/html; charset=utf-8', family: 'text' }],
  ['.htm', { type: 'html', mimeType: 'text/html; charset=utf-8', family: 'text' }],
  ['.xlsx', { type: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'ooxml' }],
  ['.docx', { type: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'ooxml' }],
  ['.pptx', { type: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'ooxml' }],
  ['.pdf', { type: 'pdf', mimeType: 'application/pdf', family: 'pdf' }],
  ['.png', { type: 'png', mimeType: 'image/png', family: 'image' }],
  // .jpeg is the same format as .jpg; both are accepted (plan 4.6, decision 3).
  ['.jpg', { type: 'jpg', mimeType: 'image/jpeg', family: 'image' }],
  ['.jpeg', { type: 'jpg', mimeType: 'image/jpeg', family: 'image' }],
])

export function artifactFormat(name: string): ArtifactFormat | null {
  return FORMATS.get(extname(name).toLowerCase()) ?? null
}

/** Text artifacts keep their own content as the extraction; binary ones need a parser (2b-3). */
export function isTextArtifactType(type: Artifact['type']): boolean {
  return type === 'markdown' || type === 'text' || type === 'csv' || type === 'html'
}

export function artifactMimeType(type: Artifact['type']): string {
  return [...FORMATS.values()].find(format => format.type === type)?.mimeType ?? 'application/octet-stream'
}

/** A name safe to echo back: no control characters, bounded length. */
export function displayArtifactName(name: string): string {
  const cleaned = [...name].filter(char => char >= ' ' && char !== '\u007f').join('')
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned
}

/** Name-level checks before the file is opened. */
export function checkArtifactName(name: string): ArtifactSkipReason | null {
  if (!name || name.includes('/') || name.includes('\0') || Buffer.byteLength(name) > ARTIFACT_LIMITS.maxNameBytes
    || [...name].some(char => char < ' ' || char === '\u007f')) return 'invalid_name'
  if (name.startsWith('.')) return 'hidden_file'
  if (!artifactFormat(name)) return 'unsupported_format'
  return null
}

/** Content checks: header matches the extension, no active content, fully checkable. */
export function checkArtifactContent(name: string, bytes: Buffer): ArtifactSkipReason | null {
  const format = artifactFormat(name)
  if (!format) return 'unsupported_format'
  if (bytes.length === 0) return 'empty_file'
  if (bytes.length > ARTIFACT_LIMITS.maxFileBytes) return 'too_large'
  switch (format.family) {
    case 'text': return null
    case 'image': return checkImage(format.type, bytes)
    case 'pdf': return checkPdf(bytes)
    case 'ooxml': return checkOoxml(format.type, bytes)
  }
}

function checkImage(type: Artifact['type'], bytes: Buffer): ArtifactSkipReason | null {
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return (type === 'png' ? png : jpeg) ? null : 'content_mismatch'
}

// ---------------------------------------------------------------------------
// OOXML
// ---------------------------------------------------------------------------

const MAIN_PART: Partial<Record<Artifact['type'], string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
}
const EMBEDDED_PACKAGE = /\.(xlsx|docx|pptx)$/
/** Word field codes that run DDE or pull content from elsewhere when the document opens. */
const ACTIVE_FIELD = /\b(DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK)\b/i

function checkOoxml(type: Artifact['type'], bytes: Buffer, depth = 0): ArtifactSkipReason | null {
  if (bytes.readUInt32LE(0) !== 0x04034b50) return 'content_mismatch'
  let entries: Map<string, Buffer>
  try {
    entries = readZip(bytes)
  } catch {
    return 'unverifiable'
  }
  // Part names are case-insensitive in OPC; a case variant must not slip past a check.
  const parts = new Map<string, Buffer>()
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (parts.has(key)) return 'unverifiable'
    parts.set(key, value)
  }
  const contentTypes = parts.get('[content_types].xml')
  const main = MAIN_PART[type]
  if (!contentTypes || (main && !parts.has(main))) return depth === 0 ? 'content_mismatch' : 'unverifiable'
  if (/macroenabled|vbaproject/i.test(contentTypes.toString('utf8'))) return 'active_content'
  for (const [name, value] of parts) {
    if (name.endsWith('vbaproject.bin') || name.endsWith('vbadata.xml') || name.includes('activex/')) return 'active_content'
    if (name === 'xl/connections.xml' || name.startsWith('xl/externallinks/')) return 'active_content'
    if (name.includes('/embeddings/')) {
      // python-pptx/openpyxl charts embed a workbook package: allowed, but checked one level deep.
      if (!EMBEDDED_PACKAGE.test(name) || depth > 0) return 'active_content'
      const nested = checkOoxml(name.endsWith('.xlsx') ? 'xlsx' : name.endsWith('.docx') ? 'docx' : 'pptx', value, depth + 1)
      if (nested) return nested === 'content_mismatch' ? 'unverifiable' : nested
    }
    if (name.endsWith('.rels') && hasRemoteRelationship(value.toString('utf8'))) return 'active_content'
    if (name.startsWith('word/') && name.endsWith('.xml') && hasActiveField(value.toString('utf8'))) return 'active_content'
  }
  return null
}

/** External relationships other than hyperlinks make Office fetch remote content (templates, images, frames). */
function hasRemoteRelationship(xml: string): boolean {
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) {
    const attributes = match[1] ?? ''
    const mode = /\bTargetMode\s*=\s*["']([^"']*)["']/.exec(attributes)?.[1]
    if (mode?.toLowerCase() !== 'external') continue
    const relationshipType = /\bType\s*=\s*["']([^"']*)["']/.exec(attributes)?.[1] ?? ''
    if (!/\/hyperlink$/i.test(relationshipType)) return true
  }
  return false
}

/** Field instructions may be split across runs, so they are joined before matching. */
function hasActiveField(xml: string): boolean {
  const instructions = [
    ...[...xml.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)].map(match => match[1] ?? ''),
    ...[...xml.matchAll(/\bw:instr\s*=\s*["']([^"']*)["']/g)].map(match => match[1] ?? ''),
  ]
  return ACTIVE_FIELD.test(instructions.join(''))
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Names that carry scripts, launch programs, embed files or pull data in. */
const ACTIVE_PDF_NAMES = new Set(['JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'GoToE', 'ImportData'])
const MAX_PDF_STREAM_BYTES = 8 * 1024 * 1024
const MAX_PDF_DECODED_BYTES = 64 * 1024 * 1024

/**
 * Actions and scripts can only be declared in object dictionaries, which live either in the
 * file body or inside object streams (`/Type /ObjStm`). So the check scans the file with every
 * stream payload blanked out (image, font and content bytes cannot declare anything and would
 * only produce false matches), plus every object stream decoded. An object stream that cannot
 * be decoded, or an encrypted file, cannot be checked and is not accepted.
 */
function checkPdf(bytes: Buffer): ArtifactSkipReason | null {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'content_mismatch'
  const source = bytes.toString('latin1')
  const skeleton: string[] = []
  const objectStreams: string[] = []
  let cursor = 0
  let decodedTotal = 0
  for (const match of source.matchAll(/(?<!end)stream\r?\n/g)) {
    const keyword = match.index ?? 0
    if (keyword < cursor) continue
    const start = keyword + match[0].length
    const end = source.indexOf('endstream', start)
    if (end < 0) return 'unverifiable'
    skeleton.push(source.slice(cursor, keyword))
    cursor = end + 'endstream'.length
    const dictionary = streamDictionary(source, keyword)
    if (!/\/Type\s*\/ObjStm\b/.test(dictionary)) continue
    const predictor = /\/Predictor\s+(\d+)/.exec(dictionary)
    if (predictor && Number(predictor[1]) > 1) return 'unverifiable'
    let data: Buffer | null = Buffer.from(source.slice(start, end).replace(/\r?\n$/, ''), 'latin1')
    for (const match of dictionary.matchAll(/\/(\w+Decode)\b/g)) {
      data = decodePdfFilter(match[1]!, data)
      if (!data) return 'unverifiable'
    }
    decodedTotal += data.length
    if (decodedTotal > MAX_PDF_DECODED_BYTES) return 'unverifiable'
    objectStreams.push(data.toString('latin1'))
  }
  skeleton.push(source.slice(cursor))
  for (const segment of [skeleton.join(' '), ...objectStreams]) {
    for (const name of pdfNames(segment)) {
      if (name === 'Encrypt') return 'unverifiable'
      if (ACTIVE_PDF_NAMES.has(name)) return 'active_content'
    }
  }
  return null
}

/** The dictionary of the object that owns a stream: from its `obj` keyword to the `stream` keyword. */
function streamDictionary(source: string, streamIndex: number): string {
  const window = source.slice(Math.max(0, streamIndex - 4096), streamIndex)
  const object = window.lastIndexOf(' obj')
  return object >= 0 ? window.slice(object) : window
}

function decodePdfFilter(filter: string, data: Buffer): Buffer | null {
  try {
    if (filter === 'FlateDecode') return inflateSync(data, { maxOutputLength: MAX_PDF_STREAM_BYTES })
    if (filter === 'ASCIIHexDecode') return decodeAsciiHex(data)
    if (filter === 'ASCII85Decode') return decodeAscii85(data)
  } catch {
    return null
  }
  // LZW, RunLength and anything unknown: not checked here, so not accepted.
  return null
}

function decodeAsciiHex(data: Buffer): Buffer | null {
  const text = data.toString('latin1').replace(/\s+/g, '')
  const body = text.endsWith('>') ? text.slice(0, -1) : text
  if (!/^[0-9a-fA-F]*$/.test(body)) return null
  return Buffer.from(body.length % 2 ? `${body}0` : body, 'hex')
}

function decodeAscii85(data: Buffer): Buffer | null {
  let text = data.toString('latin1').replace(/\s+/g, '')
  if (text.startsWith('<~')) text = text.slice(2)
  const endMarker = text.indexOf('~>')
  if (endMarker >= 0) text = text.slice(0, endMarker)
  const output: number[] = []
  let group: number[] = []
  for (const char of text) {
    if (char === 'z' && group.length === 0) { output.push(0, 0, 0, 0); continue }
    const code = char.charCodeAt(0) - 33
    if (code < 0 || code > 84) return null
    group.push(code)
    if (group.length === 5) {
      const value = group.reduce((sum, digit) => sum * 85 + digit, 0)
      if (value > 0xffffffff) return null
      output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      group = []
    }
    if (output.length > MAX_PDF_STREAM_BYTES) return null
  }
  if (group.length === 1) return null
  if (group.length > 1) {
    const missing = 5 - group.length
    const value = [...group, ...Array(missing).fill(84)].reduce((sum, digit) => sum * 85 + digit, 0)
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    output.push(...bytes.slice(0, 4 - missing))
  }
  return Buffer.from(output)
}

/** PDF name tokens with `#xx` escapes decoded (`/J#61vaScript` is `/JavaScript`). */
function* pdfNames(text: string): Generator<string> {
  for (const match of text.matchAll(/\/([^\s/<>[\](){}%]+)/g)) {
    yield (match[1] ?? '').replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  }
}
