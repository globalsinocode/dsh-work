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
