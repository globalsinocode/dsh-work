import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const configUrl = new URL('../../playwright.config.ts', import.meta.url)
const portVariables = ['DSH_WORK_WORKBENCH_PORT', 'DSH_WORK_ADMIN_PORT', 'DSH_WORK_SERVER_PORT']

function loadConfig(ports = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DSH_WORK_AUTH_MODE: 'oidc',
    DSH_WORK_DATABASE_URL: 'postgresql://example.invalid/development',
    DSH_WORK_SERVER_HOST: 'example.invalid',
    VITE_ADMIN_API_BASE_URL: 'https://example.invalid/api/admin/v1',
    VITE_WORKBENCH_API_BASE_URL: 'https://example.invalid/api/workbench/v1',
    VITE_ADMIN_URL: 'https://example.invalid/admin',
    VITE_WORKBENCH_URL: 'https://example.invalid/workbench',
  }
  for (const key of portVariables) delete env[key]
  Object.assign(env, ports)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    const { default: config } = await import(${JSON.stringify(configUrl.href)})
    console.log(JSON.stringify({
      baseURL: config.use.baseURL,
      testIgnore: config.testIgnore,
      webServer: config.webServer,
      workerPorts: ${JSON.stringify(portVariables)}.map(key => process.env[key]),
    }))
  `], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('default P0 suite uses the test-only smoke server and isolates inherited API settings', () => {
  const config = loadConfig()
  assert.equal(config.baseURL, 'http://localhost:4274')
  assert.deepEqual(config.workerPorts, ['4274', '4280', '4290'])
  assert.deepEqual(config.webServer.map(server => server.url), [
    'http://localhost:4290/health',
    'http://localhost:4274/workbench',
    'http://localhost:4280/overview',
  ])
  // The application server has no in-memory mode; P0 never starts it.
  assert.equal(config.webServer[0].command, 'node --experimental-strip-types scripts/testing/p0-smoke-server.ts')
  assert.ok(config.webServer.every(server => !server.command.includes('dev:server')))
  for (const server of config.webServer) {
    assert.equal(server.reuseExistingServer, false)
    assert.equal(server.env.NODE_ENV, 'development')
    assert.equal(server.env.VITE_ADMIN_API_BASE_URL, '/api/admin/v1')
    assert.equal(server.env.VITE_WORKBENCH_API_BASE_URL, '/api/workbench/v1')
  }
  assert.ok(config.testIgnore.includes('**/*.integration.spec.ts'))
  assert.ok(config.testIgnore.includes('**/personal-integration/**'))
})

test('custom P0 ports stay consistent across readiness checks, proxies, links and test workers', () => {
  const config = loadConfig({
    DSH_WORK_WORKBENCH_PORT: '5274',
    DSH_WORK_ADMIN_PORT: '5280',
    DSH_WORK_SERVER_PORT: '5290',
  })
  assert.equal(config.baseURL, 'http://localhost:5274')
  assert.deepEqual(config.workerPorts, ['5274', '5280', '5290'])
  assert.deepEqual(config.webServer.map(server => server.url), [
    'http://localhost:5290/health',
    'http://localhost:5274/workbench',
    'http://localhost:5280/overview',
  ])
  for (const server of config.webServer) {
    assert.equal(server.env.DSH_WORK_WORKBENCH_PORT, '5274')
    assert.equal(server.env.DSH_WORK_ADMIN_PORT, '5280')
    assert.equal(server.env.DSH_WORK_SERVER_PORT, '5290')
    assert.equal(server.env.VITE_WORKBENCH_URL, 'http://localhost:5274')
    assert.equal(server.env.VITE_ADMIN_URL, 'http://localhost:5280')
    assert.equal(server.reuseExistingServer, false)
  }
})
