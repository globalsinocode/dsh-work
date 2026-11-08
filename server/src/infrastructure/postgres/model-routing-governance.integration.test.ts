import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresEncryptedCredentialStore } from '../../modules/tool/postgres-encrypted-credential-store.ts'

// 模型路由方案 MR-S1：迁移 0120 把自由文本的 provider_type 收敛为枚举、补 trust_level、
// 把非默认用途的路由停用并改为 default；之后路由按用途解析，不按标识。
const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const governanceMigration = '0120_model_routing_governance.sql'
const tenantId = 'tenant-dsh-work'
const actor = 'U00008'
const legacyTenantId = 'tenant-model-routing-legacy'
const masterKeyBase64 = Buffer.alloc(32, 7).toString('base64')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let baselineDirectory = ''
let service: ModelGovernanceService
let credentials: PostgresEncryptedCredentialStore

before(async () => {
  baselineDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-model-routing-baseline-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file.endsWith('.sql') && file < governanceMigration) {
      await copyFile(resolve(migrationsDirectory, file), resolve(baselineDirectory, file))
    }
  }
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_model_routing_governance', maxConnections: 3, migrate: false })
  database = throwaway.client
  await runMigrations(database, baselineDirectory)
  await seedLegacyGovernance()
  await runMigrations(database)
  credentials = new PostgresEncryptedCredentialStore(database, { masterKeyBase64 })
  service = new ModelGovernanceService(new PostgresModelGovernanceRepository(database, credentials), tenantId)
})

after(async () => {
  await throwaway.dispose()
  await rm(baselineDirectory, { recursive: true, force: true })
})

async function seedLegacyGovernance() {
  await database`
    insert into model_providers (id, tenant_id, key, name, provider_type, base_url, status)
    values ('provider-legacy-free-text', ${tenantId}, 'legacy-free-text', '旧自由文本类型', 'deepseek-official', 'https://legacy.example.com', 'active')
  `
  await database`
    insert into provider_models (id, tenant_id, provider_id, model_key, display_name, capabilities, status)
    values ('model-legacy-chat', ${tenantId}, 'provider-legacy-free-text', 'legacy-chat', '旧对话模型', '["text"]'::jsonb, 'active')
  `
  await database`
    insert into model_routes (id, tenant_id, key, name, purpose, provider_model_id, priority, enabled)
    values
      ('route-legacy-chat', ${tenantId}, 'legacy-chat', '旧对话路由', 'chat', 'model-legacy-chat', 10, true),
      ('route-legacy-analysis', ${tenantId}, 'legacy-analysis', '旧分析路由', 'analysis', 'model-legacy-chat', 20, true)
  `
  // 旧代码按标识 'default' 解析：这个租户实际在用的是一条标识为 default、用途为 chat 的路由。
  await database`insert into tenants (id, name, status) values (${legacyTenantId}, '旧路由租户', 'active')`
  await database`
    insert into model_providers (id, tenant_id, key, name, provider_type, base_url, status)
    values ('provider-legacy-tenant', ${legacyTenantId}, 'legacy-vendor', '旧租户厂商', 'openai-compatible', 'https://legacy-tenant.example.com', 'active')
  `
  await database`
    insert into provider_models (id, tenant_id, provider_id, model_key, display_name, capabilities, status)
    values ('model-legacy-tenant', ${legacyTenantId}, 'provider-legacy-tenant', 'legacy-tenant-model', '旧租户模型', '["text"]'::jsonb, 'active')
  `
  await database`
    insert into model_routes (id, tenant_id, key, name, purpose, provider_model_id, priority, enabled)
    values ('route-legacy-tenant-live', ${legacyTenantId}, 'default', '旧租户在用路由', 'chat', 'model-legacy-tenant', 100, true)
  `
}

test('migration maps free-text provider types to openai-completions and marks every provider external', async () => {
  const rows = await database<{ id: string; providerType: string; trustLevel: string }[]>`
    select id, provider_type as "providerType", trust_level as "trustLevel"
      from model_providers where tenant_id = ${tenantId} order by id
  `
  assert.deepEqual(rows.map(row => [row.id, row.providerType, row.trustLevel]), [
    ['provider-deepseek-official', 'openai-completions', 'external'],
    ['provider-legacy-free-text', 'openai-completions', 'external'],
  ])
  const [legacyProvider] = await database<{ providerType: string }[]>`
    select provider_type as "providerType" from model_providers where id = 'provider-legacy-tenant'
  `
  assert.equal(legacyProvider?.providerType, 'openai-completions')
  await assert.rejects(database`
    insert into model_providers (id, tenant_id, key, name, provider_type, trust_level, base_url, status)
    values ('provider-bad-type', ${tenantId}, 'bad-type', '错误类型', 'openai-compatible', 'external', 'https://bad.example.com', 'active')
  `, /model_providers_provider_type_check/)
  await assert.rejects(database`
    insert into model_providers (id, tenant_id, key, name, provider_type, base_url, status)
    values ('provider-no-trust', ${tenantId}, 'no-trust', '未选信任级别', 'openai-completions', 'https://bad.example.com', 'active')
  `, /trust_level/)
})

test('migration disables non-default routes and folds them into the default purpose without touching the seed default', async () => {
  const rows = await database<{ id: string; purpose: string; enabled: boolean }[]>`
    select id, purpose, enabled from model_routes where tenant_id = ${tenantId} order by id
  `
  assert.deepEqual(rows.map(row => [row.id, row.purpose, row.enabled]), [
    ['route-default', 'default', true],
    ['route-legacy-analysis', 'default', false],
    ['route-legacy-chat', 'default', false],
  ])
  await assert.rejects(database`
    update model_routes set purpose = 'fallback' where id = 'route-legacy-chat'
  `, /model_routes_purpose_check/)
})

test('migration keeps the route a tenant was actually using when it had no default-purpose route', async () => {
  const [live] = await database<{ purpose: string; enabled: boolean }[]>`
    select purpose, enabled from model_routes where id = 'route-legacy-tenant-live'
  `
  assert.deepEqual(live, { purpose: 'default', enabled: true })
  const legacyService = new ModelGovernanceService(new PostgresModelGovernanceRepository(database), legacyTenantId)
  await assert.rejects(legacyService.resolveDefaultRoute(), (error: { status?: number; code?: string; message: string; suggestion?: string }) => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'MODEL_ROUTE_NOT_READY')
    assert.match(error.message, /Provider 凭据未配置：默认路由所用的 Provider“.+”尚未录入 API Key/, 'the route resolves; only its credential is missing')
    assert.match(error.suggestion ?? '', /模型配置 → Provider/)
    return true
  })
})

test('the enabled default route is resolved by purpose, edited in place and switched atomically', async () => {
  const before = await service.resolveDefaultRoute()
  assert.equal(before.routeKey, 'default')
  assert.equal(before.providerType, 'openai-completions')
  assert.equal(before.trustLevel, 'external')

  const providers = await service.listProviders()
  const model = providers.find(item => item.id === 'provider-deepseek-official')!.models[0]!
  const created = await service.createRoute({ key: 'primary-model', name: '主力模型路由', providerModelId: model.id, enabled: true, actor })
  assert.equal(created.purpose, 'default')
  const enabled = (await service.listRoutes()).filter(item => item.enabled).map(item => item.id)
  assert.deepEqual(enabled, [created.id])
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'primary-model', 'a default route whose key is not "default" is still resolved')

  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: true, actor })
  assert.deepEqual((await service.listRoutes()).filter(item => item.enabled).map(item => item.id), ['route-default'])

  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: false, actor })
  await assert.rejects(service.resolveDefaultRoute(), /没有可用的默认模型路由/)
  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: true, actor })

  await assert.rejects(service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: 'model-missing', enabled: true, actor }), /目标模型不存在/)
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'default', 'a rejected edit leaves the enabled route unchanged')

  const audit = await database<{ action: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and object_type = 'model_governance'
  `
  assert.ok(audit.some(row => row.action === 'model_route.update'))
})

test('disabling a model makes its route unavailable and provider edits keep the trust level explicit', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const model = provider.models[0]!
  const disabled = await service.setProviderModelStatus({ modelId: model.id, status: 'disabled', actor })
  assert.equal(disabled.models.find(item => item.id === model.id)?.status, 'disabled')
  await assert.rejects(service.resolveDefaultRoute(), (error: { code?: string; message: string; suggestion?: string }) => {
    assert.equal(error.code, 'MODEL_ROUTE_NOT_READY')
    assert.match(error.message, new RegExp(`模型路由目标已停用：默认路由“平台默认模型路由”指向的模型“.+”（${model.modelKey}）已停用`))
    assert.match(error.suggestion ?? '', /模型配置 → 模型路由/)
    return true
  })
  await service.setProviderModelStatus({ modelId: model.id, status: 'active', actor })

  await service.setProviderStatus({ providerId: provider.id, status: 'disabled', actor })
  await assert.rejects(service.resolveDefaultRoute(), (error: { code?: string; message: string; suggestion?: string }) => {
    assert.equal(error.code, 'MODEL_ROUTE_NOT_READY')
    assert.match(error.message, /默认路由“平台默认模型路由”所属的 Provider“.+”已停用/)
    assert.match(error.suggestion ?? '', /重新启用该 Provider/)
    return true
  })
  await service.setProviderStatus({ providerId: provider.id, status: 'active', actor })

  const updated = await service.updateProvider({ providerId: provider.id, name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/', trustLevel: 'internal', actor })
  assert.equal(updated.trustLevel, 'internal')
  assert.equal(updated.baseUrl, 'https://api.deepseek.com')
  assert.equal((await service.resolveDefaultRoute()).trustLevel, 'internal')
  await service.updateProvider({ providerId: provider.id, name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', trustLevel: 'external', actor })

  const created = await service.createProvider({ key: 'internal-llm', name: '内网模型', providerType: 'openai-completions', trustLevel: 'internal', baseUrl: 'https://llm.example.internal', actor })
  assert.equal(created.trustLevel, 'internal')
})

test('concurrent default switches serialize per tenant instead of failing with a unique violation', async () => {
  const model = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!.models[0]!
  const left = await service.createRoute({ key: 'race-left', name: '并发左', providerModelId: model.id, enabled: false, actor })
  const right = await service.createRoute({ key: 'race-right', name: '并发右', providerModelId: model.id, enabled: false, actor })
  await Promise.all([
    service.updateRoute({ routeId: left.id, name: '并发左', providerModelId: model.id, enabled: true, actor }),
    service.updateRoute({ routeId: right.id, name: '并发右', providerModelId: model.id, enabled: true, actor }),
  ])
  const enabled = (await service.listRoutes()).filter(item => item.enabled)
  assert.equal(enabled.length, 1)
  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: true, actor })
  await assert.rejects(service.createRoute({ key: 'race-left', name: '重复标识', providerModelId: model.id, enabled: false, actor }), { status: 409 })
  await assert.rejects(service.createProvider({ key: 'internal-llm', name: '重复 Provider', providerType: 'openai-completions', trustLevel: 'internal', baseUrl: 'https://dup.example.com', actor }), { status: 409 })
})

test('a disabled target cannot become the default route', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-legacy-free-text')!
  await service.setProviderStatus({ providerId: provider.id, status: 'disabled', actor })
  await assert.rejects(service.updateRoute({ routeId: 'route-legacy-chat', name: '旧对话路由', providerModelId: 'model-legacy-chat', enabled: true, actor }), /已停用，不能设为默认路由/)
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'default')
  await service.setProviderStatus({ providerId: provider.id, status: 'active', actor })
})

test('API keys are encrypted at rest, rotated in place, never returned, and removed when switching back to a DSH reference', async () => {
  const secret = 'fake-model-key-0123456789wxyz'
  const created = await service.createProvider({ key: 'keyed-vendor', name: '带密钥厂商', providerType: 'openai-completions', trustLevel: 'external', baseUrl: 'https://keyed.example.com', apiKey: secret, actor })
  assert.equal(created.credential?.backend, 'postgres-encrypted')
  assert.equal(created.credential?.hint, 'wxyz')
  assert.equal(JSON.stringify(await service.listProviders()).includes(secret), false)
  const refId = created.credential!.id
  const [stored] = await database<{ ciphertext: Uint8Array; version: number }[]>`
    select ciphertext, version from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${refId}
  `
  assert.equal(Buffer.from(stored!.ciphertext).toString('utf8').includes(secret), false)
  assert.equal(await credentials.readBearerToken(tenantId, refId), secret)

  await service.setProviderApiKey({ providerId: created.id, apiKey: 'fake-model-key-rotated-5678', actor })
  const [rotated] = await database<{ version: number }[]>`
    select version from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${refId}
  `
  assert.equal(rotated?.version, 2)
  assert.equal(await credentials.readBearerToken(tenantId, refId), 'fake-model-key-rotated-5678')

  // 模型路由方案 4.5：网关上线后没有改回 DSH 受管等外部引用的入口，已保存的密文保留。
  const [remaining] = await database<{ count: number }[]>`
    select count(*)::integer as count from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${refId}
  `
  assert.equal(remaining?.count, 1)

  const withoutStore = new ModelGovernanceService(new PostgresModelGovernanceRepository(database), tenantId)
  await assert.rejects(withoutStore.setProviderApiKey({ providerId: created.id, apiKey: 'fake-no-master-key', actor }), /DSH_CREDENTIAL_MASTER_KEY/)
  const audit = await database<{ action: string; safeContext: unknown }[]>`
    select action, safe_context as "safeContext" from audit_events where tenant_id = ${tenantId} and object_id = ${created.id}
  `
  assert.ok(audit.some(row => row.action === 'model_provider.api_key.update'))
  assert.equal(JSON.stringify(audit).includes('fake-model-key'), false)
})

test('删除模型：被路由引用时 409 并列出路由；未引用时删除并记审计', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const used = provider.models[0]!
  await assert.rejects(service.deleteProviderModel({ modelId: used.id, actor }), (error: { status?: number; message: string }) => {
    assert.equal(error.status, 409)
    assert.match(error.message, /正被模型路由“.+”使用，不能删除/)
    return true
  })
  const added = await service.createProviderModel({ providerId: provider.id, modelKey: 'deepseek-delete-me', displayName: '待删除模型', capabilities: ['text'], actor })
  const target = added.models.find(item => item.modelKey === 'deepseek-delete-me')!
  const after = await service.deleteProviderModel({ modelId: target.id, actor })
  assert.equal(after.models.some(item => item.id === target.id), false)
  const audits = await database<{ safeContext: Record<string, unknown> }[]>`
    select safe_context as "safeContext" from audit_events
     where tenant_id = ${tenantId} and action = 'provider_model.delete' and object_id = ${target.id}
  `
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0]?.safeContext, {
    provider_id: provider.id, provider_key: provider.key, provider_name: provider.name,
    model_key: 'deepseek-delete-me', display_name: '待删除模型',
  })
})

test('删除模型时审计写入失败则删除回滚', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const added = await service.createProviderModel({ providerId: provider.id, modelKey: 'deepseek-audit-rollback', displayName: '回滚模型', capabilities: [], actor })
  const target = added.models.find(item => item.modelKey === 'deepseek-audit-rollback')!
  // 绕过服务层的操作人校验，直接让仓储以空 actor 写审计：actor_id 非空约束使审计插入失败，模拟审计写入故障。
  const repository = new PostgresModelGovernanceRepository(database, credentials)
  await assert.rejects(repository.deleteProviderModel(tenantId, { modelId: target.id, actor: null as unknown as string }), /actor_id|null/)
  const [row] = await database<{ count: number }[]>`select count(*)::int as count from provider_models where id = ${target.id}`
  assert.equal(row?.count, 1, '审计失败时模型仍在')
})

test('保存路由与删除其目标模型并发：路由先锁住模型，删除方得到明确冲突', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const added = await service.createProviderModel({ providerId: provider.id, modelKey: 'deepseek-race-target', displayName: '并发目标', capabilities: [], actor })
  const target = added.models.find(item => item.modelKey === 'deepseek-race-target')!
  const results = await Promise.allSettled([
    service.createRoute({ key: 'race-delete', name: '并发路由', providerModelId: target.id, enabled: false, actor }),
    service.deleteProviderModel({ modelId: target.id, actor }),
  ])
  for (const result of results) {
    if (result.status === 'rejected') {
      const error = result.reason as { status?: number }
      assert.ok(error.status === 409 || error.status === 422, `并发失败须为业务冲突而不是 500：${String(result.reason)}`)
    }
  }
})

test('编辑模型能力：持久化并记审计前后值', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const model = provider.models[0]!
  const before = model.capabilities
  const updated = await service.updateProviderModelCapabilities({ modelId: model.id, capabilities: ['text', 'tool-calling'], actor })
  assert.deepEqual(updated.models.find(item => item.id === model.id)?.capabilities, ['text', 'tool-calling'])
  const [audit] = await database<{ safeContext: Record<string, unknown> }[]>`
    select safe_context as "safeContext" from audit_events
     where tenant_id = ${tenantId} and action = 'provider_model.capabilities.update' and object_id = ${model.id}
  `
  assert.deepEqual(audit?.safeContext, { model_key: model.modelKey, before, after: ['text', 'tool-calling'] })
  await service.updateProviderModelCapabilities({ modelId: model.id, capabilities: before, actor })
})
