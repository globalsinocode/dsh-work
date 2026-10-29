import { crc32, deflateSync } from 'node:zlib'

/**
 * Test-only builders for Office files: a minimal stored-entry ZIP writer and the smallest
 * packages the artifact policy accepts. Never used by production code.
 */
/** Minimal ZIP writer (stored entries) for building OOXML fixtures. */
export function zip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'

export function minimalXlsx(extra: Record<string, string | Buffer> = {}): Buffer {
  return zip({ '[Content_Types].xml': CONTENT_TYPES, 'xl/workbook.xml': '<workbook/>', ...extra })
}

export function minimalDocx(extra: Record<string, string | Buffer> = {}): Buffer {
  return zip({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': '<w:document><w:body/></w:document>', ...extra })
}

export function minimalPptx(extra: Record<string, string | Buffer> = {}): Buffer {
  return zip({ '[Content_Types].xml': CONTENT_TYPES, 'ppt/presentation.xml': '<p:presentation/>', ...extra })
}

/** A real PNG image (a small bar chart) that browsers can display; `zip` above is for OOXML only. */
export function minimalPng(): Buffer {
  const width = 120
  const height = 64
  const bars = [[10, 36], [36, 28], [62, 20], [88, 8]]
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      const bar = bars.find(([left, top]) => x >= left! && x < left! + 18 && y >= top! && y < height - 4)
      const [r, g, b] = bar ? (bar[0] === 88 ? [53, 104, 88] : [143, 184, 166]) : [255, 255, 255]
      raw.set([r!, g!, b!], row + 1 + x * 3)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
