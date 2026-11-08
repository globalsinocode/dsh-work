import { RequestError, stateConflict } from '../../domain/request-errors.ts'

/**
 * 默认模型路由未就绪（无启用路由、目标模型或 Provider 已停用、凭据未配置）：发起运行时拒绝。
 * 原因与处理都在模型配置里，不是运行时或连接器故障，所以给出指向“模型配置”的建议，而不是 503 的通用提示。
 * 与 Attempt 执行中的 MODEL_ROUTE_UNAVAILABLE（重新执行即可）不同：重新执行不能解决，须管理员调整配置。
 * 凭据只检查状态为“已配置”；旧的 DSH 受管引用仍会放行，由模型网关以 MODEL_CREDENTIAL_INVALID 拒绝（沿用现行决定）。
 */
export function modelRouteNotReady(message: string, suggestion: string) {
  return new RequestError(503, 'MODEL_ROUTE_NOT_READY', message, suggestion)
}

const ROUTE_PAGE = '管理端“模型配置 → 模型路由”'

export const noEnabledRoute = () => modelRouteNotReady(
  '没有可用的默认模型路由',
  `请管理员在${ROUTE_PAGE}中启用一条默认路由。`,
)

export const routeTargetDisabled = (detail: { routeName: string; providerName: string; providerActive: boolean; modelName: string; modelKey: string }) =>
  modelRouteNotReady(
    detail.providerActive
      ? `模型路由目标已停用：默认路由“${detail.routeName}”指向的模型“${detail.modelName}”（${detail.modelKey}）已停用`
      : `模型路由目标已停用：默认路由“${detail.routeName}”所属的 Provider“${detail.providerName}”已停用`,
    `请管理员在${ROUTE_PAGE}中把默认路由改为指向已启用的模型，或重新启用该${detail.providerActive ? '模型' : ' Provider'}。`,
  )

export const routeCredentialMissing = (providerName: string) => modelRouteNotReady(
  `Provider 凭据未配置：默认路由所用的 Provider“${providerName}”尚未录入 API Key`,
  '请管理员在管理端“模型配置 → Provider”中为该 Provider 录入 API Key。',
)

/** 模型仍被路由引用时不能删除（含已停用的路由）：先把路由改为指向其他模型。 */
export const modelInUse = (modelName: string, routeNames: string[]) => stateConflict(
  routeNames.length
    ? `模型“${modelName}”正被模型路由${routeNames.map((name) => `“${name}”`).join('、')}使用，不能删除；请先把这些路由改为指向其他模型`
    : `模型“${modelName}”正被模型路由使用，不能删除；请刷新后先把相关路由改为指向其他模型`,
)
