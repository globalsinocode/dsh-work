import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { WeKnoraDouble } from '../../testing/weknora-double.ts'
import { weknoraServiceRoot, WeKnoraClient, WeKnoraRequestError, WeKnoraUnavailableError } from './weknora-client.ts'

const double = new WeKnoraDouble()
let baseUrl = ''

before(async () => { baseUrl = await double.start() })
after(async () => { await double.stop() })
beforeEach(() => {
  double.reset()
  double.documents = [{ id: 'doc-1', knowledgeBaseId: 'kb-1', title: '库存规范', fileName: '库存规范.pdf', updatedAt: '2026-08-01T09:30:00Z' }]
  double.chunks = [{ id: 'chunk-1', knowledgeId: 'doc-1', content: '安全库存不低于七天用量。', score: 0.82 }]
})

const client = (timeoutMs?: number) => new WeKnoraClient({ baseUrl, apiKey: double.apiKey, timeoutMs })

test('检索只调用 knowledge-search，带 API Key，不传 rerank（4.3）', async () => {
  const results = await client().search({ query: '安全库存', knowledgeBaseIds: ['kb-1'], matchCount: 10 })
  assert.deepEqual(results, [{
    id: 'chunk-1', content: '安全库存不低于七天用量。', knowledge_id: 'doc-1', knowledge_base_id: 'kb-1',
    knowledge_title: '库存规范', knowledge_filename: '库存规范.pdf', score: 0.82,
  }])
  const [request] = double.requests
  assert.equal(request?.path, '/api/v1/knowledge-search')
  assert.equal(request?.apiKey, double.apiKey)
  assert.deepEqual(request?.body, { query: '安全库存', knowledge_base_ids: ['kb-1'], match_count: 10 })
})

test('地址带 /api/v1（WeKnora 文档的写法）时不重复拼接', async () => {
  double.requests.length = 0
  await new WeKnoraClient({ baseUrl: `${baseUrl}/api/v1/`, apiKey: double.apiKey }).search({ query: 'q', knowledgeBaseIds: ['kb-1'], matchCount: 1 })
  assert.equal(double.requests.at(-1)?.path, '/api/v1/knowledge-search')
})

test('服务根地址：按路径去掉 /api/v1，大小写与重复都处理，保留子路径', () => {
  assert.equal(weknoraServiceRoot('http://host:8081/api/v1/'), 'http://host:8081')
  assert.equal(weknoraServiceRoot('http://host/API/V1'), 'http://host')
  assert.equal(weknoraServiceRoot('http://host/api/v1/api/v1'), 'http://host')
  assert.equal(weknoraServiceRoot('http://host/weknora/api/v1'), 'http://host/weknora')
  assert.equal(weknoraServiceRoot('http://host/weknora/'), 'http://host/weknora')
})

test('文档元数据批量读取 updated_at 与所属知识库', async () => {
  assert.deepEqual(await client().knowledgeBatch(['doc-1']), [{
    id: 'doc-1', knowledge_base_id: 'kb-1', title: '库存规范', file_name: '库存规范.pdf', updated_at: '2026-08-01T09:30:00Z',
    parse_status: 'completed',
  }])
  assert.deepEqual(await client().knowledgeBatch([]), [])
})

test('新建文档型知识库时带上统一嵌入模型（4.6）', async () => {
  const created = await client().createKnowledgeBase({ name: '制度库', description: '', embeddingModelId: 'embed-1' })
  assert.match(created.id, /^kb-double-/)
  assert.deepEqual(double.requests.at(-1)?.body, { name: '制度库', description: '', type: 'document', embedding_model_id: 'embed-1' })
})

test('不可用按原因分类：5xx、认证失败、限流、超时、连接失败（第 7 节）', async () => {
  const reason = async (run: () => Promise<unknown>) => {
    const error = await run().then(() => null, (caught: unknown) => caught)
    assert.ok(error instanceof WeKnoraUnavailableError, String(error))
    return error.reason
  }
  const search = (instance = client()) => instance.search({ query: 'q', knowledgeBaseIds: ['kb-1'], matchCount: 10 })
  double.failWith = 503
  assert.equal(await reason(() => search()), 'server')
  double.failWith = 429
  assert.equal(await reason(() => search()), 'rate_limited')
  double.failWith = null
  assert.equal(await reason(() => new WeKnoraClient({ baseUrl, apiKey: 'wrong' }).search({ query: 'q', knowledgeBaseIds: [], matchCount: 1 })), 'auth')
  double.delayMs = 200
  assert.equal(await reason(() => search(client(50))), 'timeout')
  double.delayMs = 0
  assert.equal(await reason(() => new WeKnoraClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }).search({ query: 'q', knowledgeBaseIds: [], matchCount: 1 })), 'network')
})

test('400、404 等请求错误与不可用区分，错误信息不含 API Key', async () => {
  const error = await client().createKnowledgeBase({ name: '', description: '', embeddingModelId: 'embed-1' }).then(() => null, (caught: unknown) => caught)
  assert.ok(error instanceof WeKnoraRequestError)
  assert.equal(error.status, 400)
  assert.doesNotMatch(error.message, new RegExp(double.apiKey))
})
