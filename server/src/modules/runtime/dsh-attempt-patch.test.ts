import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse } from 'yaml'

import {
  MODEL_GATEWAY_TOKEN_ENV,
  dshRouteName,
  prepareAttemptProcess,
} from './dsh-attempt-patch.ts'
import type { McpRuntimeConnection, RuntimeModelRoute } from './runtime-types.ts'

const base = { command: process.execPath, args: ['dsh.js', '--profile', 'acp', '--patch', 'deploy.yml'], cwd: process.cwd(), env: { BASE: 'value' } }

const deepSeekRoute: RuntimeModelRoute = {
  route_id: 'route-default',
  route_key: 'default',
  provider_key: 'deepseek-official',
  provider_type: 'openai-completions',
  model_key: 'deepseek-v4-pro',
  base_url: 'https://api.deepseek.com',
  credential_ref_id: 'credential-deepseek',
  trust_level: 'external',
}

const mcpConnection: McpRuntimeConnection = {
  snapshot: {
    connector_id: 'connector-crm', server_name: 'crm', transport: 'streamable-http',
    endpoint: 'https://mcp.example.test/rpc', auth_type: 'bearer', capability_digest: 'a'.repeat(64),
  },
  headers: { Authorization: 'Bearer mcp-secret' },
}

type PatchEntry = { id?: string; name?: string; config?: Record<string, unknown>; insert?: PatchEntry[] }

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-work-attempt-patch-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('每 Attempt patch 生成器（模型路由方案 4.4）', () => {
  it('带路由：隔离设置文件、声明指向网关的 pi-ai 路由并设定 ACP 初始模型，令牌只进环境变量', async () => {
    await withDirectory(async (directory) => {
      const patchPath = join(directory, 'attempt.patch.yml')
      const settingsPath = join(directory, 'settings.yaml')
      const prepared = await prepareAttemptProcess(base, {
        connections: [],
        modelRoute: { route: deepSeekRoute, gatewayBaseUrl: 'http://127.0.0.1:48123', token: 'attempt-token-value', settingsPath },
      }, patchPath)
      const content = await readFile(patchPath, 'utf8')
      const entries = parse(content) as PatchEntry[]
      const byId = new Map(entries.map(entry => [entry.id, entry]))

      assert.deepEqual(byId.get('settings')?.config, { path: settingsPath })
      const routeName = dshRouteName('deepseek-official')
      assert.equal(routeName, 'dshw-deepseek-official')
      const providers = (byId.get('llm-pi-ai')?.config as { providers: Record<string, Record<string, unknown>> }).providers
      assert.deepEqual(Object.keys(providers), [routeName])
      assert.deepEqual(providers[routeName], {
        displayName: routeName,
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:48123/v1',
        apiKeyEnv: MODEL_GATEWAY_TOKEN_ENV,
        retryPolicy: {
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
        },
        models: [{ id: 'deepseek-v4-pro', compat: { thinkingFormat: 'deepseek' } }],
      })
      assert.deepEqual(byId.get('acp')?.config, { provider: routeName, model: 'deepseek-v4-pro' })
      assert.deepEqual(byId.get('web-search-deepseek')?.config, {
        apiKeyEnv: MODEL_GATEWAY_TOKEN_ENV,
        baseURL: 'http://127.0.0.1:48123/anthropic/v1',
        model: 'deepseek-v4-flash',
      })

      // 厂商地址、凭据引用与令牌值都不进入 patch。
      assert.doesNotMatch(content, /api\.deepseek\.com/)
      assert.doesNotMatch(content, /credential-deepseek/)
      assert.doesNotMatch(content, /attempt-token-value/)
      assert.equal(prepared.env?.[MODEL_GATEWAY_TOKEN_ENV], 'attempt-token-value')
      assert.equal(prepared.env?.['BASE'], 'value')
      assert.deepEqual(prepared.args.slice(-2), ['--patch', patchPath])
      assert.equal(prepared.args.filter(arg => arg === '--patch').length, 2, '基础部署 patch 保留，Attempt patch 在其后覆盖')
    })
  })

  it('非 DeepSeek 官方的路由不设置 DeepSeek 思考格式', async () => {
    await withDirectory(async (directory) => {
      const patchPath = join(directory, 'attempt.patch.yml')
      await prepareAttemptProcess(base, {
        connections: [],
        modelRoute: {
          route: { ...deepSeekRoute, provider_key: 'acme-llm', base_url: 'https://llm.acme.example/v1', model_key: 'acme-large' },
          gatewayBaseUrl: 'http://127.0.0.1:48123/',
          token: 't',
          settingsPath: join(directory, 'settings.yaml'),
        },
      }, patchPath)
      const entries = parse(await readFile(patchPath, 'utf8')) as PatchEntry[]
      const providers = (entries.find(entry => entry.id === 'llm-pi-ai')?.config as { providers: Record<string, { models: unknown }> }).providers
      assert.deepEqual(providers['dshw-acme-llm']?.models, [{ id: 'acme-large' }])
    })
  })

  it('带路由与 MCP 合并为同一个文件', async () => {
    await withDirectory(async (directory) => {
      const patchPath = join(directory, 'attempt.patch.yml')
      const prepared = await prepareAttemptProcess(base, {
        connections: [mcpConnection],
        modelRoute: { route: deepSeekRoute, gatewayBaseUrl: 'http://127.0.0.1:1', token: 't', settingsPath: join(directory, 's.yaml') },
      }, patchPath)
      const content = await readFile(patchPath, 'utf8')
      const entries = parse(content) as PatchEntry[]
      assert.ok(entries.some(entry => entry.id === 'acp'))
      const inserted = entries.find(entry => entry.insert)?.insert ?? []
      assert.deepEqual(inserted.map(entry => entry.id), ['mcp-crm'])
      assert.doesNotMatch(content, /mcp-secret/)
      assert.equal(prepared.env?.['DSH_MCP_VALUE_0_0'], 'Bearer mcp-secret')
      assert.equal(prepared.env?.['DSH_ALLOWED_MCP_SERVERS_JSON'], '["crm"]')
      assert.equal(prepared.args.filter(arg => arg === '--patch').length, 2)
    })
  })

  it('无路由：只生成 MCP 段落，不声明模型路由', async () => {
    await withDirectory(async (directory) => {
      const patchPath = join(directory, 'mcp.patch.yml')
      const prepared = await prepareAttemptProcess(base, { connections: [mcpConnection] }, patchPath)
      const content = await readFile(patchPath, 'utf8')
      assert.doesNotMatch(content, /llm-pi-ai|dsh-acp|settings-file|web-search/)
      assert.equal(prepared.env?.[MODEL_GATEWAY_TOKEN_ENV], undefined)
    })
  })

  it('既无路由也无 MCP 时不生成 patch', async () => {
    await withDirectory(async (directory) => {
      const prepared = await prepareAttemptProcess(base, { connections: [] }, join(directory, 'none.yml'), { EXTRA: '1' })
      assert.deepEqual(prepared.args, base.args)
      assert.equal(prepared.env?.['EXTRA'], '1')
    })
  })

  it('启动参数缺少 --profile 时拒绝生成带路由的 patch', async () => {
    await withDirectory(async (directory) => {
      await assert.rejects(
        prepareAttemptProcess({ ...base, args: ['legacy.js'] }, {
          connections: [],
          modelRoute: { route: deepSeekRoute, gatewayBaseUrl: 'http://127.0.0.1:1', token: 't', settingsPath: join(directory, 's.yaml') },
        }, join(directory, 'p.yml')),
        /不支持平台模型路由/,
      )
    })
  })

  it('拒绝无效的网关地址', async () => {
    await withDirectory(async (directory) => {
      await assert.rejects(
        prepareAttemptProcess(base, {
          connections: [],
          modelRoute: { route: deepSeekRoute, gatewayBaseUrl: 'file:///tmp/gw', token: 't', settingsPath: join(directory, 's.yaml') },
        }, join(directory, 'p.yml')),
        /模型网关地址无效/,
      )
    })
  })
})
