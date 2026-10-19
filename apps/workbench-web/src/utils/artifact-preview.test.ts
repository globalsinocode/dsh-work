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
    expect(html).toContain('<td>值</td>')
    expect(html).toContain('<code>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
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
