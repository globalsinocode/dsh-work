import { describe, expect, it } from 'vitest'

import type { PersonalFile } from '@/types/domain'
import { CSV_PREVIEW_MAX_ROWS, artifactPreview, parseArtifactText, parseCsvPreview, personalFilePreview, renderMarkdownPreview, unavailableTextNote } from './artifact-preview'

describe('renderMarkdownPreview', () => {
  it('渲染标题、列表、表格、代码块，并把 HTML 显示成文字', () => {
    const html = renderMarkdownPreview([
      '# 周报',
      '',
      '- 要点',
      '',
      '| 列 |',
      '| --- |',
      '| 值 |',
      '',
      '```',
      '<b>代码</b>',
      '```',
      '',
      '<script>alert(1)</script>',
    ].join('\n'))

    expect(html).toContain('<h1>周报</h1>')
    expect(html).toContain('<li>要点</li>')
    expect(html).toContain('>值</td>')
    expect(html).toContain('<code>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
  })

  it('渲染引用块与分隔线', () => {
    const html = renderMarkdownPreview([
      '> 这是说明文字',
      '',
      '正文段落',
      '',
      '---',
      '',
      '下文',
    ].join('\n'))

    expect(html).toContain('<blockquote>')
    expect(html).toContain('这是说明文字')
    expect(html).toContain('<hr>')
    expect(html).toContain('<p>正文段落</p>')
    expect(html).toContain('<p>下文</p>')
  })

  it('渲染加粗与行内代码', () => {
    const html = renderMarkdownPreview('这是**重点**和`变量名`说明')

    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code class="md-inline-code">变量名</code>')
  })

  it('渲染含反引号的行内代码，不泄漏分隔符', () => {
    const html = renderMarkdownPreview(
      '命令写作 `` `git switch dev` ``，也可以写成 `pnpm test:e2e`。',
    )

    expect(html).toContain('<code class="md-inline-code">`git switch dev`</code>')
    expect(html).toContain('<code class="md-inline-code">pnpm test:e2e</code>')
    expect(html).not.toMatch(/<code[^>]*>[^<]*``/)
    expect(html).not.toContain('``')
  })

  it('两个反引号包裹单个反引号', () => {
    const html = renderMarkdownPreview('符号 `` ` `` 示例')

    expect(html).toContain('<code class="md-inline-code">`</code>')
    expect(html).not.toContain('``')
  })

  it('渲染嵌套引用块', () => {
    const html = renderMarkdownPreview([
      '> 外层说明',
      '> > 嵌套引用：来自 main 的改动先落到 dev。',
    ].join('\n'))

    expect(html).toContain('<blockquote><p>外层说明</p><blockquote>')
    expect(html).toContain('嵌套引用：来自 main 的改动先落到 dev。')
  })

  it('渲染缩进二级无序列表', () => {
    const html = renderMarkdownPreview(['- 一级', '  - 二级'].join('\n'))

    expect(html).toContain('<ul><li>一级<ul><li>二级</li></ul></li></ul>')
  })

  it('渲染斜体、删除线与任务清单', () => {
    const html = renderMarkdownPreview([
      '*斜体*与~~删除线~~',
      '',
      '- [x] 已完成',
      '- [ ] 待办',
    ].join('\n'))

    expect(html).toContain('<em>斜体</em>')
    expect(html).toContain('<del>删除线</del>')
    expect(html).toContain('md-task-item--done')
    expect(html).toContain('md-task-item--open')
    expect(html).toContain('md-task-badge')
    expect(html).toContain('已完成')
    expect(html).toContain('待办')
    expect(html).not.toContain('md-task-checkbox')
  })

  it('渲染行内与块级数学公式', () => {
    const html = renderMarkdownPreview([
      '能量 $E = mc^2$。',
      '',
      '$$',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '$$',
    ].join('\n'))

    expect(html).toContain('class="katex"')
    expect(html).toContain('md-math-block')
  })

  it('只保留 http(s) 与 mailto 链接，图片只留替代文字', () => {
    const html = renderMarkdownPreview([
      '[文档](https://example.com/a)',
      '[危险](javascript:alert(1))',
      '![风险图](https://example.com/a.png)',
    ].join('\n'))

    expect(html).toContain('href="https://example.com/a"')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('风险图')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('example.com/a.png')
  })
})

describe('parseCsvPreview', () => {
  it('首行作表头，数据行超过 500 时截断', () => {
    const lines = ['名称,数量']
    for (let index = 1; index <= CSV_PREVIEW_MAX_ROWS + 1; index += 1) lines.push(`行${index},${index}`)
    const preview = parseCsvPreview(lines.join('\n'))

    expect(preview.headers).toEqual(['名称', '数量'])
    expect(preview.rows).toHaveLength(500)
    expect(preview.rows[0]).toEqual(['行1', '1'])
    expect(preview.rows.at(-1)).toEqual(['行500', '500'])
    expect(preview.truncated).toBe(true)
  })

  it('保留引号内的逗号，空文件不是失败', () => {
    expect(parseCsvPreview('"华东,区",1\n')).toEqual({
      headers: ['华东,区', '1'],
      rows: [],
      truncated: false,
    })
    expect(parseCsvPreview('')).toEqual({ headers: [], rows: [], truncated: false })
  })
})

describe('parseArtifactText (2b-5)', () => {
  it('turns spreadsheet sections into sheets with a header row', () => {
    const parsed = parseArtifactText('xlsx', '# XLSX 文件摘要\n工作表：2；数据行：3\n\n## 营收\n区域\t收入\n华东\t1200\n合计\t=SUM(B2:B2)\n\n## 空表')
    expect(parsed).toEqual({
      kind: 'sheets',
      sheets: [
        { name: '营收', header: ['区域', '收入'], rows: [['华东', '1200'], ['合计', '=SUM(B2:B2)']] },
        { name: '空表', header: [], rows: [] },
      ],
    })
  })

  it('lists deck slides with their notes', () => {
    const parsed = parseArtifactText('pptx', '# PPTX 文件摘要\n幻灯片：2\n\n## 第 1 页\n经营概览\n收入 1200 万元\n备注：先讲增长\n\n## 第 2 页\n下季度重点')
    expect(parsed).toEqual({
      kind: 'slides',
      slides: [
        { no: 1, lines: ['经营概览', '收入 1200 万元'], notes: ['先讲增长'] },
        { no: 2, lines: ['下季度重点'], notes: [] },
      ],
    })
  })

  it('shows documents, PDFs and text in any other shape as it is', () => {
    expect(parseArtifactText('docx', '季度报告\n区域\t收入')).toEqual({ kind: 'plain', text: '季度报告\n区域\t收入' })
    expect(parseArtifactText('xlsx', '没有工作表标题的文本')).toEqual({ kind: 'plain', text: '没有工作表标题的文本' })
  })
})

describe('artifactPreview (2b-5)', () => {
  it('previews HTML in the sandbox, images directly and Office/PDF only once their text exists', () => {
    expect(artifactPreview({ type: 'html' })).toEqual({ kind: 'html' })
    expect(artifactPreview({ type: 'png' })).toEqual({ kind: 'image' })
    expect(artifactPreview({ type: 'jpg' })).toEqual({ kind: 'image' })
    expect(artifactPreview({ type: 'xlsx', textPreview: 'available' })).toEqual({ kind: 'text' })
    expect(artifactPreview({ type: 'pdf', textPreview: 'failed', textPreviewError: 'PDF 无法读取' })).toEqual({ kind: null, note: '无法预览：PDF 无法读取' })
    expect(artifactPreview({ type: 'docx', textPreview: 'pending' })).toEqual({ kind: null, note: '正文暂未生成' })
    expect(artifactPreview({ type: 'markdown' })).toEqual({ kind: null })
  })

  it('explains in the conversation why there is no body to view', () => {
    expect(unavailableTextNote({ textPreview: 'failed', textPreviewError: 'PDF 无法读取' })).toBe('无法生成正文：PDF 无法读取，请下载查看')
    expect(unavailableTextNote({ textPreview: 'failed' })).toBe('无法生成正文：文件解析失败，请下载查看')
    expect(unavailableTextNote({ textPreview: 'pending' })).toBe('正文暂未生成，请稍后再看或下载查看')
  })
})

describe('personalFilePreview (2b-5)', () => {
  const file = (overrides: Partial<PersonalFile>): PersonalFile => ({
    id: 'file-1', name: '营收.xlsx', type: 'XLSX', size: '18 KB', createdAt: '10-27', source: 'artifact',
    sessionId: 's-1', sourceSessionState: 'active', artifactId: 'artifact-1', version: 2,
    scanStatus: 'clean', parseStatus: 'succeeded', canDownload: true, canReference: true, removable: true,
    ...overrides,
  })

  it('offers a preview for generated Office files with text and for images', () => {
    expect(personalFilePreview(file({}))).toEqual({ id: 'artifact-1', version: 2, name: '营收.xlsx', type: 'xlsx' })
    expect(personalFilePreview(file({ name: '图.jpeg', type: 'JPEG', parseStatus: 'not_parsed' }))).toEqual({ id: 'artifact-1', version: 2, name: '图.jpeg', type: 'jpg' })
  })

  it('offers none for uploads, failed extractions, unscanned files or other types', () => {
    expect(personalFilePreview(file({ source: 'attachment', artifactId: null, version: null }))).toBeNull()
    expect(personalFilePreview(file({ parseStatus: 'failed' }))).toBeNull()
    expect(personalFilePreview(file({ scanStatus: 'pending' }))).toBeNull()
    expect(personalFilePreview(file({ name: '纪要.md', type: 'MD' }))).toBeNull()
  })
})
