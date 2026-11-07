// P1 fixture for the DingTalk journeys (e2e/catalog/dingtalk.md): the real application (server/src/main.ts)
// with password authentication, a disposable database, synthetic accounts and a fake DingTalk Open Platform
// HTTP service. The production adapter (DingTalkOpenApiDirectory) reaches the fake through
// DSH_WORK_DINGTALK_API_BASE_URL; no test double is wired into main.ts. Not a real DingTalk acceptance (DT-P2).
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createThrowawayDatabase } from '../../server/src/infrastructure/postgres/test-database.ts'
import { loadIdentityConfiguration } from '../../server/src/modules/identity/config.ts'
import { LocalAuthService } from '../../server/src/modules/identity/local-auth-service.ts'
import { IdentityAdministrationService } from '../../server/src/modules/identity/administration-service.ts'

const serverPort = process.env.DSH_WORK_DINGTALK_E2E_SERVER_PORT ?? '4691'
const workbenchPort = process.env.DSH_WORK_DINGTALK_E2E_WORKBENCH_PORT ?? '4675'
const adminPort = process.env.DSH_WORK_DINGTALK_E2E_ADMIN_PORT ?? '4681'
const fakePort = Number(process.env.DSH_WORK_DINGTALK_E2E_FAKE_PORT ?? '4699')
const corpId = 'ding-corp-e2e'

/** 假钉钉通讯录：userid → 成员。手机号只存在于假服务中，平台不保存。 */
const members = new Map<string, { name: string; mobile: string; departments: number[] }>([
  ['ding-zhaoning', { name: '赵宁', mobile: '13800002201', departments: [11] }],
  ['ding-wangyifan', { name: '王逸帆', mobile: '13800002202', departments: [12] }],
  ['ding-linlan', { name: '林岚', mobile: '13800002203', departments: [13] }],
  ['ding-sunyue', { name: '孙悦', mobile: '13800002204', departments: [11] }],
  ['ding-zhouting', { name: '周婷', mobile: '13800002205', departments: [12] }],
  ['ding-heqing', { name: '何青', mobile: '13800002206', departments: [13] }],
  ['ding-wufan', { name: '吴凡', mobile: '13800002207', departments: [11] }],
  ['ding-lixiang', { name: '李响', mobile: '13800002208', departments: [12] }],
  ['ding-stranger', { name: '陌生人', mobile: '13800002299', departments: [11] }],
])
const departments = new Map([[1, 'dsh-work 测试企业'], [11, '销售部'], [12, '研发部'], [13, '市场部']])
const codes = new Map<string, string>()

function send(response: ServerResponse, body: unknown) {
  response.writeHead(200, {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  response.end(JSON.stringify(body))
}

async function json(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
}

const fake = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${fakePort}`)
  if (request.method === 'OPTIONS') return send(response, {})
  // 与真实钉钉一致：AppKey/AppSecret 不对时拒绝换取 access_token（页面“验证并保存”据此不保存）。
  if (url.pathname === '/gettoken') {
    return url.searchParams.get('appkey') === 'fixture-app-key' && url.searchParams.get('appsecret') === 'fixture-app-secret-not-real'
      ? send(response, { errcode: 0, access_token: 'fake-token', expires_in: 7200 })
      : send(response, { errcode: 40089, errmsg: '不合法的corpid或corpsecret' })
  }
  // 测试专用：钉钉容器替身向这里申请一次性授权码（真实环境由钉钉 JSAPI 签发）。
  if (url.pathname === '/__test/auth-code') {
    const body = await json(request)
    const code = `code-${randomUUID()}`
    codes.set(code, String(body.userId ?? ''))
    return send(response, { code })
  }
  if (url.searchParams.get('access_token') !== 'fake-token') return send(response, { errcode: 40014, errmsg: 'invalid access_token' })
  const body = await json(request)
  if (url.pathname === '/topapi/v2/user/getuserinfo') {
    const userId = codes.get(String(body.code))
    codes.delete(String(body.code))
    const member = userId ? members.get(userId) : undefined
    return send(response, userId ? { errcode: 0, result: { userid: userId, name: member?.name, unionid: `union-${userId}` } } : { errcode: 40078, errmsg: '不存在的临时授权码' })
  }
  if (url.pathname === '/topapi/v2/user/getbymobile') {
    const found = [...members.entries()].find(([, member]) => member.mobile === body.mobile)
    return send(response, found ? { errcode: 0, result: { userid: found[0] } } : { errcode: 60121, errmsg: '找不到该用户' })
  }
  if (url.pathname === '/topapi/v2/user/get') {
    const member = members.get(String(body.userid))
    return send(response, member ? { errcode: 0, result: { userid: body.userid, name: member.name, unionid: `union-${body.userid}`, dept_id_list: member.departments } } : { errcode: 33012, errmsg: '无效的userId' })
  }
  if (url.pathname === '/topapi/v2/department/get') {
    const name = departments.get(Number(body.dept_id))
    return send(response, name ? { errcode: 0, result: { name } } : { errcode: 60003, errmsg: '部门不存在' })
  }
  send(response, { errcode: 404, errmsg: 'unknown fake endpoint' })
})

const database = await createThrowawayDatabase({ namePrefix: 'dsh_dingtalk_browser' })
const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-browser-'))
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  DSH_WORK_DATABASE_URL: database.url,
  DSH_WORK_DATA_ROOT: dataRoot,
  DSH_WORK_SERVER_HOST: '127.0.0.1',
  DSH_WORK_SERVER_PORT: serverPort,
  DSH_WORK_WORKBENCH_ORIGINS: `http://localhost:${workbenchPort}`,
  DSH_WORK_ADMIN_ORIGINS: `http://localhost:${adminPort}`,
  DSH_WORK_SESSION_SECRET: 'dingtalk-browser-fixture-secret-not-for-deployment',
  DSH_WORK_COOKIE_SECURE: 'false',
  DSH_RUNTIME_HOME: join(dataRoot, 'runtime-unavailable'),
  // 页面保存 AppSecret 需要凭据主密钥（仅测试值）。DSH_WORK_DINGTALK_* 作为初始配置（页面从未保存过）。
  DSH_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  DSH_WORK_DINGTALK_CORP_ID: corpId,
  DSH_WORK_DINGTALK_AGENT_ID: '3189001',
  DSH_WORK_DINGTALK_APP_KEY: 'fixture-app-key',
  DSH_WORK_DINGTALK_APP_SECRET: 'fixture-app-secret-not-real',
  DSH_WORK_DINGTALK_API_BASE_URL: `http://127.0.0.1:${fakePort}`,
}
let child: ChildProcess | undefined
let closing = false
async function cleanup(code = 0) {
  if (closing) return
  closing = true
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise<void>(done => child!.once('exit', () => done()))
  }
  fake.close()
  await database.dispose()
  await rm(dataRoot, { recursive: true, force: true })
  process.exit(code)
}
process.once('SIGINT', () => { void cleanup() })
process.once('SIGTERM', () => { void cleanup() })

export const fixturePassword = 'Employee12345'
try {
  await new Promise<void>((done, fail) => { fake.once('error', fail); fake.listen(fakePort, '127.0.0.1', done) })
  const configuration = loadIdentityConfiguration({ ...environment, DSH_WORK_AUTH_MODE: 'local' })
  if (configuration.mode !== 'local') throw new Error('DingTalk browser fixture configuration mismatch')
  const authentication = new LocalAuthService(configuration, database.client)
  const administration = new IdentityAdministrationService(database.client, true)
  const admin = await authentication.bootstrap({ username: 'dingtalk.admin@example.invalid', name: '陈默', password: 'AdminPass123' })
  const accounts: Array<{ username: string; name: string; mustChangePassword?: boolean; dingtalk?: string; boundBy?: 'self' | 'admin'; locked?: boolean }> = [
    { username: 'zhaoning@example.invalid', name: '赵宁' },
    { username: 'wangyf@example.invalid', name: '王一凡' },
    { username: 'linlan@example.invalid', name: '林岚', dingtalk: 'ding-linlan', boundBy: 'self' },
    { username: 'sunyue@example.invalid', name: '孙悦' },
    { username: 'zhouting@example.invalid', name: '周婷', mustChangePassword: true },
    { username: 'heqing@example.invalid', name: '何青', dingtalk: 'ding-heqing', boundBy: 'admin' },
    { username: 'wufan@example.invalid', name: '吴凡', locked: true },
    { username: 'lixiang@example.invalid', name: '李响' },
  ]
  for (const account of accounts) {
    const { userId } = await authentication.createAccount({ username: account.username, name: account.name, password: fixturePassword }, admin.userId)
    await administration.grantRole({ userId, roleId: 'role-employee', actorId: admin.userId })
    if (!account.mustChangePassword) await database.client`update local_user_credentials set must_change_password = false where user_id = ${userId}`
    if (account.dingtalk) {
      const member = members.get(account.dingtalk)!
      await database.client`
        insert into external_account_bindings (id, tenant_id, channel, user_id, external_user_id, external_display_name, external_department, bound_by, bound_by_admin_id, status)
        values (${`binding-${randomUUID()}`}, 'tenant-dsh-work', 'dingtalk', ${userId}, ${account.dingtalk}, ${member.name}, ${departments.get(member.departments[0]!)!},
          ${account.boundBy!}, ${account.boundBy === 'admin' ? admin.userId : null}, 'valid')
      `
    }
    if (account.locked) {
      await database.client`
        insert into external_account_bindings (id, tenant_id, channel, user_id, external_user_id, external_display_name, bound_by, status, revoked_at, revoke_reason, self_rebind_locked)
        values (${`binding-${randomUUID()}`}, 'tenant-dsh-work', 'dingtalk', ${userId}, 'ding-wufan', '吴凡', 'self', 'invalid', now(), 'admin_unbind', true)
      `
    }
  }
  if (!closing) {
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/src/main.ts'], {
      cwd: resolve(import.meta.dirname, '../..'), env: environment, stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('exit', code => { void cleanup(code ?? 1) })
    child.once('error', () => { void cleanup(1) })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DingTalk browser fixture startup failed')
  await cleanup(1)
}
