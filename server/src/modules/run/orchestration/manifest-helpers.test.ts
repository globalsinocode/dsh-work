import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ModelRouteSnapshot } from '../../model/model-types.ts'
import { removeUnsupportedWebSearch, toRuntimeModelRoute } from './manifest-helpers.ts'

const snapshot: ModelRouteSnapshot = {
  routeId: 'route-default', routeKey: 'default', providerId: 'provider-deepseek', providerKey: 'deepseek-official',
  providerType: 'openai-completions', trustLevel: 'external', baseUrl: 'https://api.deepseek.com',
  modelId: 'model-pro', modelKey: 'deepseek-v4-pro', credentialRefId: 'credential-deepseek', modelCapabilities: [],
  credentialBackend: 'postgres-encrypted', credentialExternalRef: 'model-provider:provider-deepseek', resolvedAt: '2026-11-07T00:00:00.000Z',
}

describe('路由快照写入 Manifest（模型路由方案 4.2）', () => {
  it('只保留使用方需要的字段，不含凭据后端与外部引用', () => {
    assert.deepEqual(toRuntimeModelRoute(snapshot), {
      route_id: 'route-default', route_key: 'default', provider_key: 'deepseek-official', provider_type: 'openai-completions',
      model_key: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com', credential_ref_id: 'credential-deepseek', trust_level: 'external',
    })
  })

  it('首批只开放 openai-completions，其他协议按依赖不可用拒绝', () => {
    assert.throws(() => toRuntimeModelRoute({ ...snapshot, providerType: 'anthropic-messages' }), { code: 'dependency_unavailable' })
  })
})

describe('联网搜索随默认路由装配（数据防护方案 D12 补充）', () => {
  it('默认路由是 DeepSeek 官方时保留 web_search', () => {
    const tools = ['read', 'web_search']
    assert.deepEqual(removeUnsupportedWebSearch(tools, snapshot), [])
    assert.deepEqual(tools, ['read', 'web_search'])
  })

  it('默认路由不是 DeepSeek 官方时移除 web_search 并说明原因', () => {
    for (const baseUrl of ['https://llm.acme.example/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.example']) {
      const tools = ['read', 'web_search', 'bash']
      assert.deepEqual(removeUnsupportedWebSearch(tools, { baseUrl }), [{ tool: 'web_search', reason: 'model_route_unsupported' }], baseUrl)
      assert.deepEqual(tools, ['read', 'bash'])
    }
  })

  it('没有开启联网搜索时不写说明', () => {
    const tools = ['read']
    assert.deepEqual(removeUnsupportedWebSearch(tools, { baseUrl: 'https://llm.acme.example/v1' }), [])
  })
})
