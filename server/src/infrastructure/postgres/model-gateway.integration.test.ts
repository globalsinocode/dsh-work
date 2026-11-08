import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'

import { DataProtectionService, MemoryDataProtectionStore, PostgresDataProtectionStore } from '../../modules/data-protection/data-protection-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { ModelGateway } from '../../modules/model-gateway/model-gateway.ts'
import { PostgresModelGatewayRequestLog } from '../../modules/model-gateway/model-gateway-request-log.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresEncryptedCredentialStore } from '../../modules/tool/postgres-encrypted-credential-store.ts'

// DLP-S1：网关从 postgres-encrypted 凭据解析厂商密钥转发，并把请求记录写入 model_gateway_requests。
const tenantId = 'tenant-dsh-work'
let database: ThrowawayDatabase
let gateway: ModelGateway
let upstreamAuthorization: string | undefined

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_work_model_gateway_test', maxConnections: 4 })
})

after(async () => {
  await gateway?.stop()
  await database?.dispose()
})

test('网关用管理端录入的加密密钥转发，并把用量与失败写入请求记录', async () => {
  const credentials = new PostgresEncryptedCredentialStore(database.client, { masterKeyBase64: randomBytes(32).toString('base64') })
  const models = new PostgresModelGovernanceRepository(database.client, credentials)
  const provider = await models.createProvider(tenantId, {
    key: 'gateway-test', name: '网关测试厂商', providerType: 'openai-completions', trustLevel: 'external',
    baseUrl: 'https://llm.gateway-test.example/v1', apiKey: 'sk-gateway-test-secret', actor: 'U00001',
  })
  assert.ok(provider.credential?.id)

  const log = new PostgresModelGatewayRequestLog(database.client)
  let status = 200
  gateway = new ModelGateway({
    dataProtection: new DataProtectionService(new MemoryDataProtectionStore(), Buffer.alloc(32, 1)),
    log,
    credentials: { readSecret: (tenant, credentialRefId) => credentials.readBearerToken(tenant, credentialRefId) },
    fetch: async (_url, init) => {
      upstreamAuthorization = (init.headers as Record<string, string>)['authorization']
      return status === 200
        ? new Response(JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status, headers: { 'content-type': 'application/json' } })
    },
  })
  const base = await gateway.start()
  const token = gateway.issueToken({
    tenantId, runId: 'run-gateway', attemptId: 'attempt-gateway',
    route: { routeId: 'route-x', providerKey: 'gateway-test', modelKey: 'gw-model', baseUrl: 'https://llm.gateway-test.example/v1', credentialRefId: provider.credential!.id, trustLevel: 'external' },
    expiresAt: Date.now() + 60_000,
  })
  const call = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gw-model' }),
  })

  const ok = await call()
  assert.equal(ok.status, 200)
  await ok.text()
  assert.equal(upstreamAuthorization, 'Bearer sk-gateway-test-secret')

  status = 429
  const limited = await call()
  assert.equal(limited.status, 429)
  await limited.text()

  const records = await log.listForAttempt(tenantId, 'attempt-gateway')
  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map(record => [record.outcome, record.httpStatus, record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.errorCode]),
    [['succeeded', 200, 11, 4, null, null], ['failed', 429, null, null, null, 'rate_limit_exceeded']],
  )
  assert.equal((await gateway.inspectAttemptFailure(tenantId, 'attempt-gateway')).failure?.code, 'MODEL_RATE_LIMITED')
  const [stored] = await database.client<{ text: string }[]>`select row_to_json(r)::text as text from model_gateway_requests r limit 1`
  assert.doesNotMatch(stored?.text ?? '', /sk-gateway-test-secret|dshwg_/)
})

test('词表保存后下一次请求即生效，审计只记次数并取到发起人', async () => {
  const store = new PostgresDataProtectionStore(database.client)
  const service = new DataProtectionService(store, Buffer.alloc(32, 2))
  assert.equal((await service.mask(tenantId, ['华星科技'])).counts.term, 0)
  await database.client`insert into data_protection_terms (id, tenant_id, value) values ('term-1', ${tenantId}, '华星科技')`
  await database.client`insert into data_protection_allowlist (id, tenant_id, value) values ('allow-1', ${tenantId}, 'a@example.com')`
  const result = await service.mask(tenantId, ['华星科技 a@example.com'])
  assert.deepEqual(result.counts, { secret: 0, personal: 0, term: 1 })
  assert.equal(result.texts[0]!.includes('华星科技'), false)

  await store.recordGatewayEvent({
    tenantId, runId: 'run-without-row', attemptId: 'attempt-1', providerKey: 'p', modelKey: 'm', endpoint: 'chat', trustLevel: 'external',
    counts: result.counts, action: 'masked', hasImage: false,
  })
  const rows = await database.client`select * from data_protection_gateway_events where run_id = 'run-without-row'`
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!['term_count'], 1)
  assert.equal(rows[0]!['user_id'], null)
  assert.equal(JSON.stringify(rows[0]).includes('华星科技'), false)
})
