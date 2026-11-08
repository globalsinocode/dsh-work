import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import { SmokeDataProtectionService } from '../../testing/p0-smoke/data-protection-service.ts'
import { Router } from '../router.ts'
import { registerDataProtectionRoutes } from './data-protection-routes.ts'
import type { RequestIdentity } from '../../modules/identity/types.ts'

describe('数据防护管理接口（DLP-S3）', () => {
  let server: Server
  let base: string
  let permissions: string[]

  before(async () => {
    const router = new Router({
      authenticateApi: async (_request, audience) => ({
        audience, applicationId: 'test', sessionHash: 'h', userId: 'U1', subject: 'U1', profile: { id: 'U1', name: 'U1' },
        roleIds: [], permissions, dataScopes: [], authorizationVersion: 1, identityProvider: 'local-password',
      }) as unknown as RequestIdentity,
    })
    registerDataProtectionRoutes(router, new SmokeDataProtectionService())
    server = createServer((request, response) => void router.handle(request, response))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/v1/data-protection`
  })
  after(() => new Promise<void>(resolve => server.close(() => resolve())))

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('没有词表权限：词表与白名单 403，响应不含词条；命中记录可读', async () => {
    permissions = ['admin:read', 'admin:write']
    for (const path of ['/terms', '/allowlist']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 403)
      assert.equal((await response.text()).includes('星河项目'), false)
    }
    assert.equal((await post('/terms', { terms: [{ value: 'x' }] })).status, 403)
    assert.equal((await fetch(`${base}/terms/term-1`, { method: 'DELETE' })).status, 403)
    assert.equal((await fetch(`${base}/records`)).status, 200)
  })

  it('有词表权限：已存在和同一批内的重复都计入跳过', async () => {
    permissions = ['admin:read', 'admin:write', 'data-protection:terms']
    const response = await post('/terms', { terms: [{ value: '新保密词' }, { value: '星河项目' }, { value: '新保密词' }] })
    assert.deepEqual(((await response.json()) as { data: unknown }).data, { added: 1, skipped: 2 })
  })

  it('参数校验：词条过长、时间范围无效', async () => {
    permissions = ['admin:*']
    assert.equal((await post('/terms', { terms: [{ value: 'x'.repeat(201) }] })).status, 422)
    assert.equal((await fetch(`${base}/overview?range=1y`)).status, 422)
  })

  it('一次导入 5000 条 200 字的词条不超过请求体上限', async () => {
    permissions = ['admin:*']
    const terms = Array.from({ length: 5000 }, (_item, index) => ({ value: `${index}`.padEnd(200, '词') }))
    assert.equal((await post('/terms', { terms })).status, 200)
  })

  it('检测试用：返回遮盖结果和是否会被拦截', async () => {
    permissions = ['admin:read', 'admin:write']
    const response = await post('/preview', { text: '华星科技 密码为 Abc#2026x' })
    const { data } = await response.json() as { data: { maskedText: string; secret: number; term: number; wouldBlock: boolean } }
    assert.equal(data.maskedText.includes('华星科技'), false)
    assert.equal(data.secret, 1)
    assert.equal(data.term, 1)
    assert.equal(data.wouldBlock, true)
  })
})
