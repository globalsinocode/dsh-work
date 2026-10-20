import { inflateRawSync } from 'node:zlib'

/**
 * 工作簿内嵌图片的提取（遗留 .xls/BIFF8 与 .xlsx/OOXML 两个适配器）。
 *
 * 表格文字只承载单元格，照片、截图这类只存在于图形层的内容必须另存为附件，
 * 运行时再挂进工作区，模型才能用 read_image 真正看到它们。
 *
 * 这里只做「读」：不转码、不缩放。无法被图片工具识别的格式（EMF/WMF/PICT/DIB/TIFF）
 * 一律跳过并只计数，避免把模型看不懂的字节塞进工作区。
 */
const maxImages = 12
const maxImageBytes = 6 * 1024 * 1024
const maxTotalImageBytes = 16 * 1024 * 1024
const maxStreamBytes = 64 * 1024 * 1024
const maxZipTotalBytes = 64 * 1024 * 1024

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff])
const gifSignature = Buffer.from('GIF8')

export interface WorkbookImage {
  /** 附件文件名，例如 image-1.png */
  name: string
  mediaType: string
  bytes: Buffer
  /** 图片在表格中的位置，写进文本让模型能把图和行对上。 */
  source: string
}

export interface WorkbookImageExtraction {
  images: WorkbookImage[]
  /** 存在但格式无法读取的图片数量（EMF/WMF/DIB 等）。 */
  skipped: number
}

const emptyExtraction: WorkbookImageExtraction = { images: [], skipped: 0 }

/**
 * 图片提取永远不能拖垮文本解析：格式损坏、超出限额都退回「没有图片」。
 */
export function extractWorkbookImages(bytes: Buffer): WorkbookImageExtraction {
  try {
    if (isCompoundFileBytes(bytes)) return collect(extractBiffImages(bytes))
    if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304) return collect(extractOoxmlImages(bytes))
    return emptyExtraction
  } catch {
    return emptyExtraction
  }
}

function isCompoundFileBytes(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0 && bytes.readUInt32BE(4) === 0xa1b11ae1
}

interface RawImage {
  format: 'png' | 'jpeg' | 'gif'
  bytes: Buffer
  source: string
}

function collect(raw: { images: RawImage[]; skipped: number }): WorkbookImageExtraction {
  const images: WorkbookImage[] = []
  let totalBytes = 0
  for (const image of raw.images) {
    if (images.length >= maxImages) break
    if (image.bytes.length > maxImageBytes) {
      raw.skipped += 1
      continue
    }
    if (totalBytes + image.bytes.length > maxTotalImageBytes) break
    totalBytes += image.bytes.length
    const extension = image.format === 'jpeg' ? 'jpg' : image.format
    images.push({
      name: `image-${images.length + 1}.${extension}`,
      mediaType: `image/${image.format}`,
      bytes: image.bytes,
      source: image.source,
    })
  }
  return { images, skipped: raw.skipped }
}

// ---------------------------------------------------------------------------
// 遗留 .xls：OLE2 容器 + BIFF8 记录 + OfficeArt/Escher 图形层
// ---------------------------------------------------------------------------

interface BiffRecord {
  type: number
  offset: number
  payload: Buffer
}

interface EscherRecord {
  version: number
  instance: number
  type: number
  dataStart: number
  length: number
  children?: EscherRecord[]
}

function extractBiffImages(bytes: Buffer): { images: RawImage[]; skipped: number } {
  const stream = readWorkbookStream(bytes)
  if (!stream) return { images: [], skipped: 0 }
  const records = readBiffRecords(stream)

  const blips = readBlips(records)
  if (!blips.length) return { images: [], skipped: 0 }

  const sheetNames = readSheetNames(records)
  const anchorsBySheet = readSheetAnchors(records, sheetNames)
  const rowsByPicture = new Map<number, string[]>()
  for (const [sheetName, anchors] of anchorsBySheet) {
    for (const anchor of anchors) {
      const list = rowsByPicture.get(anchor.picture) ?? []
      list.push(anchor.row > 0 ? `${sheetName} 第 ${anchor.row} 行` : sheetName)
      rowsByPicture.set(anchor.picture, list)
    }
  }

  const images: RawImage[] = []
  let skipped = 0
  blips.forEach((blip, index) => {
    const format = imageFormat(blip.bytes)
    if (!format) {
      skipped += 1
      return
    }
    const rows = rowsByPicture.get(index + 1)
    images.push({
      format,
      bytes: blip.bytes,
      source: rows?.length ? [...new Set(rows)].join('、') : '工作簿图形层',
    })
  })
  return { images, skipped }
}

/** OfficeArt BLIP 记录的类型码 → 是否为受支持的位图。 */
const unsupportedBlipTypes = new Set([0xf018, 0xf019, 0xf01a, 0xf01d, 0xf01e])

function readBlips(records: BiffRecord[]): { bytes: Buffer }[] {
  const groupIndex = records.findIndex((record) => record.type === 0x00eb)
  if (groupIndex < 0) return []
  const drawing = concatDrawingRecords(records, groupIndex, 0x00eb)
  const tree = parseEscher(drawing)
  const store = [...walkEscher(tree)].find((record) => record.type === 0xf001)
  if (!store?.children) return []

  const blips: { bytes: Buffer }[] = []
  for (const record of store.children) {
    // OfficeArtFBSE(0xF007) 内的 BLIP 可能被直接内联，也可能是独立的 0xF018..0xF01E 记录。
    const raw = drawing.subarray(record.dataStart, record.dataStart + record.length)
    if (unsupportedBlipTypes.has(record.type)) continue
    const image = sliceBitmap(raw)
    if (image) blips.push({ bytes: image })
  }
  return blips
}

/** 从 BLIP 记录里截出真正的图片字节（记录头允许带前导掩码/尺寸字段）。 */
function sliceBitmap(raw: Buffer): Buffer | null {
  const png = raw.indexOf(pngSignature)
  if (png >= 0) return raw.subarray(png)
  const jpeg = raw.indexOf(jpegSignature)
  if (jpeg >= 0) return raw.subarray(jpeg)
  const gif = raw.indexOf(gifSignature)
  if (gif >= 0) return raw.subarray(gif)
  return null
}

function imageFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(pngSignature)) return 'png'
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(jpegSignature)) return 'jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 4).equals(gifSignature)) return 'gif'
  return null
}

function readBiffRecords(stream: Buffer): BiffRecord[] {
  const records: BiffRecord[] = []
  for (let position = 0; position + 4 <= stream.length;) {
    const type = stream.readUInt16LE(position)
    const length = stream.readUInt16LE(position + 2)
    const start = position + 4
    if (start + length > stream.length) break
    records.push({ type, offset: position, payload: stream.subarray(start, start + length) })
    position = start + length
  }
  return records
}

/**
 * 图形层可能被拆成多条记录：绘图组是 MSODRAWINGGROUP(0x00EB) + 紧随其后的
 * CONTINUE(0x003C)；工作表图形则是一串 MSODRAWING(0x00EC)，其间还夹着别的
 * 记录。两种都要整段拼接，只取第一条会解析出半截 Escher 树。
 */
function concatDrawingRecords(records: BiffRecord[], startIndex: number, startType: number): Buffer {
  const parts: Buffer[] = []
  if (startType === 0x00eb) {
    for (let index = startIndex; index < records.length; index += 1) {
      const type = records[index]!.type
      if (type !== 0x00eb && type !== 0x003c) break
      parts.push(records[index]!.payload)
    }
    return Buffer.concat(parts)
  }
  for (let index = startIndex; index < records.length; index += 1) {
    const type = records[index]!.type
    if (type === 0x00ec || type === 0x003c) parts.push(records[index]!.payload)
  }
  return Buffer.concat(parts)
}

/** BOUNDSHEET(0x0085) 的 lbPlyPos 指向该工作表子流的 BOF，是子流归属的唯一可靠依据。 */
function readSheetNames(records: BiffRecord[]): Map<number, string> {
  const names = new Map<number, string>()
  for (const record of records) {
    if (record.type !== 0x0085 || record.payload.length < 8) continue
    const offset = record.payload.readUInt32LE(0)
    const characterCount = record.payload[6] ?? 0
    const wide = ((record.payload[7] ?? 0) & 0x01) === 1
    const text = record.payload.subarray(8, 8 + characterCount * (wide ? 2 : 1))
    const name = wide ? text.toString('utf16le') : text.toString('latin1')
    if (name) names.set(offset, name)
  }
  return names
}

interface PictureAnchor {
  picture: number
  row: number
}

function readSheetAnchors(records: BiffRecord[], sheetNames: Map<number, string>): Map<string, PictureAnchor[]> {
  const anchorsBySheet = new Map<string, PictureAnchor[]>()
  records.forEach((record, index) => {
    // BOF(0x0809) 且 dt=0x0010 表示工作表子流；BOUNDSHEET 的偏移量给出表名。
    if (record.type !== 0x0809 || record.payload.length < 4 || record.payload.readUInt16LE(2) !== 0x0010) return
    const sheetName = sheetNames.get(record.offset) ?? '工作表'
    // 子流范围：本 BOF 之后、下一个 EOF(0x000A) 之前。
    const end = records.findIndex((candidate, position) => position > index && candidate.type === 0x000a)
    const limit = end < 0 ? records.length : end
    const drawingIndex = records.findIndex((candidate, position) => position > index && position < limit && candidate.type === 0x00ec)
    if (drawingIndex < 0) return
    const drawing = concatDrawingRecords(records.slice(0, limit), drawingIndex, 0x00ec)
    if (!drawing.length) return
    const anchors = readPictureAnchors(drawing)
    if (anchors.length) anchorsBySheet.set(sheetName, anchors)
  })
  return anchorsBySheet
}

function readPictureAnchors(drawing: Buffer): PictureAnchor[] {
  const anchors: PictureAnchor[] = []
  for (const container of walkEscher(parseEscher(drawing))) {
    if (container.type !== 0xf004) continue // OfficeArtSpContainer
    let picture: number | null = null
    let row = 0
    for (const child of container.children ?? []) {
      if (child.type === 0xf00b || child.type === 0xf00c || child.type === 0xf00d) {
        picture ??= readPictureIndex(drawing.subarray(child.dataStart, child.dataStart + child.length))
      }
      if (child.type === 0xf010) {
        // OfficeArtClientAnchor：18 字节，行号是偏移 6 的 int16，后随 1/65536 小数部分。
        const anchor = drawing.subarray(child.dataStart, child.dataStart + child.length)
        if (anchor.length >= 18) row = anchor.readInt16LE(6) + 1
      }
    }
    if (picture !== null) anchors.push({ picture, row })
  }
  return anchors
}

/** 图片序号（pib，1 起）在形状属性表里以 opid 0x4104 出现；属性表存在填充，按字节扫描。 */
function readPictureIndex(properties: Buffer): number | null {
  for (let position = 0; position + 6 <= properties.length; position += 1) {
    if (properties.readUInt16LE(position) !== 0x4104) continue
    const value = properties.readUInt32LE(position + 2)
    if (value > 0 && value <= 4096) return value
  }
  return null
}

function parseEscher(buffer: Buffer, from = 0, to = buffer.length): EscherRecord[] {
  const records: EscherRecord[] = []
  let position = from
  while (position + 8 <= to) {
    const versionInstance = buffer.readUInt16LE(position)
    const type = buffer.readUInt16LE(position + 2)
    const length = buffer.readUInt32LE(position + 4)
    const dataStart = position + 8
    if (length > to - dataStart) break
    const record: EscherRecord = {
      version: versionInstance & 0x0f,
      instance: versionInstance >> 4,
      type,
      dataStart,
      length,
    }
    // 0xF 版本号表示容器：递归解析其子记录。
    if (record.version === 0x0f) record.children = parseEscher(buffer, dataStart, dataStart + length)
    records.push(record)
    position = dataStart + length
  }
  return records
}

function* walkEscher(records: EscherRecord[]): Generator<EscherRecord> {
  for (const record of records) {
    yield record
    if (record.children) yield* walkEscher(record.children)
  }
}

/**
 * 极简 CFB(OLE2) 读取：只要目录里的常规流。扇区、FAT、mini-stream 的上限都做过
 * 约束，畸形文件最多读不到图片，不会无限分配。
 */
export function readWorkbookStream(bytes: Buffer): Buffer | null {
  return readCompoundStream(bytes, ['Workbook', 'Book'])
}

function readCompoundStream(bytes: Buffer, names: string[]): Buffer | null {
  if (!isCompoundFileBytes(bytes)) return null
  const sectorSize = 1 << bytes.readUInt16LE(0x1e)
  if (sectorSize !== 512 && sectorSize !== 4096) return null
  const firstDirectorySector = bytes.readUInt32LE(0x30)
  const miniStreamCutoff = bytes.readUInt32LE(0x38)
  const fatSectorCount = bytes.readUInt32LE(0x2c)

  const fatSectorIds: number[] = []
  for (let index = 0; index < 109; index += 1) {
    const sector = bytes.readUInt32LE(0x4c + index * 4)
    if (sector < 0xfffffffa) fatSectorIds.push(sector)
  }
  let nextDifat = bytes.readUInt32LE(0x44)
  for (let guard = 0; nextDifat < 0xfffffffa && guard < 4096; guard += 1) {
    const base = (nextDifat + 1) * sectorSize
    if (base + sectorSize > bytes.length) break
    const perSector = sectorSize / 4 - 1
    for (let index = 0; index < perSector; index += 1) {
      const sector = bytes.readUInt32LE(base + index * 4)
      if (sector < 0xfffffffa) fatSectorIds.push(sector)
    }
    nextDifat = bytes.readUInt32LE(base + perSector * 4)
  }
  if (fatSectorIds.length > Math.max(fatSectorCount, 1) + 1_024) return null

  const fat: number[] = []
  for (const sector of fatSectorIds) {
    const base = (sector + 1) * sectorSize
    if (base + sectorSize > bytes.length) break
    for (let index = 0; index < sectorSize / 4; index += 1) fat.push(bytes.readUInt32LE(base + index * 4))
  }

  const chain = (start: number): number[] => {
    const sectors: number[] = []
    const seen = new Set<number>()
    let sector = start
    while (sector < 0xfffffffa && !seen.has(sector) && sectors.length <= fat.length) {
      seen.add(sector)
      sectors.push(sector)
      if ((sector + 1) * sectorSize >= bytes.length) break
      sector = fat[sector] ?? 0xfffffffe
    }
    return sectors
  }

  const readChain = (start: number, size: number): Buffer => {
    const chunks = chain(start)
      .filter((sector) => (sector + 2) * sectorSize <= bytes.length)
      .map((sector) => bytes.subarray((sector + 1) * sectorSize, (sector + 2) * sectorSize))
    const joined = Buffer.concat(chunks)
    return joined.subarray(0, Math.min(size, joined.length, maxStreamBytes))
  }

  const directorySectors = chain(firstDirectorySector)
  const directory = Buffer.concat(directorySectors
    .filter((sector) => (sector + 2) * sectorSize <= bytes.length)
    .map((sector) => bytes.subarray((sector + 1) * sectorSize, (sector + 2) * sectorSize)))

  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    if (directory[offset + 66] !== 2) continue // 2 = 常规流
    const nameLength = directory.readUInt16LE(offset + 64)
    const name = directory.subarray(offset, offset + Math.max(0, nameLength - 2)).toString('utf16le')
    if (!names.includes(name)) continue
    const start = directory.readUInt32LE(offset + 116)
    const size = directory.readUInt32LE(offset + 120)
    // mini-stream 里的流（小于 4096 字节）不是工作簿主体，这里不需要。
    if (size < miniStreamCutoff) continue
    if (size > maxStreamBytes) continue
    return readChain(start, size)
  }
  return null
}

// ---------------------------------------------------------------------------
// .xlsx：ZIP 包内的 xl/media + 绘图锚点
// ---------------------------------------------------------------------------

function extractOoxmlImages(bytes: Buffer): { images: RawImage[]; skipped: number } {
  const entries = readZipEntries(bytes)
  if (!entries) return { images: [], skipped: 0 }

  const media = [...entries.keys()]
    .filter((path) => path.startsWith('xl/media/'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  if (!media.length) return { images: [], skipped: 0 }

  const sheetNames = readOoxmlSheetNames(entries)
  const rowsByMedia = readOoxmlAnchors(entries, sheetNames, media)

  const images: RawImage[] = []
  let skipped = 0
  for (const path of media) {
    const content = entries.get(path)
    if (!content) continue
    const format = imageFormat(content)
    if (!format) {
      skipped += 1
      continue
    }
    const rows = rowsByMedia.get(path)
    images.push({
      format,
      bytes: content,
      source: rows?.length ? [...new Set(rows)].join('、') : '工作簿图片',
    })
  }
  return { images, skipped }
}

/** 工作表名（workbook.xml 的 sheet 顺序）与 sheetN.xml 的对应关系。 */
function readOoxmlSheetNames(entries: Map<string, Buffer>): Map<string, string> {
  const names = new Map<string, string>()
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const sheetOrder = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeXml(match[1] ?? ''))
  sheetOrder.forEach((name, index) => names.set(`xl/worksheets/sheet${index + 1}.xml`, name))
  return names
}

function readOoxmlAnchors(entries: Map<string, Buffer>, sheetNames: Map<string, string>, media: string[]): Map<string, string[]> {
  const rowsByMedia = new Map<string, string[]>()
  const mediaByPath = new Map(media.map((path) => [path, path]))
  for (const [sheetPath, sheetName] of sheetNames) {
    // 工作表 → 绘图：xl/worksheets/_rels/sheetN.xml.rels
    const relsPath = `xl/worksheets/_rels/${sheetPath.split('/').pop()}.rels`
    const rels = entries.get(relsPath)?.toString('utf8') ?? ''
    const drawingTarget = [...rels.matchAll(/Target="([^"]*drawing[^"]*)"/g)]
      .map((match) => resolveZipPath('xl/worksheets', decodeXml(match[1] ?? '')))
      .find((path) => entries.has(path))
    if (!drawingTarget) continue

    const drawingRels = entries.get(`xl/drawings/_rels/${drawingTarget.split('/').pop()}.rels`)?.toString('utf8') ?? ''
    const mediaById = new Map<string, string>()
    for (const match of drawingRels.matchAll(/Id="([^"]*)"[^>]*Target="([^"]*)"/g)) {
      const target = resolveZipPath('xl/drawings', decodeXml(match[2] ?? ''))
      if (mediaByPath.has(target)) mediaById.set(match[1] ?? '', target)
    }

    const drawing = entries.get(drawingTarget)?.toString('utf8') ?? ''
    for (const anchor of drawing.matchAll(/<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>|<xdr:twoCellAnchor\b[^>]*\/>/g)) {
      const block = anchor[0]
      const embed = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(block)?.[1]
      if (!embed) continue
      const target = mediaById.get(embed)
      if (!target) continue
      const row = Number(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(block)?.[1] ?? '-1')
      const list = rowsByMedia.get(target) ?? []
      list.push(row >= 0 ? `${sheetName} 第 ${row + 1} 行` : sheetName)
      rowsByMedia.set(target, list)
    }
  }
  return rowsByMedia
}

function resolveZipPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = `${base}/${target}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return resolved.join('/')
}

/**
 * 只要 ZIP 中央目录里未加密的条目。与 document-extractor 的 readZip 保持同一套
 * 限制，只是不抛错：图片读不出来不该让整个文件解析失败。
 */
function readZipEntries(bytes: Buffer): Map<string, Buffer> | null {
  const entries = new Map<string, Buffer>()
  // 中央目录结束记录：从尾部向前找 0x06054b50。
  let eocd = -1
  for (let position = bytes.length - 22; position >= 0 && position >= bytes.length - 65_557; position -= 1) {
    if (bytes.readUInt32LE(position) === 0x06054b50) {
      eocd = position
      break
    }
  }
  if (eocd < 0) return null
  const entryCount = Math.min(bytes.readUInt16LE(eocd + 10), 4_096)
  let offset = bytes.readUInt32LE(eocd + 16)
  // 与 document-extractor 的 readZip 同一量级的总量约束：图片读取不能变成解压炸弹。
  let inflatedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return null
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (method !== 0 && method !== 8) continue
    // 绘图 XML 与 rels 也要读：图片和它在表格里的位置分处不同条目。
    const limit = name.startsWith('xl/media/') ? maxImageBytes : 4 * 1024 * 1024
    if (uncompressedSize > limit || localOffset + 30 > bytes.length) continue
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > bytes.length) continue
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) {
      inflatedBytes += raw.length
      if (inflatedBytes > maxZipTotalBytes) return entries.size ? entries : null
      entries.set(name, raw)
      continue
    }
    try {
      const inflated = inflateRawSync(raw, { maxOutputLength: limit })
      inflatedBytes += inflated.length
      if (inflatedBytes > maxZipTotalBytes) return entries.size ? entries : null
      entries.set(name, inflated)
    } catch {
      continue
    }
  }
  return entries.size ? entries : null
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}
