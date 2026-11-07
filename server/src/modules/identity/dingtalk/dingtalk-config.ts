import { invalidRequest } from '../../../domain/request-errors.ts'

/**
 * 钉钉企业内部应用配置（钉钉接入方案第 5 节、8.1）。2026-11-06 起在管理端“钉钉集成”页填写，AppSecret 加密入库
 * （`dingtalk-settings.ts`）；部署配置 `DSH_WORK_DINGTALK_*` 只在页面从未保存过时作为初始配置。
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

export const DINGTALK_DEFAULTS = {
  sessionTtlSeconds: 12 * 60 * 60,
  bindingTicketTtlSeconds: 5 * 60,
  adminDailyBindLimit: 50,
  timeoutMs: 10_000,
} as const

/**
 * 只能由部署配置决定的部分：开放平台地址（AppSecret 会发往该地址，不能在页面修改；只用于测试替身或代理），
 * 以及可选的初始配置。
 */
export interface DingTalkDeploymentSettings {
  apiBaseUrl: string
  bootstrap: DingTalkConfiguration | null
}

export function loadDingTalkDeploymentSettings(environment: NodeJS.ProcessEnv = process.env): DingTalkDeploymentSettings {
  return { apiBaseUrl: apiBaseUrl(environment), bootstrap: loadDingTalkConfiguration(environment) }
}

function apiBaseUrl(environment: NodeJS.ProcessEnv) {
  const value = environment.DSH_WORK_DINGTALK_API_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
  let parsed: URL
  try { parsed = new URL(value) } catch { throw invalidRequest('DSH_WORK_DINGTALK_API_BASE_URL 必须是有效 URL') }
  if (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw invalidRequest('生产环境的钉钉开放平台地址必须使用 HTTPS')
  return parsed.toString()
}

const keys = ['DSH_WORK_DINGTALK_CORP_ID', 'DSH_WORK_DINGTALK_AGENT_ID', 'DSH_WORK_DINGTALK_APP_KEY', 'DSH_WORK_DINGTALK_APP_SECRET'] as const

/** 四项凭据都未设置时返回 null（未启用钉钉）；只设置了一部分时启动失败，避免半配置静默生效。 */
export function loadDingTalkConfiguration(environment: NodeJS.ProcessEnv = process.env): DingTalkConfiguration | null {
  const values = keys.map(key => environment[key]?.trim() ?? '')
  if (values.every(value => !value)) return null
  const missing = keys.filter((_key, index) => !values[index])
  if (missing.length) throw invalidRequest(`钉钉应用配置不完整，缺少：${missing.join('、')}`)
  const [corpId, agentId, appKey, appSecret] = values as [string, string, string, string]
  return {
    corpId, agentId, appKey, appSecret,
    apiBaseUrl: apiBaseUrl(environment),
    timeoutMs: positiveInteger(environment.DSH_WORK_DINGTALK_TIMEOUT_MS, DINGTALK_DEFAULTS.timeoutMs, 'DSH_WORK_DINGTALK_TIMEOUT_MS'),
    sessionTtlSeconds: positiveInteger(environment.DSH_WORK_DINGTALK_SESSION_TTL_SECONDS, DINGTALK_DEFAULTS.sessionTtlSeconds, 'DSH_WORK_DINGTALK_SESSION_TTL_SECONDS'),
    bindingTicketTtlSeconds: positiveInteger(environment.DSH_WORK_DINGTALK_BINDING_TICKET_TTL_SECONDS, DINGTALK_DEFAULTS.bindingTicketTtlSeconds, 'DSH_WORK_DINGTALK_BINDING_TICKET_TTL_SECONDS'),
    adminDailyBindLimit: positiveInteger(environment.DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT, DINGTALK_DEFAULTS.adminDailyBindLimit, 'DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT'),
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw invalidRequest(`${name} 必须是正整数`)
  return parsed
}
