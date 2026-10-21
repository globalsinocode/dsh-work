import { renderMathBlock, renderMathInline } from './render-math'

export function escapeHtml(value: string) {
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

function externalAnchor(href: string, label: string, title?: string) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`
}

type LinkDefinition = { href: string; title?: string }

function extractDocumentParts(source: string) {
  const links: Record<string, LinkDefinition> = {}
  const footnotes: Record<string, string> = {}
  const bodyLines: string[] = []
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const linkDef = line.match(/^\[([^\]]+)\]:\s+(\S+)(?:\s+"([^"]*)")?\s*$/)
    if (linkDef) {
      links[linkDef[1]!] = { href: linkDef[2]!, title: linkDef[3] }
      continue
    }
    const footnoteDef = line.match(/^\[\^([^\]]+)\]:\s+(.+)$/)
    if (footnoteDef) {
      footnotes[footnoteDef[1]!] = footnoteDef[2]!
      continue
    }
    bodyLines.push(line)
  }
  return { body: bodyLines.join('\n'), links, footnotes }
}

/** CommonMark 行内代码：开闭反引号数量相同，内容可含更短的反引号串。 */
function matchInlineCode(rest: string): { content: string; length: number } | null {
  if (!rest.startsWith('`')) return null
  let openLen = 0
  while (rest[openLen] === '`') openLen += 1
  let pos = openLen
  while (pos < rest.length) {
    if (rest[pos] !== '`') {
      pos += 1
      continue
    }
    let closeLen = 0
    while (rest[pos + closeLen] === '`') closeLen += 1
    if (closeLen === openLen) {
      let content = rest.slice(openLen, pos)
      if (
        content.length >= 2
        && content.startsWith(' ')
        && content.endsWith(' ')
        && /[^`]/.test(content)
      ) {
        content = content.slice(1, -1)
      }
      return { content, length: pos + closeLen }
    }
    pos += closeLen
  }
  return null
}

function renderBlockquoteBody(
  lines: string[],
  context: { links: Record<string, LinkDefinition> },
): string {
  const blocks: string[] = []
  let lineIndex = 0
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''
    if (!line.trim()) {
      lineIndex += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const nestedLines: string[] = []
      while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex] ?? '')) {
        nestedLines.push((lines[lineIndex] ?? '').replace(/^>\s?/, ''))
        lineIndex += 1
      }
      blocks.push(`<blockquote>${renderBlockquoteBody(nestedLines, context)}</blockquote>`)
      continue
    }
    const paragraphLines: string[] = []
    while (lineIndex < lines.length) {
      const candidate = lines[lineIndex] ?? ''
      if (!candidate.trim()) break
      if (/^>\s?/.test(candidate)) break
      if (/^(#{1,6})\s+/.test(candidate)) break
      if (isHorizontalRule(candidate)) break
      paragraphLines.push(candidate)
      lineIndex += 1
    }
    if (paragraphLines.length) {
      blocks.push(
        `<p>${paragraphLines.map(part => renderInlineMarkdown(part, context)).join('<br>')}</p>`,
      )
    }
  }
  return blocks.join('')
}

function renderInlineMarkdown(
  line: string,
  context: { links: Record<string, LinkDefinition> },
) {
  let result = ''
  let index = 0
  while (index < line.length) {
    const rest = line.slice(index)
    if (rest.startsWith('\\')) {
      result += escapeHtml(rest[1] ?? '')
      index += 2
      continue
    }
    const image = rest.match(/^!\[([^\]]*)\]\(([^)]*)\)/)
    if (image) {
      result += escapeHtml(image[1] ?? '')
      index += image[0].length
      continue
    }
    const link = rest.match(/^\[([^\]]*)\]\(([^)]*)\)/)
    if (link) {
      const href = safeHref(link[2] ?? '')
      const label = escapeHtml(link[1] ?? '')
      result += href ? externalAnchor(href, label) : label
      index += link[0].length
      continue
    }
    const refLink = rest.match(/^\[([^\]]+)\]\[([^\]]*)\]/)
    if (refLink) {
      const label = refLink[1] ?? ''
      const key = refLink[2] ?? label
      const def = context.links[key]
      const href = def ? safeHref(def.href) : null
      const escapedLabel = escapeHtml(label)
      result += href ? externalAnchor(href, escapedLabel, def?.title) : escapedLabel
      index += refLink[0].length
      continue
    }
    const footnoteRef = rest.match(/^\[\^([^\]]+)\]/)
    if (footnoteRef) {
      const id = footnoteRef[1] ?? ''
      const label = /^\d+$/.test(id) ? `[${id}]` : id
      result += `<sup class="md-footnote-ref"><a href="#fn-${escapeHtml(id)}" id="fnref-${escapeHtml(id)}" title="脚注">${escapeHtml(label)}</a></sup>`
      index += footnoteRef[0].length
      continue
    }
    const inlineMath = rest.match(/^\$([^$\n]+?)\$/)
    if (inlineMath && !rest.startsWith('$$')) {
      result += renderMathInline(inlineMath[1] ?? '')
      index += inlineMath[0].length
      continue
    }
    const kbd = rest.match(/^<kbd>([^<]*)<\/kbd>/i)
    if (kbd) {
      result += `<kbd class="md-kbd">${escapeHtml(kbd[1] ?? '')}</kbd>`
      index += kbd[0].length
      continue
    }
    const autolink = rest.match(/^<(https?:\/\/[^>\s]+)>/i)
    if (autolink) {
      const href = safeHref(autolink[1] ?? '')
      if (href) {
        result += externalAnchor(href, escapeHtml(href))
      } else {
        result += escapeHtml(autolink[0])
      }
      index += autolink[0].length
      continue
    }
    const bareUrl = rest.match(/^https?:\/\/[^\s<>"']+/)
    if (bareUrl) {
      const href = safeHref(bareUrl[0])
      if (href) {
        result += externalAnchor(href, escapeHtml(href))
        index += bareUrl[0].length
        continue
      }
    }
    const boldItalic = rest.match(/^\*\*\*([^*\n]+)\*\*\*/)
    if (boldItalic) {
      result += `<strong><em>${escapeHtml(boldItalic[1] ?? '')}</em></strong>`
      index += boldItalic[0].length
      continue
    }
    const bold = rest.match(/^\*\*([^*\n]+)\*\*/)
    if (bold) {
      result += `<strong>${escapeHtml(bold[1] ?? '')}</strong>`
      index += bold[0].length
      continue
    }
    const strike = rest.match(/^~~([^~\n]+)~~/)
    if (strike) {
      result += `<del>${escapeHtml(strike[1] ?? '')}</del>`
      index += strike[0].length
      continue
    }
    const italic = rest.match(/^\*([^*\n]+)\*/)
    if (italic) {
      result += `<em>${escapeHtml(italic[1] ?? '')}</em>`
      index += italic[0].length
      continue
    }
    const italicUnderscore = rest.match(/^_([^_\n]+)_/)
    if (italicUnderscore) {
      result += `<em>${escapeHtml(italicUnderscore[1] ?? '')}</em>`
      index += italicUnderscore[0].length
      continue
    }
    const inlineCode = matchInlineCode(rest)
    if (inlineCode) {
      result += `<code class="md-inline-code">${escapeHtml(inlineCode.content)}</code>`
      index += inlineCode.length
      continue
    }
    result += escapeHtml(line[index] ?? '')
    index += 1
  }
  return result
}

interface MarkdownListItem {
  text: string
  checked: boolean | null
  children: MarkdownListBlock[]
}

interface MarkdownListBlock {
  type: 'ul' | 'ol'
  items: MarkdownListItem[]
}

function listLine(line: string): { indent: number; type: 'ul' | 'ol'; checked: boolean | null; text: string } | null {
  const task = line.match(/^(\s*)([-*]|\d+\.)\s+\[([ xX])\]\s+(.+)$/)
  if (task) {
    const indent = (task[1] ?? '').replaceAll('\t', '  ').length
    const marker = task[2] ?? ''
    const type = /\d/.test(marker) ? 'ol' : 'ul'
    const checked = (task[3] ?? '').toLowerCase() === 'x'
    return { indent, type, checked, text: task[4] ?? '' }
  }
  const match = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/)
  if (!match) return null
  const indent = (match[1] ?? '').replaceAll('\t', '  ').length
  const marker = match[2] ?? ''
  const type = /\d/.test(marker) ? 'ol' : 'ul'
  return { indent, type, checked: null, text: match[3] ?? '' }
}

function parseMarkdownList(
  lines: string[],
  start: number,
  indent: number,
  type: 'ul' | 'ol',
): { block: MarkdownListBlock; next: number } {
  const items: MarkdownListItem[] = []
  let index = start
  while (index < lines.length) {
    const current = listLine(lines[index] ?? '')
    if (!current || current.indent < indent || (current.indent === indent && current.type !== type)) break
    if (current.indent > indent) {
      if (!items.length) break
      const child = parseMarkdownList(lines, index, current.indent, current.type)
      items.at(-1)!.children.push(child.block)
      index = child.next
      continue
    }
    items.push({ text: current.text, checked: current.checked, children: [] })
    index += 1
  }
  return { block: { type, items }, next: index }
}

function renderMarkdownList(
  block: MarkdownListBlock,
  context: { links: Record<string, LinkDefinition> },
): string {
  const tag = block.type
  const body = block.items
    .map(item => {
      const nested = item.children.map(child => renderMarkdownList(child, context)).join('')
      const inner = renderInlineMarkdown(item.text, context)
      if (item.checked === null) return `<li>${inner}${nested}</li>`
      const state = item.checked ? 'md-task-item--done' : 'md-task-item--open'
      const badge = item.checked ? '已完成' : '待办'
      return `<li class="md-task-item ${state}"><span class="md-task-badge">${badge}</span><span class="md-task-text">${inner}</span>${nested}</li>`
    })
    .join('')
  return `<${tag}>${body}</${tag}>`
}

function isTableSeparator(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  const cells = trimmed.split('|').slice(1, -1).map(cell => cell.trim())
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function parseTableRow(line: string) {
  const trimmed = line.trim()
  if (trimmed.includes('\t') && !trimmed.includes('|')) {
    return trimmed.split('\t').map(cell => cell.trim())
  }
  if (!trimmed.startsWith('|')) return null
  const parts = trimmed.split('|')
  return parts.slice(1, parts.length - (trimmed.endsWith('|') ? 1 : 0)).map(cell => cell.trim())
}

function tableAlignments(separatorCells: string[]) {
  return separatorCells.map((cell) => {
    const trimmed = cell.trim()
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
    if (trimmed.endsWith(':')) return 'right'
    return 'left'
  })
}

function isHorizontalRule(line: string) {
  const trimmed = line.trim()
  return /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)
}

function isIndentedCodeLine(line: string) {
  return /^ {4}|\t/.test(line)
}

function stripCodeIndent(line: string) {
  if (line.startsWith('\t')) return line.slice(1)
  return line.slice(4)
}

function parseTabTable(lines: string[], start: number): { headers: string[]; rows: string[][]; next: number } | null {
  const header = parseTableRow(lines[start] ?? '')
  if (!header || header.length < 2) return null
  const rows: string[][] = []
  let index = start + 1
  while (index < lines.length) {
    const row = parseTableRow(lines[index] ?? '')
    if (!row || row.length !== header.length) break
    rows.push(row)
    index += 1
  }
  if (!rows.length) return null
  return { headers: header, rows, next: index }
}

function renderFootnotes(footnotes: Record<string, string>, context: { links: Record<string, LinkDefinition> }) {
  const entries = Object.entries(footnotes)
  if (!entries.length) return ''
  const items = entries
    .map(([id, body]) => {
      const label = /^\d+$/.test(id) ? id : id
      return `<li id="fn-${escapeHtml(id)}"><span class="md-footnote-label">${escapeHtml(label)}.</span> ${renderInlineMarkdown(body, context)} <a href="#fnref-${escapeHtml(id)}" class="md-footnote-back" title="返回正文">↩</a></li>`
    })
    .join('')
  return `<section class="md-footnotes" aria-label="脚注"><h6 class="md-footnotes__title">脚注</h6><ol>${items}</ol></section>`
}

function parseDetailsBlock(lines: string[], start: number, context: { links: Record<string, LinkDefinition> }) {
  const first = (lines[start] ?? '').trim()
  if (!/^<details\b/i.test(first)) return null
  const collected: string[] = []
  let index = start
  while (index < lines.length) {
    collected.push(lines[index] ?? '')
    if (/<\/details>/i.test(lines[index] ?? '')) {
      index += 1
      break
    }
    index += 1
  }
  const raw = collected.join('\n')
  const summaryMatch = raw.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)
  const summaryHtml = summaryMatch
    ? renderInlineMarkdown(summaryMatch[1]!.replace(/\s+/g, ' ').trim(), context)
    : '展开'
  const inner = raw
    .replace(/^<details[^>]*>\s*/i, '')
    .replace(/<summary[^>]*>[\s\S]*?<\/summary>\s*/i, '')
    .replace(/<\/details>\s*$/i, '')
    .trim()
  const bodyHtml = inner ? renderMarkdownPreview(inner) : ''
  return {
    html: `<details class="md-details"><summary>${summaryHtml}</summary><div class="md-details__body">${bodyHtml}</div></details>`,
    next: index,
  }
}

function parseMathBlock(lines: string[], start: number) {
  const line = (lines[start] ?? '').trim()
  if (line === '$$') {
    const parts: string[] = []
    let index = start + 1
    while (index < lines.length && (lines[index] ?? '').trim() !== '$$') {
      parts.push(lines[index] ?? '')
      index += 1
    }
    if (index < lines.length) index += 1
    return { html: renderMathBlock(parts.join('\n')), next: index }
  }
  if (line.startsWith('$$') && line.endsWith('$$') && line.length > 4) {
    return { html: renderMathBlock(line.slice(2, -2)), next: start + 1 }
  }
  return null
}

export function renderMarkdownPreview(source: string): string {
  if (!source) return ''
  const { body, links, footnotes } = extractDocumentParts(source)
  const context = { links }
  const lines = body.split('\n')
  const blocks: string[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''

    const mathBlock = parseMathBlock(lines, lineIndex)
    if (mathBlock) {
      blocks.push(mathBlock.html)
      lineIndex = mathBlock.next
      continue
    }

    const detailsBlock = parseDetailsBlock(lines, lineIndex, context)
    if (detailsBlock) {
      blocks.push(detailsBlock.html)
      lineIndex = detailsBlock.next
      continue
    }

    const fence = line.match(/^```([\w.+-]*)\s*$/)
    if (fence) {
      const language = fence[1] ?? ''
      const codeLines: string[] = []
      lineIndex += 1
      while (lineIndex < lines.length && !/^```/.test(lines[lineIndex] ?? '')) {
        codeLines.push(lines[lineIndex] ?? '')
        lineIndex += 1
      }
      if (lineIndex < lines.length) lineIndex += 1
      const langClass = language ? ` class="language-${escapeHtml(language)}"` : ''
      blocks.push(`<pre><code${langClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    if (isIndentedCodeLine(line) && line.trim()) {
      const codeLines: string[] = []
      while (lineIndex < lines.length && isIndentedCodeLine(lines[lineIndex] ?? '') && (lines[lineIndex] ?? '').trim()) {
        codeLines.push(stripCodeIndent(lines[lineIndex] ?? ''))
        lineIndex += 1
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]?.length ?? 1
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? '', context)}</h${level}>`)
      lineIndex += 1
      continue
    }

    if (isHorizontalRule(line)) {
      blocks.push('<hr>')
      lineIndex += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex] ?? '')) {
        quoteLines.push((lines[lineIndex] ?? '').replace(/^>\s?/, ''))
        lineIndex += 1
      }
      blocks.push(`<blockquote>${renderBlockquoteBody(quoteLines, context)}</blockquote>`)
      continue
    }

    const tableHeader = parseTableRow(line)
    const nextLine = lines[lineIndex + 1] ?? ''
    if (tableHeader && isTableSeparator(nextLine)) {
      const headerCells = tableHeader
      const separatorCells = parseTableRow(nextLine) ?? []
      const alignments = tableAlignments(separatorCells)
      lineIndex += 2
      const bodyRows: string[][] = []
      while (lineIndex < lines.length) {
        const row = parseTableRow(lines[lineIndex] ?? '')
        if (!row) break
        bodyRows.push(row)
        lineIndex += 1
      }
      const thead = `<tr>${headerCells.map((cell, cellIndex) => {
        const align = alignments[cellIndex] ?? 'left'
        return `<th style="text-align:${align}">${renderInlineMarkdown(cell, context)}</th>`
      }).join('')}</tr>`
      const tbody = bodyRows
        .map(row => `<tr>${row.map((cell, cellIndex) => {
          const align = alignments[cellIndex] ?? 'left'
          return `<td style="text-align:${align}">${renderInlineMarkdown(cell, context)}</td>`
        }).join('')}</tr>`)
        .join('')
      blocks.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`)
      continue
    }

    const tabTable = parseTabTable(lines, lineIndex)
    if (tabTable) {
      const thead = `<tr>${tabTable.headers.map(cell => `<th>${renderInlineMarkdown(cell, context)}</th>`).join('')}</tr>`
      const tbody = tabTable.rows
        .map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell, context)}</td>`).join('')}</tr>`)
        .join('')
      blocks.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`)
      lineIndex = tabTable.next
      continue
    }

    const listStart = listLine(line)
    if (listStart) {
      const parsed = parseMarkdownList(lines, lineIndex, listStart.indent, listStart.type)
      blocks.push(renderMarkdownList(parsed.block, context))
      lineIndex = parsed.next
      continue
    }

    if (!line.trim()) {
      lineIndex += 1
      continue
    }

    const paragraphLines: string[] = []
    while (lineIndex < lines.length && (lines[lineIndex] ?? '').trim() && !listLine(lines[lineIndex] ?? '')) {
      const candidate = lines[lineIndex] ?? ''
      if (/^(#{1,6})\s+/.test(candidate) || isHorizontalRule(candidate) || /^>\s?/.test(candidate)) break
      if (/^<details\b/i.test(candidate.trim())) break
      if (candidate.trim() === '$$' || (candidate.trim().startsWith('$$') && candidate.trim().endsWith('$$'))) break
      if (isIndentedCodeLine(candidate)) break
      const maybeTable = parseTableRow(candidate)
      const maybeNext = lines[lineIndex + 1] ?? ''
      if (maybeTable && isTableSeparator(maybeNext)) break
      if (parseTabTable(lines, lineIndex)) break
      paragraphLines.push(candidate)
      lineIndex += 1
    }
    if (paragraphLines.length) {
      blocks.push(`<p>${paragraphLines.map(part => renderInlineMarkdown(part, context)).join('<br>')}</p>`)
    }
  }

  blocks.push(renderFootnotes(footnotes, context))
  return blocks.join('')
}
