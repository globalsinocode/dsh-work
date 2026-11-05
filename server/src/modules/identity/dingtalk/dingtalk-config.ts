import { invalidRequest } from '../../../domain/request-errors.ts'

/**
 * 钉钉企业内部应用配置（钉钉接入方案第 5 节、8.1）。凭据只进 `.env` 或受管 Secret Manager，不入库。
 * 变量名使用 `DSH_WORK_DINGTALK_*`，不能用 `AI_HUB_*` 前缀（那会触发 AI Hub 登录配置检查）。
 */
export interface DingTalkConfiguration {
  corpId: string
  agentId: string
  appKey: string
  appSecret: string
  apiBaseUrl: string
  timeoutMs: number
  /** `dingtalk` 会话有效期，默认 12 小时（4.3）。 */
  sessionTtlSeconds: number
  /** 待绑定凭证有效期，默认 5 分钟（4.2）。 */
  bindingTicketTtlSeconds: number
  /** 单个管理员每日代绑上限，默认 50（4.2 方式二第 6 步）。 */
  adminDailyBindLimit: number
}

const keys = ['DSH_WORK_DINGTALK_CORP_ID', 'DSH_WORK_DINGTALK_AGENT_ID', 'DSH_WORK_DINGTALK_APP_KEY', 'DSH_WORK_DINGTALK_APP_SECRET'] as const

/** 四项凭据都未设置时返回 null（未启用钉钉）；只设置了一部分时启动失败，避免半配置静默生效。 */
export function loadDingTalkConfiguration(environment: NodeJS.ProcessEnv = process.env): DingTalkConfiguration | null {
  const values = keys.map(key => environment[key]?.trim() ?? '')
  if (values.every(value => !value)) return null
  const missing = keys.filter((_key, index) => !values[index])
  if (missing.length) throw invalidRequest(`钉钉应用配置不完整，缺少：${missing.join('、')}`)
  const [corpId, agentId, appKey, appSecret] = values as [string, string, string, string]
  const apiBaseUrl = environment.DSH_WORK_DINGTALK_API_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
  let parsed: URL
  try { parsed = new URL(apiBaseUrl) } catch { throw invalidRequest('DSH_WORK_DINGTALK_API_BASE_URL 必须是有效 URL') }
  if (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw invalidRequest('生产环境的钉钉开放平台地址必须使用 HTTPS')
  return {
    corpId, agentId, appKey, appSecret,
    apiBaseUrl: parsed.toString(),
    timeoutMs: positiveInteger(environment.DSH_WORK_DINGTALK_TIMEOUT_MS, 10_000, 'DSH_WORK_DINGTALK_TIMEOUT_MS'),
    sessionTtlSeconds: positiveInteger(environment.DSH_WORK_DINGTALK_SESSION_TTL_SECONDS, 12 * 60 * 60, 'DSH_WORK_DINGTALK_SESSION_TTL_SECONDS'),
    bindingTicketTtlSeconds: positiveInteger(environment.DSH_WORK_DINGTALK_BINDING_TICKET_TTL_SECONDS, 5 * 60, 'DSH_WORK_DINGTALK_BINDING_TICKET_TTL_SECONDS'),
    adminDailyBindLimit: positiveInteger(environment.DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT, 50, 'DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT'),
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalidRequest(`${name} 必须是正整数`)
  return parsed
}
