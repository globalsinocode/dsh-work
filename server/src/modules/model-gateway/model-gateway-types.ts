/**
 * 平台模型网关（模型路由方案第 7 节、数据防护方案 5.2）的类型。网关只做认证、转发、计量（DLP-S1），
 * 不承担任何 Agent 执行逻辑；本模块不依赖 runtime 模块，由组合根把它接到 Runtime Adapter。
 */

/** Attempt 令牌绑定的路由（取自 Manifest 的 model_route，不含密钥值）。 */
export interface ModelGatewayRoute {
  routeId: string
  providerKey: string
  modelKey: string
  baseUrl: string
  credentialRefId: string
  trustLevel: 'internal' | 'external'
}

/** 一个 Attempt 的令牌绑定：租户、Run、Attempt、路由与模型必须一致（数据防护方案 5.1）。 */
export interface ModelGatewayBinding {
  tenantId: string
  runId: string
  attemptId: string
  route: ModelGatewayRoute
  /** 令牌过期时刻（毫秒时间戳）；Attempt 终态时另行吊销。 */
  expiresAt: number
}

export type ModelGatewayEndpoint = 'chat' | 'search'
export type ModelGatewayOrigin = 'gateway' | 'upstream' | 'transport'
export type ModelGatewayOutcome = 'succeeded' | 'failed' | 'aborted'

/** 网关自身拒绝时返回的平台错误码（模型路由方案 4.7、数据防护方案 5.6.2）。 */
export type ModelGatewayRejectionCode = 'MODEL_ROUTE_UNAVAILABLE' | 'MODEL_CREDENTIAL_INVALID' | 'MODEL_UPSTREAM_UNAVAILABLE' | 'MODEL_REQUEST_INVALID' | 'DATA_POLICY_UNAVAILABLE'

export interface ModelGatewayUsage {
  inputTokens: number | null
  outputTokens: number | null
  /** 厂商未返回时为 null（不记为 0）。 */
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export interface ModelGatewayRequestRecord extends ModelGatewayUsage {
  id: string
  tenantId: string
  runId: string
  attemptId: string
  routeId: string
  providerKey: string
  modelKey: string
  endpoint: ModelGatewayEndpoint
  origin: ModelGatewayOrigin
  outcome: ModelGatewayOutcome
  httpStatus: number | null
  errorCode: string | null
  startedAt: string
  finishedAt: string
}

/** 请求记录的持久化端口：生产为 PostgreSQL，测试为内存实现。 */
export interface ModelGatewayRequestLog {
  record(record: ModelGatewayRequestRecord): Promise<void>
  /** 按完成时间排序的本 Attempt 请求记录。 */
  listForAttempt(tenantId: string, attemptId: string): Promise<ModelGatewayRequestRecord[]>
}

/** 解析平台加密保存的厂商密钥（postgres-encrypted，模型路由方案 4.5）。明文只在转发时使用。 */
export interface ModelGatewayCredentialResolver {
  readSecret(tenantId: string, credentialRefId: string): Promise<string>
}

export interface ModelGatewayTextRestorer {
  push(chunk: string): string
  flush(): string
}

export interface ModelGatewayMaskCounts {
  secret: number
  personal: number
  term: number
}

export interface ModelGatewayMaskResult {
  texts: string[]
  counts: ModelGatewayMaskCounts
  hasPlaceholders: boolean
  /** encode：写回目标格式时对原值的转义（如工具参数里的 JSON 字符串）。 */
  createRestorer(encode?: (value: string) => string): ModelGatewayTextRestorer
}

export interface ModelGatewayDataProtectionEvent {
  tenantId: string
  runId: string
  attemptId: string
  providerKey: string
  modelKey: string
  endpoint: ModelGatewayEndpoint
  trustLevel: 'internal' | 'external'
  counts: ModelGatewayMaskCounts
  action: 'masked' | 'passed'
  hasImage: boolean
}

/** 数据防护端口（方案 5.4、5.9）。mask 抛错时网关失败即关闭，不得直发。 */
export interface ModelGatewayDataProtection {
  /** contexts 只参与识别、不写回。 */
  mask(tenantId: string, texts: readonly string[], contexts: readonly string[]): Promise<ModelGatewayMaskResult>
  recordGatewayEvent(event: ModelGatewayDataProtectionEvent): Promise<void>
}
