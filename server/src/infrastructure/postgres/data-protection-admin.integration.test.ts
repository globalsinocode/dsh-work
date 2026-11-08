import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresDataProtectionAdminService } from '../../modules/admin/application/postgres-data-protection-admin-service.ts'

const tenantId = 'tenant-dsh-work'
let database: ThrowawayDatabase
let service: PostgresDataProtectionAdminService

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_work_data_protection_admin_test', maxConnections: 4 })
  service = new PostgresDataProtectionAdminService(database.client, 'Asia/Shanghai')
  await database.client`
    insert into data_protection_gateway_events (id, tenant_id, user_id, run_id, attempt_id, provider_key, model_key, endpoint, trust_level, secret_count, personal_count, term_count, action, has_image)
    values ('e1', ${tenantId}, 'U00001', 'run-a', 'att-a', 'deepseek-official', 'm1', 'chat', 'external', 0, 3, 1, 'masked', true),
           ('e2', ${tenantId}, 'U00001', 'run-b', 'att-b', 'deepseek-official', 'm1', 'chat', 'external', 0, 0, 0, 'passed', false),
           ('e3', ${tenantId}, 'U00001', 'run-c', 'att-c', 'internal', 'm2', 'chat', 'internal', 0, 0, 0, 'passed', false)
  `
  await database.client`
    insert into data_protection_input_blocks (id, tenant_id, user_id, entry, session_id, secret_count)
    values ('b1', ${tenantId}, 'U00001', 'automation-trigger', null, 2)
  `
})

after(async () => {
  await database?.dispose()
})

test('概况与明细：放行的请求不进明细，被拦截的消息按入口归来源', async () => {
  const overview = await service.getOverview({ range: 'today' })
  assert.deepEqual(overview, { externalRequests: 2, maskedRequests: 1, imageRequests: 1, secret: 2, personal: 3, term: 1, blockedMessages: 1 })

  const all = await service.getRecords({ range: 'today' }, 1, 20)
  assert.equal(all.total, 2)
  const blocked = all.items.find(row => row.action === 'blocked')!
  assert.equal(blocked.source, 'automation')
  assert.equal(blocked.runId, null)

  assert.deepEqual((await service.getRecords({ range: 'today', category: 'personal' }, 1, 20)).items.map(row => row.id), ['e1'])
  assert.deepEqual((await service.getRecords({ range: 'today', action: 'blocked' }, 1, 20)).items.map(row => row.id), ['b1'])
  assert.equal((await service.getRecords({ range: 'today', employee: '不存在的人' }, 1, 20)).total, 0)
})

test('词表：重复跳过、删除后不再生效、超过上限整批回滚', async () => {
  assert.deepEqual(await service.addTerms([{ value: '华星科技', caseSensitive: false, wholeWord: false }], 'U00001'), { added: 1, skipped: 0 })
  assert.deepEqual(await service.addTerms([{ value: '华星科技', caseSensitive: true, wholeWord: false }, { value: 'Falcon', caseSensitive: true, wholeWord: true }], 'U00001'), { added: 1, skipped: 1 })
  const terms = await service.listTerms()
  assert.equal(terms.length, 2)
  assert.equal((await service.preview('华星科技')).term, 1)

  await service.removeTerm(terms.find(term => term.value === '华星科技')!.id, 'U00001')
  assert.equal((await service.preview('华星科技')).term, 0)

  const tooMany = Array.from({ length: 5000 }, (_item, index) => ({ value: `词${index}`, caseSensitive: false, wholeWord: false }))
  await assert.rejects(service.addTerms(tooMany, 'U00001'), /最多 5000/)
  assert.equal((await service.listTerms()).length, 1)
})

test('白名单：重复不新增，放行后检测不再命中', async () => {
  assert.deepEqual(await service.addAllow('service@example.cn', 'U00001'), { added: true })
  assert.deepEqual(await service.addAllow('service@example.cn', 'U00001'), { added: false })
  assert.equal((await service.preview('service@example.cn')).personal, 0)
  await service.removeAllow((await service.listAllowlist())[0]!.id, 'U00001')
  assert.equal((await service.preview('service@example.cn')).personal, 1)
})

test('审计与变更同事务：只记条数，删除不存在的条目不写审计', async () => {
  const before = await database.client`select count(*)::int as n from audit_events where object_type = 'data_protection'`
  assert.deepEqual(await service.removeTerm('no-such-term', 'U00001'), { removed: false })
  assert.deepEqual(await service.removeAllow('no-such-allow', 'U00001'), { removed: false })
  assert.deepEqual(await database.client`select count(*)::int as n from audit_events where object_type = 'data_protection'`, before)

  await service.addTerms([{ value: '审计专用词', caseSensitive: false, wholeWord: false }], 'U00001')
  const [row] = await database.client`select action, safe_context from audit_events where object_type = 'data_protection' order by occurred_at desc limit 1`
  assert.equal(row!['action'], 'data-protection.terms.add')
  assert.equal(JSON.stringify(row).includes('审计专用词'), false)
})
