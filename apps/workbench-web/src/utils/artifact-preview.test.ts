import { describe, expect, it } from 'vitest'

import { CSV_PREVIEW_MAX_ROWS, parseCsvPreview, renderMarkdownPreview } from './artifact-preview'

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
