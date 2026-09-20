import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryModelGovernanceRepository } from './memory-model-governance-repository.ts'
import { ModelGovernanceService } from './model-governance-service.ts'

test('default DSH provider resolves without exposing a secret value', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const providers = await service.listProviders()
  assert.equal(providers[0]?.credential?.backend, 'dsh-managed')
  assert.equal(providers[0]?.credential?.externalRef, 'DEEPSEEK_API_KEY')
  assert.equal('secret' in (providers[0]?.credential ?? {}), false)

  const route = await service.resolveRoute()
  assert.equal(route.providerKey, 'deepseek-official')
  assert.equal(route.modelKey, 'deepseek-v4-pro')
  assert.deepEqual(route.modelCapabilities, ['text', 'thinking', 'tool-calling'])
  assert.equal('secret' in route, false)
})

test('route admission requires every capability and never silently switches models', async () => {
  const repository = new MemoryModelGovernanceRepository()
  const service = new ModelGovernanceService(repository)
  await assert.rejects(service.resolveRoute('default', ['structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH', status: 422 })
  const provider = (await service.listProviders())[0]!
  const updated = await service.createProviderModel({ providerId: provider.id, modelKey: 'controlled-model', displayName: '受控测试模型', capabilities: ['long-context'], actor: 'test-admin' })
  const model = updated.models.find(item => item.modelKey === 'controlled-model')!
  await service.createRoute({ key: 'capability-test', name: '能力测试路由', purpose: 'analysis', providerModelId: model.id, priority: 1, enabled: true, actor: 'test-admin' })
  const route = await service.resolveRoute('capability-test', ['long-context'])
  assert.deepEqual(route.modelCapabilities, ['long-context'])
  await assert.rejects(service.resolveRoute('capability-test', ['long-context', 'structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH' })
  route.modelCapabilities.push('structured-output')
  await assert.rejects(service.resolveRoute('capability-test', ['structured-output']), { code: 'MODEL_CAPABILITY_MISMATCH' })
})

test('provider and model keys are validated before persistence', () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  assert.throws(
    () => service.createProvider({
      key: 'Bad Key',
      name: '测试 Provider',
      providerType: 'openai-compatible',
      baseUrl: 'https://example.com',
      actor: 'user-platform-admin',
    }),
    /Provider 标识/,
  )
})
