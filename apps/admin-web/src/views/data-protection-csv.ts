export interface ParsedTerm {
  value: string
  caseSensitive: boolean
  wholeWord: boolean
}

function parseLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') quoted = false
      else current += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      cells.push(current)
      current = ''
    } else current += char
  }
  cells.push(current)
  return cells.map(cell => cell.trim())
}

const truthy = (value: string | undefined) => ['是', 'true', '1', 'yes', 'y'].includes((value ?? '').toLowerCase())

/** Excel 另存的中文 CSV 常是 GBK：先按 UTF-8 严格解码，失败再按 GB18030（兼容 GBK）。 */
export function decodeCsv(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
}

/** 每行一个词条，第二、三列可选（区分大小写、整词匹配）。首行是表头时跳过。 */
export function parseTermsCsv(text: string): ParsedTerm[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).filter(line => line.trim())
  if (lines.length && /^(词条|value|term)$/i.test(parseLine(lines[0]!)[0] ?? '')) lines.shift()
  return lines.map(parseLine).filter(cells => cells[0]).map(cells => ({
    value: cells[0]!, caseSensitive: truthy(cells[1]), wholeWord: truthy(cells[2]),
  }))
}
