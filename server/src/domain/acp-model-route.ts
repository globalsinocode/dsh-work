/**
 * ACP Agent 的模型路由取值（站点配置面）。
 *
 * `@deepseek-ai/dsh-acp` 的 `provider?/model?` 虽然是可选字段，但**缺失不等于会回落**：
 * ACP profile 的路由只来自 `acp` 条目自身的 config；`@deepseek-ai/dsh-agent-default-model`
 * （base bundle，可被 `~/.dsh/settings.yaml` 覆盖）不会被 ACP 创建的 Agent 读取。
 * 缺失时的表现是第一次 turn 直接失败：
 *   `turn failed: agent "<id>" has no provider/model: set AgentOptions.provider and
 *    AgentOptions.model or supply both via the agent/request waterfall`
 * （2026-10-09 实测，见 deployment 侧 `2026-10-09-t4-acp-route-regression/receipt.txt`）。
 *
 * 因此制品不再写死站点取值，改为经 `runtime.env` 提供并要求显式给出；
 * 未配置时在服务启动期就失败，避免"能启动、不能出话"的静默故障。
 */

export const ACP_PROVIDER_ENV = 'DSH_WORK_ACP_PROVIDER'
export const ACP_MODEL_ENV = 'DSH_WORK_ACP_MODEL'

export interface AcpModelRoute {
  /** 已注册的 provider 路由名，例如站点网关的 provider key。 */
  provider: string
  /** provider 名下的模型 id。 */
  model: string
}

export function resolveAcpModelRoute(
  env: Record<string, string | undefined> = process.env,
): AcpModelRoute {
  const provider = (env[ACP_PROVIDER_ENV] ?? '').trim()
  const model = (env[ACP_MODEL_ENV] ?? '').trim()
  const missing = [
    ...(provider.length > 0 ? [] : [ACP_PROVIDER_ENV]),
    ...(model.length > 0 ? [] : [ACP_MODEL_ENV]),
  ]
  if (missing.length > 0) {
    throw new Error(
      `缺少 ACP 模型路由配置：${missing.join('、')}。ACP Agent 不会回落到 DSH 的 agent-default-model，`
      + '未配置会导致每次会话在模型调用处失败；请在站点 runtime.env 中显式给出这两项。',
    )
  }
  return { provider, model }
}

/**
 * 用 `session/new` 的返回断言 Agent 真的拿到了模型路由。
 *
 * ACP 的会话结果里有 `configOptions`，其中的模型选择项会带 `currentValue`
 * （形如 `["<provider>","<model>"]`）。路由缺失时该项为空数组——这就是 2026-10-09
 * 那次事故的现场特征。该断言**不需要真的调用模型**，因此可以放进部署预检。
 */
export function assertAcpModelRoute(sessionResult: Record<string, unknown>): void {
  const options = Array.isArray(sessionResult['configOptions']) ? sessionResult['configOptions'] : []
  const model = options.find((option) => {
    if (typeof option !== 'object' || option === null) return false
    const record = option as Record<string, unknown>
    return record['category'] === 'model' || record['id'] === 'model'
  }) as Record<string, unknown> | undefined
  const current = model?.['currentValue']
  const empty = typeof current !== 'string' || current.trim().length === 0 || current.trim() === '[]'
  if (model === undefined || empty) {
    throw new Error(
      'ACP Agent 没有可用的模型路由：session/new 未返回带取值的模型选项'
      + `（configOptions=${JSON.stringify(options)}）。请检查 runtime.env 的 `
      + `${ACP_PROVIDER_ENV}/${ACP_MODEL_ENV} 是否按站点实际网关配置。`,
    )
  }
}
