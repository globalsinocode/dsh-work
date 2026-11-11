import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { WeKnoraClient } from './weknora-client.ts'
import { minimumRelevanceScore } from './weknora-knowledge-provider.ts'

/**
 * 真实 WeKnora 接口契约（weknora-knowledge-plan 4.1、第 12 节 P2）：确认 4.3～4.6 依赖的接口和字段在
 * 部署的版本中存在。只在配置了以下变量时运行，CI 中跳过；升级 WeKnora 前必须跑一遍。
 *
 *   WEKNORA_CONTRACT_URL、WEKNORA_CONTRACT_API_KEY、WEKNORA_CONTRACT_EMBEDDING_MODEL_ID
 */
const baseUrl = process.env.WEKNORA_CONTRACT_URL
const apiKey = process.env.WEKNORA_CONTRACT_API_KEY
const embeddingModelId = process.env.WEKNORA_CONTRACT_EMBEDDING_MODEL_ID
const configured = Boolean(baseUrl && apiKey && embeddingModelId)

test('WeKnora 新建知识库、检索、文档元数据与删除接口符合平台依赖的契约', { skip: !configured && '未配置 WEKNORA_CONTRACT_*' }, async () => {
  const client = new WeKnoraClient({ baseUrl: baseUrl!, apiKey: apiKey!, timeoutMs: 15000 })
  const created = await client.createKnowledgeBase({
    name: `dsh-work 契约测试 ${randomUUID().slice(0, 8)}`,
    description: '由 dsh-work 契约测试创建，测试结束即删除',
    embeddingModelId: embeddingModelId!,
  })
  try {
    assert.match(created.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/, '知识库 ID 可以放进平台 ID 格式')
    // 新知识库没有文档：检索与元数据接口仍须返回 data 列表（客户端会校验结构）。
    const emptySearch = await client.search({ query: '契约测试', knowledgeBaseIds: [created.id], matchCount: 10 })
    assert.deepEqual(emptySearch.results, [])
    // 优化方案 O5：检索响应带重排序结果（meta.rerank.outcome），平台记录到管理端健康状态。
    // 未配置重排序时 WeKnora 也返回 no_model 或 disabled，因此字段必须存在。
    assert.equal(typeof emptySearch.rerankOutcome, 'string', '检索响应应带 meta.rerank.outcome')
    // 优化方案 O7：平台新建的知识库没有摘要模型，入库不会调用对话模型。
    const stats = (await client.listKnowledgeBases()).find(item => item.id === created.id)
    assert.ok(stats, '知识库列表包含新建的知识库')
    assert.equal(stats.summaryModelId, null, '平台新建的知识库不应带摘要模型')
    assert.deepEqual(await client.knowledgeBatch([`missing-${randomUUID()}`]), [])

    // WK-S2 员工端文档管理依赖的接口：上传、列表、元数据、改标题、预览、下载、重新解析、删除。
    const uploaded = await client.uploadDocument(created.id, {
      fileName: 'dsh-work-contract.txt', mimeType: 'text/plain', bytes: Buffer.from('dsh-work 契约测试：安全库存按七天用量计算。'),
    })
    assert.equal(uploaded.knowledgeBaseId, created.id)
    const listed = await client.listDocuments(created.id, { page: 1, pageSize: 20 })
    assert.ok(listed.items.some(item => item.id === uploaded.id))
    const [metadata] = await client.knowledgeBatch([uploaded.id])
    assert.equal(metadata?.knowledge_base_id, created.id, '文档归属校验依赖批量元数据接口')
    await client.updateDocumentTitle(uploaded.id, '契约测试文档')
    assert.ok((await client.downloadDocument(uploaded.id)).bytes.length > 0)
    await client.previewDocument(uploaded.id)
    await client.reparseDocument(uploaded.id)
    await client.deleteDocument(uploaded.id)
  } finally {
    await client.deleteKnowledgeBase(created.id)
  }
})

test('最低相关度：命中文档高于门槛，无关提问低于门槛', { skip: !configured && '未配置 WEKNORA_CONTRACT_*', timeout: 180_000 }, async () => {
  const client = new WeKnoraClient({ baseUrl: baseUrl!, apiKey: apiKey!, timeoutMs: 15000 })
  const created = await client.createKnowledgeBase({
    name: `dsh-work 相关度校准 ${randomUUID().slice(0, 8)}`,
    description: '由 dsh-work 契约测试创建，测试结束即删除',
    embeddingModelId: embeddingModelId!,
  })
  try {
    const documents: Record<string, string> = {
      '库存管理规范.txt': '安全库存按最近三十天日均用量的七倍设定。计划组每周一复核安全库存，低于安全库存时触发补货申请。呆滞物料指超过一百八十天没有出库的物料，每季度清理一次。',
      '差旅报销制度.txt': '员工出差住宿标准：一线城市每晚不超过六百元，其他城市不超过四百元。报销须在出差结束后十五个工作日内提交，附发票和行程单。',
      '请假与考勤.txt': '年假按工龄计算：满一年不满十年五天。请假三天以内由直属主管审批，三天以上还需人事部审批。',
    }
    for (const [fileName, text] of Object.entries(documents)) {
      await client.uploadDocument(created.id, { fileName, mimeType: 'text/plain', bytes: Buffer.from(text) })
    }
    // 等待解析完成（嵌入模型须可达，否则解析失败、检索为空）。
    for (let attempt = 0; ; attempt++) {
      const { items } = await client.listDocuments(created.id, { page: 1, pageSize: 20 })
      assert.ok(!items.some(item => item.parseStatus === 'failed'), '文档解析失败：检查嵌入模型配置与 WeKnora 出站限制')
      if (items.length === 3 && items.every(item => item.parseStatus === 'completed')) break
      assert.ok(attempt < 120, '文档在 120 秒内没有解析完成')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const search = async (query: string) => (await client.search({ query, knowledgeBaseIds: [created.id], matchCount: 10 })).results
    // 相关提问：最高分须来自目标文档且不低于门槛，同一提问中的非目标文档须低于门槛（优化方案第 10 节的 12 个提问）。
    const relevant: Array<[string, string]> = [
      ['安全库存怎么定', '库存管理规范.txt'], ['出差住宿可以报多少钱', '差旅报销制度.txt'], ['请假超过三天谁审批', '请假与考勤.txt'],
      ['呆滞物料多久清理', '库存管理规范.txt'], ['报销要附什么材料', '差旅报销制度.txt'], ['年假几天', '请假与考勤.txt'],
      ['库存', '库存管理规范.txt'], ['出差', '差旅报销制度.txt'],
    ]
    const scores: string[] = []
    for (const [query, expected] of relevant) {
      const results = (await search(query)).sort((a, b) => b.score - a.score)
      const [top] = results
      assert.equal(top?.knowledge_filename || top?.knowledge_title, expected, `“${query}”的最高分应来自目标文档`)
      assert.ok(top!.score >= minimumRelevanceScore, `“${query}”命中分 ${top!.score} 低于门槛 ${minimumRelevanceScore}`)
      const others = results.filter(result => (result.knowledge_filename || result.knowledge_title) !== expected)
      assert.deepEqual(others.filter(result => result.score >= minimumRelevanceScore).map(result => result.score), [],
        `“${query}”中非目标文档不应高于门槛`)
      scores.push(`${query}: 命中 ${top!.score.toFixed(3)}，非目标最高 ${others[0]?.score.toFixed(3) ?? '—'}`)
    }
    for (const query of ['今天北京天气怎么样', '用 Python 写一个快速排序', '公司年会在哪里办', '采购订单怎么审批']) {
      const results = await search(query)
      assert.deepEqual(results.filter(result => result.score >= minimumRelevanceScore).map(result => result.score), [],
        `无关提问“${query}”不应有高于门槛的分段`)
      scores.push(`${query}: 最高 ${Math.max(0, ...results.map(result => result.score)).toFixed(3)}`)
    }
    // 输出分值，供复核时记录（不含文档正文）。
    console.log(`最低相关度复核（门槛 ${minimumRelevanceScore}）\n${scores.join('\n')}`)
  } finally {
    await client.deleteKnowledgeBase(created.id)
  }
})
