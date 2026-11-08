import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DataProtectionInputPreflight } from './data-protection-input-preflight.ts'
import { MemoryDataProtectionStore } from './data-protection-service.ts'

const SECRET = 's' + 'k-abcdefghijklmnopqrstuvwx1234'
const input = (text: string) => ({ userId: 'u', entry: 'conversation' as const, sessionId: 's', text })
function preflight(store = new MemoryDataProtectionStore(), trust: () => Promise<'internal' | 'external'> = async () => 'external') {
  return { store, service: new DataProtectionInputPreflight({ store, tenantId: 't', routeTrustLevel: trust }) }
}

describe('输入预检', () => {
  it('命中密钥时拦截，审计只记次数', async () => {
    const { store, service } = preflight()
    assert.deepEqual(await service.check(input(SECRET)), { blocked: true })
    const { id, ...block } = store.inputBlocks[0]!
    assert.match(id, /^dpb-/)
    assert.deepEqual(block, { tenantId: 't', userId: 'u', entry: 'conversation', sessionId: 's', secretCount: 1 })
  })

  it('同一次逻辑请求重放时只记一条审计', async () => {
    const { store, service } = preflight()
    await service.check({ ...input(SECRET), dedupeKey: 'k' })
    await service.check({ ...input(SECRET), dedupeKey: 'k' })
    assert.equal(store.inputBlocks.length, 1)
  })

  it('个人信息不拦截', async () => {
    assert.deepEqual(await preflight().service.check(input('电话 13812345678')), { blocked: false })
  })

  it('内部部署不预检', async () => {
    const { store, service } = preflight(undefined, async () => 'internal')
    assert.deepEqual(await service.check(input(SECRET)), { blocked: false })
    assert.equal(store.inputBlocks.length, 0)
  })

  it('路由解析失败时按外部厂商检查', async () => {
    const { service } = preflight(undefined, async () => { throw new Error('no route') })
    assert.deepEqual(await service.check(input(SECRET)), { blocked: true })
  })

  it('读词表失败时失败即关闭', async () => {
    const store = new MemoryDataProtectionStore()
    store.loadPolicy = async () => { throw new Error('db down') }
    await assert.rejects(preflight(store).service.check(input('你好')), { status: 503, code: 'DATA_POLICY_UNAVAILABLE' })
  })

  it('审计写入失败仍然拦截', async () => {
    const store = new MemoryDataProtectionStore()
    store.recordInputBlock = async () => { throw new Error('db down') }
    assert.deepEqual(await preflight(store).service.check(input(SECRET)), { blocked: true })
  })

  it('拦截错误只说类别，不带取值', () => {
    const error = preflight().service.blockedError() as Error & { status: number; code: string }
    assert.equal(error.status, 422)
    assert.equal(error.code, 'DATA_POLICY_BLOCKED')
    assert.match(error.message, /包含 密钥/)
  })
})
