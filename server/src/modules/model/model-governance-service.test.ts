import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryModelGovernanceRepository } from './memory-model-governance-repository.ts'
import type { RequestError } from '../../domain/request-errors.ts'
import { ModelGovernanceService } from './model-governance-service.ts'

const actor = 'test-admin'

test('default DSH provider resolves without exposing a secret value', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const providers = await service.listProviders()
  assert.equal(providers[0]?.credential?.backend, 'dsh-managed')
  assert.equal(providers[0]?.credential?.externalRef, 'DEEPSEEK_API_KEY')
  assert.equal(providers[0]?.providerType, 'openai-completions')
  assert.equal(providers[0]?.trustLevel, 'external')
  assert.equal('secret' in (providers[0]?.credential ?? {}), false)

  const route = await service.resolveDefaultRoute()
  assert.equal(route.providerKey, 'deepseek-official')
  assert.equal(route.modelKey, 'deepseek-v4-pro')
  assert.equal(route.trustLevel, 'external')
  assert.deepEqual(route.modelCapabilities, ['text', 'thinking', 'tool-calling'])
  assert.equal('secret' in route, false)
})

test('route admission requires every capability and never silently switches models', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  await assert.rejects(service.resolveDefaultRoute(['structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH', status: 422 })
  const provider = (await service.listProviders())[0]!
  const updated = await service.createProviderModel({ providerId: provider.id, modelKey: 'controlled-model', displayName: '受控测试模型', capabilities: ['long-context'], actor })
  const model = updated.models.find(item => item.modelKey === 'controlled-model')!
  await service.createRoute({ key: 'capability-test', name: '能力测试路由', providerModelId: model.id, enabled: true, actor })
  const route = await service.resolveDefaultRoute(['long-context'])
  assert.deepEqual(route.modelCapabilities, ['long-context'])
  await assert.rejects(service.resolveDefaultRoute(['long-context', 'structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH' })
  route.modelCapabilities.push('structured-output')
  await assert.rejects(service.resolveDefaultRoute(['structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH' })
})

test('the enabled default route is resolved by purpose, not by its key', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  const created = await service.createRoute({ key: 'primary-chat', name: '主力模型', providerModelId: provider.models[0]!.id, enabled: true, actor })
  const routes = await service.listRoutes()
  assert.deepEqual(routes.filter(item => item.enabled).map(item => item.id), [created.id], 'enabling a route disables the other default routes')
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'primary-chat')

  await service.updateRoute({ routeId: created.id, name: '主力模型', providerModelId: provider.models[0]!.id, enabled: false, actor })
  await assert.rejects(service.resolveDefaultRoute(), { code: 'MODEL_ROUTE_NOT_READY', message: '没有可用的默认模型路由' })

  const seed = routes.find(item => item.key === 'default')!
  await service.updateRoute({ routeId: seed.id, name: '平台默认模型路由', providerModelId: seed.providerModelId, enabled: true, actor })
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'default')
})

test('a disabled model makes its route unavailable instead of falling back', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  const model = provider.models[0]!
  const updated = await service.setProviderModelStatus({ modelId: model.id, status: 'disabled', actor })
  assert.equal(updated.models[0]?.status, 'disabled')
  await assert.rejects(service.resolveDefaultRoute(), (error: RequestError) => {
    assert.equal(error.code, 'MODEL_ROUTE_NOT_READY')
    assert.equal(error.status, 503)
    assert.match(error.message, /模型路由目标已停用：默认路由“平台默认模型路由”指向的模型.*（deepseek-v4-pro）已停用/)
    assert.match(error.suggestion ?? '', /模型配置 → 模型路由/)
    assert.doesNotMatch(error.suggestion ?? '', /运行时或连接器/)
    return true
  })
  await service.setProviderModelStatus({ modelId: model.id, status: 'active', actor })
  assert.equal((await service.resolveDefaultRoute()).modelKey, model.modelKey)

  await service.setProviderStatus({ providerId: provider.id, status: 'disabled', actor })
  await assert.rejects(service.resolveDefaultRoute(), /所属的 Provider“.+”已停用/)
  await service.setProviderStatus({ providerId: provider.id, status: 'active', actor })
})

test('provider type, trust level and keys are validated before persistence', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const valid = { key: 'internal-llm', name: '内网模型', providerType: 'openai-completions' as const, trustLevel: 'internal' as const, baseUrl: 'https://llm.example.internal/v1/', actor }
  assert.throws(() => service.createProvider({ ...valid, key: 'Bad Key' }), /Provider 标识/)
  assert.throws(() => service.createProvider({ ...valid, providerType: 'anthropic-messages' }), /首批只开放/)
  assert.throws(() => service.createProvider({ ...valid, providerType: 'openai-compatible' as never }), /首批只开放/)
  assert.throws(() => service.createProvider({ ...valid, trustLevel: undefined as never }), /信任级别/)

  const created = await service.createProvider(valid)
  assert.equal(created.trustLevel, 'internal')
  assert.equal(created.baseUrl, 'https://llm.example.internal/v1')

  const updated = await service.updateProvider({ providerId: created.id, name: '内网模型集群', baseUrl: 'https://llm2.example.internal', trustLevel: 'external', actor })
  assert.equal(updated.name, '内网模型集群')
  assert.equal(updated.trustLevel, 'external')
  assert.throws(() => service.updateProvider({ providerId: created.id, name: '内网模型集群', baseUrl: 'ftp://bad', trustLevel: 'external', actor }), /http/)
})

test('a route must target an existing model', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  await assert.rejects(service.createRoute({ key: 'missing-model', name: '缺失模型', providerModelId: 'model-missing', enabled: false, actor }), /目标模型不存在/)
})

test('an API key is stored for the provider without ever being returned', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const created = await service.createProvider({ key: 'vendor-two', name: '第二家厂商', providerType: 'openai-completions', trustLevel: 'external', baseUrl: 'https://vendor.example.com', apiKey: 'fake-model-key-0123456789abcd', actor })
  assert.equal(created.credential?.backend, 'postgres-encrypted')
  assert.equal(created.credential?.hint, 'abcd')
  assert.equal(JSON.stringify(created).includes('fake-model-key-0123456789abcd'), false)

  const rotated = await service.setProviderApiKey({ providerId: created.id, apiKey: 'fake-model-key-rotated-9999', actor })
  assert.equal(rotated.credential?.hint, '9999')
  assert.equal(rotated.credential?.id, created.credential?.id)
  assert.throws(() => service.setProviderApiKey({ providerId: created.id, apiKey: 'has space', actor }), /空白字符/)
})

test('a route cannot become the default while its target is disabled, and enabled must be explicit', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  const model = provider.models[0]!
  const standby = await service.createRoute({ key: 'standby', name: '备用路由', providerModelId: model.id, enabled: false, actor })
  await service.setProviderModelStatus({ modelId: model.id, status: 'disabled', actor })
  await assert.rejects(service.updateRoute({ routeId: standby.id, name: '备用路由', providerModelId: model.id, enabled: true, actor }), /已停用，不能设为默认路由/)
  await service.updateRoute({ routeId: standby.id, name: '备用路由（改名）', providerModelId: model.id, enabled: false, actor })
  await service.setProviderModelStatus({ modelId: model.id, status: 'active', actor })
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'default', 'the working default route was never switched off')
  assert.throws(() => service.createRoute({ key: 'no-flag', name: '未指定启用', providerModelId: model.id, enabled: undefined as never, actor }), /布尔值/)
})

test('route ids are required before reaching the repository', () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  assert.throws(() => service.createRoute({ key: 'no-model', name: '缺少模型', providerModelId: undefined as never, enabled: false, actor }), /请指定目标模型/)
  assert.throws(() => service.updateRoute({ routeId: '', name: '缺少路由', providerModelId: 'model-x', enabled: false, actor }), /请指定模型路由/)
})

test('model keys follow the vendor model id: dots, underscores, slashes and upper case are allowed', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  for (const modelKey of ['qwen3.8-flash', 'gpt-4.1', 'Qwen/Qwen3-8B', 'claude-3-5-sonnet@20240620', 'glm_4.5']) {
    const updated = await service.createProviderModel({ providerId: provider.id, modelKey, displayName: `模型 ${modelKey}`, capabilities: ['text'], actor })
    assert.ok(updated.models.some(model => model.modelKey === modelKey), modelKey)
  }
  for (const modelKey of ['', '-leading', 'has space', 'line\nbreak', 'quote"x', 'a'.repeat(201)]) {
    assert.throws(
      () => service.createProviderModel({ providerId: provider.id, modelKey, displayName: '非法模型', capabilities: ['text'], actor }),
      /模型标识须与厂商的模型 id 一致/,
      JSON.stringify(modelKey),
    )
  }
})

test('厂商模型目录：只对已录入平台密钥的 Provider 开放，并过滤不合规的 id', async () => {
  const calls: Array<{ credentialRefId: string; baseUrl: string }> = []
  const catalog = { list: async (input: { tenantId: string; credentialRefId: string; baseUrl: string }) => {
    calls.push(input)
    return ['qwen3.8-flash', 'bad id with space', 'qwen-max']
  } }
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository(), undefined, catalog)
  const legacy = (await service.listProviders())[0]!
  await assert.rejects(service.listProviderModelCatalog({ providerId: legacy.id }), /尚未录入 API Key/)
  await assert.rejects(service.listProviderModelCatalog({ providerId: 'provider-missing' }), /Provider 不存在/)

  const created = await service.createProvider({ key: 'vendor-catalog', name: '目录厂商', providerType: 'openai-completions', trustLevel: 'external', baseUrl: 'https://vendor.example.com/v1', apiKey: 'fake-model-key-0123456789abcd', actor })
  assert.deepEqual(await service.listProviderModelCatalog({ providerId: created.id }), { modelKeys: ['qwen3.8-flash', 'qwen-max'] })
  assert.deepEqual(calls, [{ tenantId: 'tenant-dsh-work', credentialRefId: created.credential!.id, baseUrl: 'https://vendor.example.com/v1' }])

  const withoutCatalog = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const other = await withoutCatalog.createProvider({ key: 'vendor-catalog', name: '目录厂商', providerType: 'openai-completions', trustLevel: 'external', baseUrl: 'https://vendor.example.com/v1', apiKey: 'fake-model-key-0123456789abcd', actor })
  await assert.rejects(withoutCatalog.listProviderModelCatalog({ providerId: other.id }), /DSH_CREDENTIAL_MASTER_KEY/)
})

test('缺少模型标识或名称时返回校验错误而不是 500', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  assert.throws(() => service.createProviderModel({ providerId: provider.id, modelKey: undefined as unknown as string, displayName: '名称', capabilities: [], actor }), { status: 422 })
  assert.throws(() => service.createProviderModel({ providerId: provider.id, modelKey: 'qwen-max', displayName: undefined as unknown as string, capabilities: [], actor }), { status: 422 })
})

test('删除模型：被任何路由（含停用路由）引用时拒绝并列出路由，未引用时删除', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  const seeded = provider.models[0]!
  await assert.rejects(service.deleteProviderModel({ modelId: seeded.id, actor }), (error: RequestError) => {
    assert.equal(error.status, 409)
    assert.match(error.message, /正被模型路由“平台默认模型路由”使用，不能删除/)
    return true
  })

  const added = await service.createProviderModel({ providerId: provider.id, modelKey: 'qwen38flash', displayName: '录错的模型', capabilities: ['text'], actor })
  const wrong = added.models.find(item => item.modelKey === 'qwen38flash')!
  const standby = await service.createRoute({ key: 'standby', name: '备用路由', providerModelId: wrong.id, enabled: false, actor })
  await assert.rejects(service.deleteProviderModel({ modelId: wrong.id, actor }), /“备用路由”使用/)

  await service.updateRoute({ routeId: standby.id, name: '备用路由', providerModelId: seeded.id, enabled: false, actor })
  const after = await service.deleteProviderModel({ modelId: wrong.id, actor })
  assert.deepEqual(after.models.map(item => item.modelKey), [seeded.modelKey])
  await assert.rejects(service.deleteProviderModel({ modelId: wrong.id, actor }), /Provider 模型不存在/)
  assert.throws(() => service.deleteProviderModel({ modelId: '', actor }), /请指定模型/)
})

test('编辑模型能力：规范化后保存，之后解析的路由快照使用新能力', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const provider = (await service.listProviders())[0]!
  const model = provider.models[0]!
  const updated = await service.updateProviderModelCapabilities({ modelId: model.id, capabilities: [' text ', 'tool-calling', 'text', ''], actor })
  assert.deepEqual(updated.models[0]?.capabilities, ['text', 'tool-calling'])
  assert.deepEqual((await service.resolveDefaultRoute()).modelCapabilities, ['text', 'tool-calling'])
  await assert.rejects(service.resolveDefaultRoute(['thinking']), { code: 'MODEL_CAPABILITY_MISMATCH' })
  assert.throws(() => service.updateProviderModelCapabilities({ modelId: model.id, capabilities: 'text' as unknown as string[], actor }), /文本列表/)
  assert.throws(() => service.updateProviderModelCapabilities({ modelId: model.id, capabilities: ['x'.repeat(65)], actor }), /不超过 64/)
  await assert.rejects(service.updateProviderModelCapabilities({ modelId: 'model-missing', capabilities: [], actor }), /Provider 模型不存在/)
})
