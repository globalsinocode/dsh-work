import type { ModelGatewayRequestRecord } from './model-gateway-types.ts'

/** 模型错误细分（模型路由方案 4.7）。四类不得合并：限流与上游故障可稍后重试，凭据与额度需要管理员处理。 */
export type ModelFailureCode =
  | 'MODEL_ROUTE_UNAVAILABLE'
  | 'MODEL_CREDENTIAL_INVALID'
  | 'MODEL_QUOTA_EXHAUSTED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_UPSTREAM_UNAVAILABLE'
  | 'MODEL_INVOCATION_FAILED'
  | 'DATA_POLICY_UNAVAILABLE'

// MODEL_REQUEST_INVALID（请求体过大、不是有效 JSON）不在此列，按通用模型调用失败处理，不提示“重新执行即可”。
const GATEWAY_CODES = new Set<string>(['MODEL_ROUTE_UNAVAILABLE', 'MODEL_CREDENTIAL_INVALID', 'MODEL_UPSTREAM_UNAVAILABLE', 'DATA_POLICY_UNAVAILABLE'])
const QUOTA_CODE = /quota|insufficient|balance|billing|credit/i

const messages: Record<ModelFailureCode, string> = {
  MODEL_ROUTE_UNAVAILABLE: '模型路由不可用：请求的模型与本次运行的路由不符或令牌无效',
  MODEL_CREDENTIAL_INVALID: '模型厂商密钥缺失、无效或已被吊销，请管理员在模型管理中更新密钥',
  MODEL_QUOTA_EXHAUSTED: '模型厂商额度或余额已用尽，请管理员处理后重试',
  MODEL_RATE_LIMITED: '模型厂商限流，重试后仍未成功，请稍后再试',
  MODEL_UPSTREAM_UNAVAILABLE: '模型厂商服务暂时不可用（连接失败、超时或服务端错误），请稍后再试',
  MODEL_INVOCATION_FAILED: '模型调用失败（请求被模型厂商或网关拒绝）',
  DATA_POLICY_UNAVAILABLE: '数据防护暂时不可用，本轮未发送给模型',
}

/** 按网关记录的来源、状态码与厂商错误码分类，不解析 DSH 的错误文本。 */
export function classifyGatewayRecord(record: ModelGatewayRequestRecord): ModelFailureCode | undefined {
  if (record.outcome === 'succeeded') return undefined
  // DSH 断开（取消、超时）导致的中止不是模型错误，不论是否已收到响应头。
  if (record.outcome === 'aborted') return undefined
  if (record.origin === 'gateway') {
    return record.errorCode && GATEWAY_CODES.has(record.errorCode) ? record.errorCode as ModelFailureCode : 'MODEL_INVOCATION_FAILED'
  }
  if (record.origin === 'transport') return 'MODEL_UPSTREAM_UNAVAILABLE'
  const status = record.httpStatus ?? 0
  if (status === 401 || status === 403) return 'MODEL_CREDENTIAL_INVALID'
  if (status === 402) return 'MODEL_QUOTA_EXHAUSTED'
  if (status === 429) return record.errorCode && QUOTA_CODE.test(record.errorCode) ? 'MODEL_QUOTA_EXHAUSTED' : 'MODEL_RATE_LIMITED'
  if (status === 408 || status >= 500) return 'MODEL_UPSTREAM_UNAVAILABLE'
  // 200 流中途的厂商错误事件：过载、服务端错误按上游不可用，其余保留通用模型错误。
  if (status < 300 && record.errorCode && /overload|server|unavailable|internal|timeout/i.test(record.errorCode)) return 'MODEL_UPSTREAM_UNAVAILABLE'
  return 'MODEL_INVOCATION_FAILED'
}

/**
 * Attempt 失败时以该 Attempt 最后一个请求为准（模型路由方案 4.7）：最后一个请求失败才归为模型错误；
 * 之后又有成功请求说明模型错误已恢复，失败另有原因。没有记录时返回 undefined，由调用方决定。
 */
export function classifyAttemptModelFailure(records: readonly ModelGatewayRequestRecord[]): { code: ModelFailureCode; message: string } | undefined {
  const last = records.at(-1)
  if (!last) return undefined
  const code = classifyGatewayRecord(last)
  if (!code) return undefined
  const detail = last.origin === 'upstream' && last.httpStatus ? `（厂商返回 ${last.httpStatus}${last.errorCode ? `，${last.errorCode}` : ''}）` : ''
  return { code, message: `${messages[code]}${detail}` }
}
