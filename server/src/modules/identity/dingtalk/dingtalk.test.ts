import assert from 'node:assert/strict'
import test from 'node:test'

import { loadDingTalkConfiguration } from './dingtalk-config.ts'
import { DingTalkDirectoryError } from './dingtalk-directory.ts'
import { DingTalkOpenApiDirectory } from './dingtalk-open-api.ts'

const env = {
  DSH_WORK_DINGTALK_CORP_ID: 'ding-corp', DSH_WORK_DINGTALK_AGENT_ID: '3189',
  DSH_WORK_DINGTALK_APP_KEY: 'app-key', DSH_WORK_DINGTALK_APP_SECRET: 'app-secret',
}

test('钉钉配置：全部缺省为未启用，部分配置启动失败，默认值符合方案', () => {
  assert.equal(loadDingTalkConfiguration({}), null)
  assert.throws(() => loadDingTalkConfiguration({ DSH_WORK_DINGTALK_CORP_ID: 'x' }), /配置不完整/)
  const configuration = loadDingTalkConfiguration(env)!
  assert.equal(configuration.sessionTtlSeconds, 12 * 3600)
  assert.equal(configuration.bindingTicketTtlSeconds, 300)
  assert.equal(configuration.adminDailyBindLimit, 50)
  assert.equal(configuration.apiBaseUrl, 'https://oapi.dingtalk.com/')
  assert.throws(() => loadDingTalkConfiguration({ ...env, NODE_ENV: 'production', DSH_WORK_DINGTALK_API_BASE_URL: 'http://oapi.example' }), /HTTPS/)
})

function fakeFetch(handler: (url: URL, body: Record<string, unknown> | null) => unknown) {
  const calls: string[] = []
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
    return new Response(JSON.stringify(handler(url, body)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fetcher, calls }
}

test('开放平台客户端：access_token 缓存复用，授权码换 userid 并标注本企业', async () => {
  const { fetcher, calls } = fakeFetch((url, body) => {
    if (url.pathname === '/gettoken') return { errcode: 0, access_token: 'token-1', expires_in: 7200 }
    assert.equal(url.searchParams.get('access_token'), 'token-1')
    if (url.pathname === '/topapi/v2/user/getuserinfo') {
      if (body?.code === 'scope') return { errcode: 60011, errmsg: '没有调用该接口的权限' }
      return body?.code === 'good' ? { errcode: 0, result: { userid: 'u1', unionid: 'n1', name: '赵宁' } } : { errcode: 40078, errmsg: '不存在的临时授权码' }
    }
    return { errcode: 0, result: {} }
  })
  const client = new DingTalkOpenApiDirectory(loadDingTalkConfiguration(env)!, fetcher)
  assert.deepEqual(await client.exchangeAuthCode('good'), { userId: 'u1', unionId: 'n1', name: '赵宁', corpId: 'ding-corp' })
  await assert.rejects(client.exchangeAuthCode('bad'), (error: unknown) => error instanceof DingTalkDirectoryError && error.code === 'auth_code_invalid')
  // 应用缺少权限是配置问题，不能报成授权码无效（员工端据此显示“钉钉暂不可用”而不是让员工反复重开）。
  await assert.rejects(client.exchangeAuthCode('scope'), (error: unknown) => error instanceof DingTalkDirectoryError && error.code === 'permission_denied')
  assert.equal(calls.filter(path => path === '/gettoken').length, 1)
})

test('开放平台客户端：错误码映射——只有明确不存在才是 member_not_found，限流与权限分开', async () => {
  const { fetcher } = fakeFetch((url, body) => {
    if (url.pathname === '/gettoken') return { errcode: 0, access_token: 't', expires_in: 7200 }
    if (url.pathname === '/topapi/v2/user/getbymobile') return body?.mobile === '13800000000' ? { errcode: 0, result: { userid: 'u9' } } : { errcode: 60121 }
    if (url.pathname === '/topapi/v2/user/get') {
      return ({ gone: { errcode: 33012 }, busy: { errcode: -1 }, scope: { errcode: 60011 } } as Record<string, unknown>)[String(body?.userid)]
        ?? { errcode: 0, result: { userid: body?.userid, name: '张三', dept_id_list: [1, 2] } }
    }
    if (url.pathname === '/topapi/v2/department/get') return body?.dept_id === 1 ? { errcode: 0, result: { name: '销售部' } } : { errcode: 60003 }
    return { errcode: 0 }
  })
  const client = new DingTalkOpenApiDirectory(loadDingTalkConfiguration(env)!, fetcher)
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: DingTalkDirectoryError) => error.code)
  assert.equal(await client.findUserIdByMobile('13800000000'), 'u9')
  assert.equal(await code(client.findUserIdByMobile('13900000000')), 'member_not_found')
  assert.deepEqual((await client.getMember('u9')).departmentIds, [1, 2])
  assert.equal(await code(client.getMember('gone')), 'member_not_found')
  assert.equal(await code(client.getMember('busy')), 'unavailable')
  assert.equal(await code(client.getMember('scope')), 'permission_denied')
  assert.equal(await client.getDepartmentName(1), '销售部')
  assert.equal(await code(client.getDepartmentName(2)), 'department_not_found')
})

test('开放平台客户端：凭据无效报告配置异常，网络失败报告不可用', async () => {
  const invalid = new DingTalkOpenApiDirectory(loadDingTalkConfiguration(env)!, fakeFetch(() => ({ errcode: 40089, errmsg: '不合法的corpid或corpsecret' })).fetcher)
  await assert.rejects(invalid.checkCredentials(), (error: unknown) => error instanceof DingTalkDirectoryError && error.code === 'configuration_invalid')
  const offline = new DingTalkOpenApiDirectory(loadDingTalkConfiguration(env)!, (async () => { throw new TypeError('fetch failed') }) as typeof fetch)
  await assert.rejects(offline.checkCredentials(), (error: unknown) => error instanceof DingTalkDirectoryError && error.code === 'unavailable')
})
