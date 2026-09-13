<script setup lang="ts">
import { computed, defineComponent, Fragment, h, type PropType, type VNodeChild } from 'vue'

interface ListItem { text: string; children: ListBlock[] }
type ListBlock =
  | { type: 'unordered-list'; items: ListItem[] }
  | { type: 'ordered-list'; items: ListItem[] }
type TableAlignment = 'left' | 'center' | 'right'
interface TableBlock {
  type: 'table'
  headers: string[]
  alignments: TableAlignment[]
  rows: string[][]
}
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'code'; language: string; text: string }
  | TableBlock
  | ListBlock

const props = defineProps<{ text: string }>()
const blocks = computed(() => parseBlocks(props.text))

const InlineMarkdown = defineComponent({
  props: { text: { type: String as PropType<string>, required: true } },
  setup(inlineProps) {
    return () => h(Fragment, null, inlineNodes(inlineProps.text))
  },
})
const MarkdownList = defineComponent({
  props: { block: { type: Object as PropType<ListBlock>, required: true } },
  setup(listProps) {
    return () => renderList(listProps.block)
  },
})

function parseBlocks(value: string): Block[] {
  const result: Block[] = []
  const lines = value.replaceAll('\r\n', '\n').split('\n').map(line => line.trimEnd())
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.trim()) { index++; continue }
    const fence = line.trim().match(/^```([\w.+-]*)\s*$/)
    if (fence) {
      const codeLines: string[] = []
      const language = fence[1] ?? ''
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index]!.trim())) {
        codeLines.push(lines[index]!)
        index++
      }
      if (index < lines.length) index++
      result.push({ type: 'code', language, text: codeLines.join('\n') })
      continue
    }
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/)
    if (heading) {
      result.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! })
      index++
      continue
    }
    const table = parseTable(lines, index)
    if (table) {
      result.push(table.block)
      index = table.next
      continue
    }
    const list = listLine(line)
    if (list) {
      const parsed = parseList(lines, index, list.indent, list.type)
      result.push(parsed.block)
      index = parsed.next
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index]!
      if (!candidate.trim() || /^\s*(?:```|#{1,3}\s+|[-*]\s+|\d+[.)]\s+)/.test(candidate)) break
      paragraph.push(candidate.trim())
      index++
    }
    result.push({ type: 'paragraph', lines: paragraph })
  }
  return result
}

function parseTable(lines: string[], start: number): { block: TableBlock; next: number } | null {
  if (start + 1 >= lines.length || !hasTableSeparator(lines[start]!)) return null
  const headers = splitTableRow(lines[start]!)
  const delimiters = splitTableRow(lines[start + 1]!)
  if (!headers.length || headers.length !== delimiters.length || delimiters.some(cell => !/^:?-{3,}:?$/.test(cell))) return null

  const alignments = delimiters.map<TableAlignment>((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })
  const rows: string[][] = []
  let index = start + 2
  while (index < lines.length && lines[index]!.trim() && hasTableSeparator(lines[index]!)) {
    const cells = splitTableRow(lines[index]!)
    rows.push(headers.map((_, cellIndex) => cells[cellIndex] ?? ''))
    index++
  }
  return { block: { type: 'table', headers, alignments, rows }, next: index }
}

function hasTableSeparator(line: string) {
  let inCode = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '`' && line[index - 1] !== '\\') inCode = !inCode
    if (character === '|' && line[index - 1] !== '\\' && !inCode) return true
  }
  return false
}

function splitTableRow(line: string) {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character === '\\' && value[index + 1] === '|') {
      cell += '|'
      index++
      continue
    }
    if (character === '`') inCode = !inCode
    if (character === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  return cells
}

function listLine(line: string) {
  const match = line.match(/^(\s*)([-*]|\d+[.)])\s+(.+)$/)
  if (!match) return null
  return { indent: match[1]!.replaceAll('\t', '  ').length, type: (/\d/.test(match[2]!) ? 'ordered-list' : 'unordered-list') as ListBlock['type'], text: match[3]! }
}

function parseList(lines: string[], start: number, indent: number, type: ListBlock['type']): { block: ListBlock; next: number } {
  const items: ListItem[] = []
  let index = start
  while (index < lines.length) {
    const current = listLine(lines[index]!)
    if (!current || current.indent < indent || (current.indent === indent && current.type !== type)) break
    if (current.indent > indent) {
      if (!items.length) break
      const child = parseList(lines, index, current.indent, current.type)
      items.at(-1)!.children.push(child.block)
      index = child.next
      continue
    }
    items.push({ text: current.text, children: [] })
    index++
  }
  return { block: { type, items }, next: index }
}

function renderList(block: ListBlock): VNodeChild {
  return h(block.type === 'ordered-list' ? 'ol' : 'ul', block.items.map(item => h('li', [
    h(InlineMarkdown, { text: item.text }),
    ...item.children.map(child => renderList(child)),
  ])))
}

function inlineNodes(value: string): VNodeChild[] {
  const nodes: VNodeChild[] = []
  const token = /(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>"']+)/g
  let cursor = 0
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0
    if (index > cursor) nodes.push(value.slice(cursor, index))
    const text = match[0]
    if (text.startsWith('**')) nodes.push(h('strong', text.slice(2, -2)))
    else if (text.startsWith('`')) nodes.push(h('code', { class: 'assistant-inline-code' }, text.slice(1, -1)))
    else nodes.push(h('a', { href: text, target: '_blank', rel: 'noopener noreferrer' }, text))
    cursor = index + text.length
  }
  if (cursor < value.length) nodes.push(value.slice(cursor))
  return nodes
}
</script>

<template>
  <div class="assistant-message-content">
    <template v-for="(block, index) in blocks" :key="index">
      <h3 v-if="block.type === 'heading' && block.level === 1"><InlineMarkdown :text="block.text" /></h3>
      <h4 v-else-if="block.type === 'heading'"><InlineMarkdown :text="block.text" /></h4>
      <div v-else-if="block.type === 'code'" class="assistant-code-block">
        <span v-if="block.language">{{ block.language }}</span>
        <pre><code>{{ block.text }}</code></pre>
      </div>
      <div v-else-if="block.type === 'table'" class="assistant-table-wrap">
        <table>
          <thead>
            <tr>
              <th v-for="(header, cellIndex) in block.headers" :key="cellIndex" :style="{ textAlign: block.alignments[cellIndex] }"><InlineMarkdown :text="header" /></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <td v-for="(cell, cellIndex) in row" :key="cellIndex" :style="{ textAlign: block.alignments[cellIndex] }"><InlineMarkdown :text="cell" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <MarkdownList v-else-if="block.type === 'unordered-list' || block.type === 'ordered-list'" :block="block" />
      <p v-else><template v-for="(line, lineIndex) in block.lines" :key="lineIndex"><br v-if="lineIndex"><InlineMarkdown :text="line" /></template></p>
    </template>
  </div>
</template>

<style scoped>
.assistant-message-content { color: var(--dsh-color-text, var(--color-text-primary)); font-size: var(--dsh-font-size-body, var(--font-size-body)); line-height: 1.75; overflow-wrap: anywhere; }
.assistant-message-content > :first-child { margin-top: 0; }
.assistant-message-content > :last-child { margin-bottom: 0; }
.assistant-message-content p { margin: 8px 0; }
.assistant-message-content h3, .assistant-message-content h4 { margin: 18px 0 8px; color: var(--dsh-color-ink, var(--color-text-heading)); font-weight: 650; line-height: 1.45; }
.assistant-message-content h3 { font-size: var(--dsh-font-size-subheading, var(--font-size-title)); }
.assistant-message-content h4 { font-size: var(--dsh-font-size-title, var(--font-size-body)); }
.assistant-message-content ul, .assistant-message-content ol { margin: 8px 0; padding-left: 24px; }
.assistant-message-content li + li { margin-top: 5px; }
.assistant-message-content li::marker { color: var(--dsh-color-subtle, #98a2b3); }
.assistant-message-content :deep(.assistant-inline-code) { padding: 2px 6px; border-radius: var(--dsh-radius-sm, var(--radius-tag)); background: var(--dsh-color-canvas, var(--color-bg-page)); color: var(--dsh-color-brand, var(--color-primary)); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .92em; }
.assistant-message-content :deep(a) { color: var(--dsh-color-brand, var(--color-primary)); text-decoration: none; }
.assistant-message-content :deep(a:hover) { text-decoration: underline; }
.assistant-code-block { margin: 12px 0; overflow: hidden; border: 1px solid var(--dsh-color-border, #e4e8ef); border-radius: var(--dsh-radius-md, 12px); background: var(--dsh-color-canvas, #f3f5f8); }
.assistant-code-block > span { display: block; padding: 7px 12px; border-bottom: 1px solid var(--dsh-color-border, #e4e8ef); color: var(--dsh-color-muted, #667085); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: var(--dsh-font-size-micro, 11px); }
.assistant-code-block pre { margin: 0; padding: 12px 14px; overflow-x: auto; white-space: pre; }
.assistant-code-block code { color: var(--dsh-color-ink, #172033); background: transparent; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: var(--dsh-font-size-caption, 13px); line-height: 1.65; }
.assistant-table-wrap { margin: 12px 0; overflow-x: auto; border: 1px solid var(--dsh-color-border, #e4e8ef); border-radius: var(--dsh-radius-md, 12px); }
.assistant-table-wrap table { width: 100%; min-width: 480px; border-spacing: 0; border-collapse: separate; color: inherit; font-size: inherit; line-height: 1.55; }
.assistant-table-wrap th, .assistant-table-wrap td { padding: 10px 12px; border-right: 1px solid var(--dsh-color-border, #e4e8ef); border-bottom: 1px solid var(--dsh-color-border, #e4e8ef); vertical-align: top; }
.assistant-table-wrap th { color: var(--dsh-color-ink, #172033); background: var(--dsh-color-canvas, #f3f5f8); font-weight: 650; }
.assistant-table-wrap tr > :last-child { border-right: 0; }
.assistant-table-wrap tbody tr:last-child td { border-bottom: 0; }
</style>
