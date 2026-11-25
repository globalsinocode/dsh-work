import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { inheritedEnvironmentKeys } from './acp-json-rpc-client.ts'
import { dshHomeDirectory, dshHomeProxyConfigured } from './dsh-home-proxy.ts'

test('DSH home is resolved like DSH itself: ~ expanded, relative to the DSH working directory, ~/.dsh by default', () => {
  assert.equal(dshHomeDirectory({ DSH_HOME: '/srv/dsh-home' }), '/srv/dsh-home')
  assert.equal(dshHomeDirectory({ DSH_HOME: '/srv/a/../dsh-home' }), '/srv/dsh-home')
  assert.equal(dshHomeDirectory({ DSH_HOME: '  ' }), join(homedir(), '.dsh'))
  assert.equal(dshHomeDirectory({}), join(homedir(), '.dsh'))
  assert.equal(dshHomeDirectory({ DSH_HOME: '~' }), homedir())
  assert.equal(dshHomeDirectory({ DSH_HOME: '~/dsh-home' }), join(homedir(), 'dsh-home'))
  // DSH 的工作目录是 DSH_RUNTIME_HOME；相对路径按它解析，无法确定时返回 undefined（调用方失败即关闭）。
  assert.equal(dshHomeDirectory({ DSH_HOME: 'state/home', DSH_RUNTIME_HOME: '/opt/dsh' }), '/opt/dsh/state/home')
  assert.equal(dshHomeDirectory({ DSH_HOME: 'state/home' }), undefined)
})

test('a relative DSH_HOME whose base cannot be determined fails closed', async () => {
  assert.equal(await dshHomeProxyConfigured({ DSH_HOME: 'state/home' }), true)
  const runtime = await mkdtemp(join(tmpdir(), 'dsh-runtime-home-'))
  await mkdir(join(runtime, 'state'))
  await writeFile(join(runtime, 'state', '.env'), 'HTTPS_PROXY=http://proxy:8080\n')
  assert.equal(await dshHomeProxyConfigured({ DSH_HOME: 'state', DSH_RUNTIME_HOME: runtime }), true)
  assert.equal(await dshHomeProxyConfigured({ DSH_HOME: 'missing', DSH_RUNTIME_HOME: runtime }), false)
})

test('a proxy in the DSH home .env disables web_fetch; comments, other names and empty values do not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  const env = { DSH_HOME: home }
  assert.equal(await dshHomeProxyConfigured(env), false, 'no .env file')
  for (const [content, expected] of [
    ['DEEPSEEK_API_KEY=x\n# HTTP_PROXY=http://proxy:8080\nNO_PROXY=localhost\n', false],
    ['HTTPS_PROXY=\n', false],
    ['HTTPS_PROXY=""\n', false],
    ['https_proxy=http://proxy:8080\n', true],
    ['export ALL_PROXY = socks5://proxy:1080 # corp\n', true],
    ['HTTP_PROXY="http://proxy:8080"\r\n', true],
  ] as const) {
    await writeFile(join(home, '.env'), content)
    assert.equal(await dshHomeProxyConfigured(env), expected, JSON.stringify(content))
  }
})

test('an unreadable DSH home .env fails closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  await mkdir(join(home, '.env'))
  assert.equal(await dshHomeProxyConfigured({ DSH_HOME: home }), true, 'a directory named .env cannot be read')
  const file = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  await writeFile(join(file, '.env'), 'HTTP_PROXY=http://proxy\n')
  await chmod(join(file, '.env'), 0o000)
  if (process.getuid?.() !== 0) assert.equal(await dshHomeProxyConfigured({ DSH_HOME: file }), true)
})

test('the ACP launch never inherits proxy variables, so only the DSH home .env can route web_fetch through a proxy', () => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    assert.equal((inheritedEnvironmentKeys as readonly string[]).some(key => key.toUpperCase() === name), false, name)
  }
})
