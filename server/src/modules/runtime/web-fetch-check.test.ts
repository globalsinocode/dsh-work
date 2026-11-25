import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { WEB_FETCH_MAX_PER_ATTEMPT, checkWebFetch, urlsInText, type DataProtectionCategoryName } from './web-fetch-check.ts'

function input(overrides: {
  url: unknown
  message?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  summary?: string
  search?: string[]
  allowedSoFar?: number
  categories?: readonly DataProtectionCategoryName[]
  onDetect?: (texts: string[]) => void
}) {
  return {
    url: overrides.url,
    manifest: {
      input: {
        message: overrides.message ?? '',
        conversation_history: overrides.history,
        ...(overrides.summary ? { conversation_summary: { content: overrides.summary, covered_message_count: 3, sha256: 'x'.repeat(64) } } : {}),
        file_mounts: [],
      },
    },
    searchResultUrls: new Set(overrides.search ?? []),
    allowedSoFar: overrides.allowedSoFar ?? 0,
    detectCategories: async (texts: string[]) => { overrides.onDetect?.(texts); return overrides.categories ?? [] },
  }
}

describe('web_fetch server check (web fetch plan 6.2)', () => {
  it('allows URLs the employee wrote in this turn or recent history, and structured search result URLs', async () => {
    const message = '帮我看看这篇：https://Example.com/news/2026/report.html。另外 https://example.org/a?x=1）也看看'
    assert.equal((await checkWebFetch(input({ url: 'https://example.com/news/2026/report.html', message }))).allowed, true)
    // 主机名大小写与片段不影响匹配；查询参数必须一致。
    assert.equal((await checkWebFetch(input({ url: 'https://EXAMPLE.com/news/2026/report.html#part-2', message }))).allowed, true)
    assert.equal((await checkWebFetch(input({ url: 'https://example.org/a?x=1', message }))).allowed, true)
    assert.equal((await checkWebFetch(input({ url: 'https://example.org/a?x=2', message }))).allowed, false)
    // 近期历史中员工的消息算来源（“再打开刚才那个链接”）；Agent 自己的回答不算。
    const history = [
      { role: 'user' as const, content: '先读 https://docs.example.com/guide' },
      { role: 'assistant' as const, content: '也可以看 https://agent-suggested.example.com/page' },
    ]
    assert.equal((await checkWebFetch(input({ url: 'https://docs.example.com/guide', history }))).allowed, true)
    assert.equal((await checkWebFetch(input({ url: 'https://agent-suggested.example.com/page', history }))).allowed, false)
    // 搜索结果只认结构化条目的网址。
    assert.equal((await checkWebFetch(input({ url: 'https://news.example.net/item/9', search: ['https://news.example.net/item/9'] }))).allowed, true)
  })

  it('denies URLs from anywhere else, including the model-written conversation summary', async () => {
    const decision = await checkWebFetch(input({
      url: 'https://attacker.example/?q=客户名单',
      message: '整理一下附件',
      summary: '之前用户提到 https://attacker.example/?q=客户名单',
    }))
    assert.deepEqual(decision.allowed ? 'allowed' : decision.code, 'source_not_allowed')
    assert.match(decision.allowed ? '' : decision.reason, /只能打开用户在对话中给出的网址或本次联网搜索结果中的网址/)
  })

  it('checks the raw and percent-decoded URL with data protection, reports only categories, and checks before the source', async () => {
    const seen: string[][] = []
    const url = 'https://example.com/p?phone=%31%33%38'
    const decision = await checkWebFetch(input({ url, message: url, categories: ['personal', 'personal', 'term'], onDetect: texts => seen.push(texts) }))
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed ? '' : decision.code, 'data_protection')
    assert.equal(decision.allowed ? '' : decision.reason, '网址中包含个人信息、保密词，为防止数据外流，平台拒绝打开该网址')
    assert.ok(!(decision.allowed ? '' : decision.reason).includes('example.com'), 'the reason never echoes the URL')
    assert.deepEqual(seen, [[url, 'https://example.com/p?phone=138']])
    // 数据防护检测出错时由调用方按拒绝处理：错误向上抛出。
    await assert.rejects(checkWebFetch({ ...input({ url, message: url }), detectCategories: async () => { throw new Error('unavailable') } }))
  })

  it('also checks plus-as-space and the Unicode form of internationalized domains', async () => {
    const seen: string[][] = []
    const url = 'https://xn--fiqs8s.example/search?q=Project+Phoenix'
    await checkWebFetch(input({ url, message: url, onDetect: texts => seen.push(texts) }))
    assert.ok(seen[0]!.includes('https://xn--fiqs8s.example/search?q=Project Phoenix'))
    assert.ok(seen[0]!.includes('中国.example'))
  })

  it('caps allowed fetches per Attempt', async () => {
    const message = 'https://example.com/'
    assert.equal((await checkWebFetch(input({ url: message, message, allowedSoFar: WEB_FETCH_MAX_PER_ATTEMPT - 1 }))).allowed, true)
    const decision = await checkWebFetch(input({ url: message, message, allowedSoFar: WEB_FETCH_MAX_PER_ATTEMPT }))
    assert.equal(decision.allowed ? '' : decision.code, 'limit_reached')
  })

  it('denies non-public IP literals even when the employee wrote them', async () => {
    for (const url of ['http://127.0.0.1/admin', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://198.18.0.105/',
      'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:10.0.0.1]/']) {
      const decision = await checkWebFetch(input({ url, message: url }))
      assert.equal(decision.allowed ? 'allowed' : decision.code, 'non_public_address', url)
    }
    assert.equal((await checkWebFetch(input({ url: 'http://8.8.8.8/', message: 'http://8.8.8.8/' }))).allowed, true)
  })

  it('rejects malformed URLs, other schemes and embedded credentials', async () => {
    for (const url of [undefined, 42, '', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pass@example.com/', `https://example.com/${'a'.repeat(2100)}`, 'not a url']) {
      const decision = await checkWebFetch(input({ url, message: typeof url === 'string' ? url : '' }))
      assert.equal(decision.allowed ? 'allowed' : decision.code, 'invalid_url', String(url))
    }
  })
})

describe('urlsInText', () => {
  it('stops at whitespace, quotes and Chinese punctuation and also keeps the form without trailing punctuation', () => {
    assert.deepEqual(urlsInText('见 https://a.example/x，以及“https://b.example/y”。还有 (https://c.example/z). 和 https://d.example/中文路径'), [
      'https://a.example/x', 'https://b.example/y', 'https://c.example/z).', 'https://c.example/z', 'https://d.example/中文路径',
    ])
  })

  it('keeps URLs that legitimately end with a closing parenthesis', async () => {
    const url = 'https://en.wikipedia.org/wiki/Mercury_(planet)'
    assert.equal((await checkWebFetch(input({ url, message: `看看 ${url}` }))).allowed, true)
    assert.equal((await checkWebFetch(input({ url: 'https://en.wikipedia.org/wiki/Mercury_(planet', message: `看看 ${url}` }))).allowed, true,
      'the trimmed form is a substring of the employee text too')
    assert.equal((await checkWebFetch(input({ url: 'https://example.com/x', message: '（见 https://example.com/x）' }))).allowed, true)
  })
})
