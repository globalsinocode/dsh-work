export const CSV_PREVIEW_MAX_ROWS = 500

export interface CsvPreview {
  headers: string[]
  rows: string[][]
  truncated: boolean
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function safeHref(url: string) {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed
  return null
}

function renderInlineMarkdown(line: string) {
  let result = ''
  let index = 0
  while (index < line.length) {
    const image = line.slice(index).match(/^!\[([^\]]*)\]\(([^)]*)\)/)
    if (image && image.index === 0) {
      result += escapeHtml(image[1] ?? '')
      index += image[0].length
      continue
    }
    const link = line.slice(index).match(/^\[([^\]]*)\]\(([^)]*)\)/)
    if (link && link.index === 0) {
      const href = safeHref(link[2] ?? '')
      const label = escapeHtml(link[1] ?? '')
      result += href
        ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`
        : label
      index += link[0].length
      continue
    }
    result += escapeHtml(line[index] ?? '')
    index += 1
  }
  return result
}

function isTableSeparator(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function parseTableRow(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const parts = trimmed.split('|')
  return parts.slice(1, parts.length - (trimmed.endsWith('|') ? 1 : 0)).map(cell => cell.trim())
}

export function renderMarkdownPreview(source: string): string {
  if (!source) return ''
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''

    const fence = line.match(/^```/)
    if (fence) {
      const codeLines: string[] = []
      lineIndex += 1
      while (lineIndex < lines.length && !/^```/.test(lines[lineIndex] ?? '')) {
        codeLines.push(lines[lineIndex] ?? '')
        lineIndex += 1
      }
      if (lineIndex < lines.length) lineIndex += 1
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]?.length ?? 1
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? '')}</h${level}>`)
      lineIndex += 1
      continue
    }

    const tableHeader = parseTableRow(line)
    const nextLine = lines[lineIndex + 1] ?? ''
    if (tableHeader && isTableSeparator(nextLine)) {
      const headerCells = tableHeader
      lineIndex += 2
      const bodyRows: string[][] = []
      while (lineIndex < lines.length) {
        const row = parseTableRow(lines[lineIndex] ?? '')
        if (!row) break
        bodyRows.push(row)
        lineIndex += 1
      }
      const thead = `<tr>${headerCells.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr>`
      const tbody = bodyRows
        .map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('')
      blocks.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`)
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (lineIndex < lines.length && /^[-*]\s+/.test(lines[lineIndex] ?? '')) {
        items.push((lines[lineIndex] ?? '').replace(/^[-*]\s+/, ''))
        lineIndex += 1
      }
      blocks.push(`<ul>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`)
      continue
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (lineIndex < lines.length && /^\d+\.\s+/.test(lines[lineIndex] ?? '')) {
        items.push((lines[lineIndex] ?? '').replace(/^\d+\.\s+/, ''))
        lineIndex += 1
      }
      blocks.push(`<ol>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`)
      continue
    }

    if (!line.trim()) {
      lineIndex += 1
      continue
    }

    const paragraphLines: string[] = []
    while (lineIndex < lines.length && (lines[lineIndex] ?? '').trim()) {
      paragraphLines.push(lines[lineIndex] ?? '')
      lineIndex += 1
    }
    blocks.push(`<p>${paragraphLines.map(part => renderInlineMarkdown(part)).join('<br>')}</p>`)
  }

  return blocks.join('')
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
