export const CSV_PREVIEW_MAX_ROWS = 500

export interface CsvPreview {
  headers: string[]
  rows: string[][]
  truncated: boolean
}

function parseCsvRecord(text: string, start: number): { fields: string[]; next: number } {
  const fields: string[] = []
  let index = start
  let field = ''
  let inQuotes = false

  while (index < text.length) {
    const char = text[index] ?? ''
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      fields.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      fields.push(field)
      if (char === '\r' && text[index + 1] === '\n') index += 2
      else index += 1
      return { fields, next: index }
    }
    field += char
    index += 1
  }

  fields.push(field)
  return { fields, next: index }
}

export function parseCsvPreview(source: string): CsvPreview {
  if (!source) return { headers: [], rows: [], truncated: false }

  const records: string[][] = []
  let index = 0
  while (index < source.length) {
    const { fields, next } = parseCsvRecord(source, index)
    if (fields.length === 1 && fields[0] === '' && next === index + 1) {
      index = next
      continue
    }
    records.push(fields)
    index = next
    if (index >= source.length) break
  }

  if (records.length === 0) return { headers: [], rows: [], truncated: false }

  const headers = records[0] ?? []
  const dataRows = records.slice(1)
  const truncated = dataRows.length > CSV_PREVIEW_MAX_ROWS
  const rows = dataRows.slice(0, CSV_PREVIEW_MAX_ROWS)

  return { headers, rows, truncated }
}
