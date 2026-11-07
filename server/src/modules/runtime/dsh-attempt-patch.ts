import { writeFile } from 'node:fs/promises'

import type { AcpProcessConfiguration } from './acp-json-rpc-client.ts'
import { mcpToolSchemaDigest } from './canonical-json.ts'
import type { McpRuntimeConnection, RuntimeModelRoute } from './runtime-types.ts'
import { invalidRequest } from '../../domain/request-errors.ts'
import { DEEPSEEK_WEB_SEARCH_MODEL, isDeepSeekOfficialBaseUrl } from '../../domain/deepseek-official.ts'

/** DSH 读取 Attempt 短期令牌的环境变量名（模型路由方案 4.5）。patch 只写变量名，不写令牌值。 */
export const MODEL_GATEWAY_TOKEN_ENV = 'DSH_WORK_MODEL_GATEWAY_TOKEN'

/**
 * 平台为 pi-ai 路由显式给出的重试策略（模型路由方案 4.3）：只重试空回复、限流、服务端错误、超时与传输错误，
 * 不重试其他 4xx（含网关的令牌拒绝与数据防护拒绝），避免与平台 Attempt 重试叠加放大。
 * 代码取值见 DSH `@deepseek-ai/dsh-llm` 的 retry-policy（DLP-S0 核对）。
 */
export const MODEL_ROUTE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
})

/** 平台声明的 pi-ai 路由名统一加前缀，避免与 DSH 内置路由同名（模型路由方案 4.3）。 */
export function dshRouteName(providerKey: string): string {
  return `dshw-${providerKey}`
}

export interface AttemptModelRoutePatch {
  route: RuntimeModelRoute
  /** 平台模型网关的根地址（如 `http://127.0.0.1:PORT`），pi-ai 与联网搜索都指向它。 */
  gatewayBaseUrl: string
  /** 本 Attempt 的短期令牌；只进入进程环境变量，不写入 patch 文件。 */
  token: string
  /** Attempt 目录内的平台设置文件，隔离共享 `DSH_HOME/settings.yaml`（模型路由方案第 3 节事实 3）。 */
  settingsPath: string
}

/**
 * 统一的每 Attempt patch 生成器（模型路由方案 4.4）。
 *
 * - **带路由**（正式执行）：`settings.path` 隔离、pi-ai 路由（baseURL=网关、apiKeyEnv=令牌变量、显式 retryPolicy）、
 *   `acp.provider/model`、联网搜索插件改指向网关（数据防护方案 D12），以及 MCP 段落；
 * - **无路由**（MCP 连接检查）：只生成 MCP 段落，沿用基础部署 patch 的默认模型；不发出模型请求。
 *
 * 两种模式都保留 `--profile` 前提；没有任何段落时不生成 patch。
 */
export async function prepareAttemptProcess(
  base: Omit<AcpProcessConfiguration, 'env'> & { env?: Record<string, string> },
  input: { connections: McpRuntimeConnection[]; modelRoute?: AttemptModelRoutePatch },
  patchPath: string,
  extraEnvironment: Record<string, string> = {},
): Promise<AcpProcessConfiguration> {
  const { connections, modelRoute } = input
  if (!connections.length && !modelRoute) return { ...base, env: { ...base.env, ...extraEnvironment } }
  if (!base.args.includes('--profile')) {
    throw invalidRequest(modelRoute ? '当前 DSH 兼容模式不支持平台模型路由' : '当前 DSH 兼容模式不支持受控 MCP Patch')
  }
  const environment: Record<string, string> = { ...base.env, ...extraEnvironment }
  const rows: string[] = []
  if (modelRoute) {
    rows.push(...modelRouteRows(modelRoute))
    environment[MODEL_GATEWAY_TOKEN_ENV] = modelRoute.token
  }
  if (connections.length) {
    rows.push(...mcpRows(connections, environment))
    environment['DSH_ALLOWED_MCP_SERVERS_JSON'] = JSON.stringify(connections.map(connection => connection.snapshot.server_name))
    // 生效清单逐工具下发：策略只放行清单内、且当前加载的输入 Schema 摘要一致的 Tool。
    environment['DSH_APPROVED_MCP_CAPABILITIES_JSON'] = JSON.stringify(connections.flatMap(connection => connection.capabilities ? [{
      serverName: connection.snapshot.server_name,
      tools: connection.capabilities.map(capability => ({
        name: capability.name,
        schemaDigest: mcpToolSchemaDigest(capability.inputSchema),
      })),
    }] : []))
  }
  await writeFile(patchPath, `${rows.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  return { ...base, args: [...base.args, '--patch', patchPath], env: environment }
}

/** 无路由模式的兼容入口：工具目录探测之外的 MCP 连接检查使用。 */
export async function prepareMcpProcess(
  base: Omit<AcpProcessConfiguration, 'env'> & { env?: Record<string, string> },
  connections: McpRuntimeConnection[],
  patchPath: string,
  extraEnvironment: Record<string, string> = {},
): Promise<AcpProcessConfiguration> {
  return prepareAttemptProcess(base, { connections }, patchPath, extraEnvironment)
}

function modelRouteRows(input: AttemptModelRoutePatch): string[] {
  const { route } = input
  const gateway = gatewayRoot(input.gatewayBaseUrl)
  const routeName = dshRouteName(route.provider_key)
  const deepSeek = isDeepSeekOfficialBaseUrl(route.base_url)
  const q = (value: string) => JSON.stringify(value)
  return [
    // 每个 Attempt 指向独立的设置文件，共享 settings.yaml 中的同名路由不能覆盖平台路由。
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${q(input.settingsPath)}`,
    '',
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    `      ${q(routeName)}:`,
    `        displayName: ${q(routeName)}`,
    `        api: ${q(route.provider_type)}`,
    // 厂商地址只在网关；DSH 只知道网关地址与令牌变量名。
    `        baseURL: ${q(`${gateway}/v1`)}`,
    `        apiKeyEnv: ${q(MODEL_GATEWAY_TOKEN_ENV)}`,
    '        retryPolicy:',
    `          mode: ${q(MODEL_ROUTE_RETRY_POLICY.mode)}`,
    `          maxRetries: ${MODEL_ROUTE_RETRY_POLICY.maxRetries}`,
    `          retryableCodes: [${MODEL_ROUTE_RETRY_POLICY.retryableCodes.map(q).join(', ')}]`,
    '        models:',
    `          - id: ${q(route.model_key)}`,
    ...(deepSeek ? ['            compat:', '              thinkingFormat: deepseek'] : []),
    '',
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${q(routeName)}`,
    `    model: ${q(route.model_key)}`,
    '',
    // 数据防护方案 D12：联网搜索也经网关，凭据只用本 Attempt 令牌；DSH_HOME 中的厂商密钥不再被使用。
    // 默认路由不是 DeepSeek 官方时平台不装配 web_search，网关也拒绝搜索请求。
    '- id: web-search-deepseek',
    "  name: '@deepseek-ai/dsh-web-search-deepseek'",
    '  config:',
    `    apiKeyEnv: ${q(MODEL_GATEWAY_TOKEN_ENV)}`,
    `    baseURL: ${q(`${gateway}/anthropic/v1`)}`,
    `    model: ${q(DEEPSEEK_WEB_SEARCH_MODEL)}`,
    '',
  ]
}

function mcpRows(connections: McpRuntimeConnection[], environment: Record<string, string>): string[] {
  const rows: string[] = ['- insert:']
  connections.forEach((connection, connectionIndex) => {
    const snapshot = connection.snapshot
    rows.push(
      `    - id: ${JSON.stringify(`mcp-${snapshot.server_name}`)}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      "        transport: 'streamable-http'",
      `        serverName: ${JSON.stringify(snapshot.server_name)}`,
      `        url: ${JSON.stringify(snapshot.endpoint)}`,
    )
    const headers = Object.entries(connection.headers)
    if (!headers.length) rows.push('        headers: {}')
    else {
      rows.push('        headers:')
      headers.forEach(([name, value], headerIndex) => {
        if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || /[\r\n]/.test(value)) throw invalidRequest('MCP 请求头配置无效')
        const environmentName = `DSH_MCP_VALUE_${connectionIndex}_${headerIndex}`
        environment[environmentName] = value
        rows.push(`          ${JSON.stringify(name)}: !!js process.env.${environmentName}`)
      })
    }
    rows.push(
      '        toolCallTimeoutMs: 60000',
      '        failOnStartupError: true',
      '        reconnect:',
      '          enabled: false',
    )
  })
  return rows
}

function gatewayRoot(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidRequest('模型网关地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidRequest('模型网关地址无效')
  return `${url.protocol}//${url.host}`
}
