import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DataProtectionService, MemoryDataProtectionStore } from '../data-protection/data-protection-service.ts'
import { ModelGateway } from './model-gateway.ts'
import { MemoryModelGatewayRequestLog } from './model-gateway-request-log.ts'
import type { ModelGatewayBinding } from './model-gateway-types.ts'

const PHONE = '13812345678'
const binding = (trustLevel: 'internal' | 'external' = 'external'): ModelGatewayBinding => ({
  tenantId: 't', runId: 'r', attemptId: 'a',
  route: { routeId: 'x', providerKey: 'deepseek-official', modelKey: 'm1', baseUrl: 'https://api.deepseek.com', credentialRefId: 'c', trustLevel },
  expiresAt: Date.now() + 60_000,
})
const data = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
function pieces(text: string, size: number): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < text.length; index += size) controller.enqueue(encoder.encode(text.slice(index, index + size)))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
const events = (body: string) => body.split('\n\n').filter(block => block.includes('data: {')).map(block => JSON.parse(block.split('data: ')[1]!) as any)
const joined = (body: string, pick: (delta: any) => string | undefined) => events(body).map(event => pick(event.choices?.[0]?.delta ?? {}) ?? '').join('')

describe('模型网关数据防护（DLP-S2）', () => {
  let store: MemoryDataProtectionStore
  let upstream: string[]
  let respond: (placeholder: string) => Response
  let gateway: ModelGateway
  let base: string
  let masterKey: Uint8Array | undefined

  const start = async () => {
    await gateway?.stop()
    gateway = new ModelGateway({
      log: new MemoryModelGatewayRequestLog(),
      dataProtection: new DataProtectionService(store, masterKey),
      credentials: { readSecret: async () => 'vendor-key' },
      fetch: async (_url, init) => {
        const body = Buffer.from(init.body as Uint8Array).toString('utf8')
        upstream.push(body)
        return respond(body.match(/\{\{PERSONAL_[a-z2-7]{10}\}\}/)?.[0] ?? '')
      },
    })
    base = await gateway.start()
  }
  beforeEach(async () => {
    store = new MemoryDataProtectionStore()
    upstream = []
    masterKey = Buffer.alloc(32, 3)
    respond = () => pieces(data({ choices: [{ delta: { content: 'ok' } }] }), 5)
    await start()
  })
  afterEach(() => gateway.stop())

  const chat = (messages: unknown[], trust: 'internal' | 'external' = 'external', extra: object = {}) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.issueToken(binding(trust))}` },
    body: JSON.stringify({ model: 'm1', stream: true, messages, ...extra }),
  })

  it('外部厂商：历史、工具结果、工具参数都遮盖，思考内容与结构字段不动，多轮占位符一致', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: `电话 ${PHONE}` }] },
      { role: 'assistant', reasoning_content: `想 ${PHONE}`, content: null, tool_calls: [{ id: PHONE, type: 'function', function: { name: 'f', arguments: JSON.stringify({ name: PHONE }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: `密码为 Abc#2026x` },
      { role: 'user', content: '刚才的 Abc#2026x' },
    ]
    await (await chat(messages)).text()
    await (await chat(messages)).text()
    const sent = JSON.parse(upstream[0]!)
    assert.equal(upstream[0], upstream[1], '多轮一致')
    assert.equal(sent.messages[1].reasoning_content, `想 ${PHONE}`)
    assert.equal(sent.messages[1].tool_calls[0].id, PHONE)
    assert.equal(sent.messages[0].content[0].text.includes(PHONE), false)
    assert.equal(JSON.parse(sent.messages[1].tool_calls[0].function.arguments).name.includes(PHONE), false)
    assert.equal(upstream[0]!.includes('Abc#2026x'), false)
    assert.deepEqual(store.events[0]?.counts, { secret: 2, personal: 2, term: 0 })
    assert.equal(store.events[0]?.action, 'masked')
    assert.equal(JSON.stringify(store.events).includes(PHONE), false)
  })

  for (const size of [1, 3, 11, 4096]) {
    it(`流式还原：片段大小 ${size}，正文与工具参数还原，思考内容不还原`, async () => {
      respond = placeholder => pieces([
        data({ id: 'x', choices: [{ index: 0, delta: { reasoning_content: `思考 ${placeholder}` } }] }),
        data({ id: 'x', choices: [{ index: 0, delta: { content: `号码${placeholder.slice(0, 6)}` } }] }),
        data({ id: 'x', choices: [{ index: 0, delta: { content: `${placeholder.slice(6)}。{{` } }] }),
        data({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"p":"${placeholder}` } }] } }] }),
        data({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] }),
        data({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ].join(''), size)
      const body = await (await chat([{ role: 'user', content: `电话 ${PHONE}` }])).text()
      assert.equal(joined(body, delta => delta.content), `号码${PHONE}。{{`)
      assert.equal(joined(body, delta => delta.tool_calls?.[0]?.function?.arguments), `{"p":"${PHONE}"}`)
      assert.match(joined(body, delta => delta.reasoning_content), /^思考 \{\{PERSONAL_/)
      assert.ok(body.endsWith('data: [DONE]\n\n'))
    })
  }

  it('还原到工具参数时按 JSON 转义', async () => {
    respond = () => {
      const placeholder = upstream[0]!.match(/\{\{SECRET_[a-z2-7]{10}\}\}/)![0]
      return pieces(data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"p":"${placeholder}"}` } }] }, finish_reason: 'tool_calls' }] }), 7)
    }
    const body = await (await chat([{ role: 'user', content: 'postgres://a:p\\w"x1@h/db' }])).text()
    assert.equal(JSON.parse(joined(body, delta => delta.tool_calls?.[0]?.function?.arguments)).p, 'p\\w"x1')
  })

  it('非流式回复还原后一次写出', async () => {
    respond = placeholder => new Response(JSON.stringify({ choices: [{ message: { content: `是${placeholder}`, reasoning_content: placeholder } }] }), { headers: { 'content-type': 'application/json' } })
    const reply = await (await chat([{ role: 'user', content: PHONE }], 'external', { stream: false })).json() as any
    assert.equal(reply.choices[0].message.content, `是${PHONE}`)
    assert.match(reply.choices[0].message.reasoning_content, /^\{\{PERSONAL_/)
  })

  it('Anthropic 兼容的搜索请求遮盖，回复按内容块还原', async () => {
    respond = placeholder => pieces([
      `event: content_block_delta\n${data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: placeholder.slice(0, 8) } })}`,
      `event: content_block_delta\n${data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: placeholder.slice(8) } })}`,
      `event: content_block_stop\n${data({ type: 'content_block_stop', index: 0 })}`,
    ].join(''), 9)
    const response = await fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': gateway.issueToken(binding()) },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: `搜索 ${PHONE}` }] }),
    })
    const body = await response.text()
    assert.equal(upstream[0]!.includes(PHONE), false)
    assert.equal(events(body).map(event => event.delta?.text ?? '').join(''), PHONE)
    assert.equal(store.events[0]?.endpoint, 'search')
  })

  it('内部部署原样转发，审计记为放行并标记图片', async () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: PHONE }, { type: 'image_url', image_url: { url: 'data:x' } }] }]
    await (await chat(messages, 'internal')).text()
    assert.deepEqual(JSON.parse(upstream[0]!).messages, messages)
    assert.equal(store.events[0]?.action, 'passed')
    assert.equal(store.events[0]?.trustLevel, 'internal')
    assert.equal(store.events[0]?.hasImage, true)
  })

  it('没有命中时请求体与回复原样通过', async () => {
    const raw = data({ choices: [{ delta: { content: 'x' } }] })
    respond = () => pieces(raw, 2)
    const response = await chat([{ role: 'user', content: '你好' }])
    assert.equal(await response.text(), raw)
    assert.equal(store.events[0]?.action, 'passed')
  })

  it('词表读取失败或缺少主密钥时拒绝转发（失败即关闭）', async () => {
    store.loadPolicy = async () => { throw new Error('db down') }
    const failed = await chat([{ role: 'user', content: '你好' }])
    assert.equal(failed.status, 403)
    assert.equal(((await failed.json()) as { code: string }).code, 'DATA_POLICY_UNAVAILABLE')
    assert.equal((await gateway.inspectAttemptFailure('t', 'a')).failure?.code, 'DATA_POLICY_UNAVAILABLE')

    store = new MemoryDataProtectionStore()
    masterKey = undefined
    await start()
    assert.equal((await chat([{ role: 'user', content: '你好' }])).status, 403)
    assert.equal(upstream.length, 0)
  })

  it('工具参数的键名参与识别，取值遮盖', async () => {
    await (await chat([{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"password":"Abc#2026xQ","api_key":"zK81mNq02LpX"}' } }] }])).text()
    assert.equal(upstream[0]!.includes('Abc#2026xQ'), false)
    assert.equal(upstream[0]!.includes('zK81mNq02LpX'), false)
    assert.equal(store.events[0]?.counts.secret, 2)
  })

  it('工具描述遮盖，Schema 结构不动', async () => {
    store.policy = { terms: [{ value: '华星科技', caseSensitive: false, wholeWord: false }], allowlist: [] }
    const tools = [{ type: 'function', function: { name: '华星科技', description: '查询华星科技', parameters: { type: 'object', properties: { 华星科技: { type: 'string', description: '华星科技编号', enum: ['华星科技'] } } } } }]
    await (await chat([{ role: 'user', content: 'x' }], 'external', { tools })).text()
    const sent = JSON.parse(upstream[0]!).tools[0].function
    assert.equal(sent.name, '华星科技')
    assert.equal(sent.description.includes('华星科技'), false)
    assert.equal(sent.parameters.properties['华星科技'].description.includes('华星科技'), false)
    assert.deepEqual(sent.parameters.properties['华星科技'].enum, ['华星科技'])
  })

  it('跳过键只在消息结构层生效：对象参数的 name、参数键名、文本 document 都遮盖', async () => {
    await (await chat([{ role: 'assistant', content: [
      { type: 'tool_use', id: 'u', name: 't', input: { name: PHONE, [PHONE]: 1 } },
      { type: 'document', source: { type: 'text', data: PHONE } },
      { type: 'image', source: { type: 'base64', data: PHONE } },
    ] }])).text()
    const blocks = JSON.parse(upstream[0]!).messages[0].content
    assert.equal(JSON.stringify(blocks[0]).includes(PHONE), false)
    assert.equal(blocks[1].source.data.includes(PHONE), false)
    assert.equal(blocks[2].source.data, PHONE, '图片数据不动')
  })

  it('内容和 finish_reason 同帧时尾部不颠倒', async () => {
    respond = placeholder => pieces(data({ id: 'x', choices: [{ index: 0, delta: { content: `hello ${placeholder.slice(0, 4)}` }, finish_reason: 'stop' }] }), 50)
    const body = await (await chat([{ role: 'user', content: PHONE }])).text()
    assert.match(joined(body, delta => delta.content), /^hello \{\{PE$/)
  })

  it('只有字面占位符时审计记为放行', async () => {
    await (await chat([{ role: 'user', content: '解释 {{SECRET_abcdefghij}}' }])).text()
    assert.equal(store.events[0]?.action, 'passed')
  })

  it('需要还原的非流式回复超过上限时失败关闭', async () => {
    respond = () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 34; index += 1) controller.enqueue(new Uint8Array(1024 * 1024))
        controller.close()
      },
    }), { headers: { 'content-type': 'application/json' } })
    await assert.rejects(chat([{ role: 'user', content: PHONE }], 'external', { stream: false }).then(response => response.text()))
  })

  it('遮盖期间 DSH 断开：不发往厂商，留下中止记录', async () => {
    const log = new MemoryModelGatewayRequestLog()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const service = new DataProtectionService(store, masterKey)
    const slow = new ModelGateway({
      log,
      dataProtection: { mask: async (...args) => { await held; return service.mask(...args) }, recordGatewayEvent: event => service.recordGatewayEvent(event) },
      credentials: { readSecret: async () => 'vendor-key' },
      fetch: async () => { upstream.push('sent'); return new Response('') },
    })
    const root = await slow.start()
    const controller = new AbortController()
    const pending = fetch(`${root}/v1/chat/completions`, {
      method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${slow.issueToken(binding())}` },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'x' }] }),
    }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await pending
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    for (let index = 0; index < 100 && log.records.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(upstream.length, 0)
    assert.equal(log.records[0]?.outcome, 'aborted')
    await slow.stop()
  })

  it('审计写入失败不影响转发', async () => {
    store.recordGatewayEvent = async () => { throw new Error('db down') }
    assert.equal((await chat([{ role: 'user', content: '你好' }])).status, 200)
    assert.equal(upstream.length, 1)
  })
})
