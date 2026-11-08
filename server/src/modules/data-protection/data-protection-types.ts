/** 数据防护（方案 5.3）的识别类别。占位符前缀见 CATEGORY_PREFIX。 */
export type DataProtectionCategory = 'secret' | 'personal' | 'term'

export interface DataProtectionTerm {
  value: string
  caseSensitive: boolean
  /** 整词匹配：词两侧不能紧贴英文字母、数字或下划线。 */
  wholeWord: boolean
}

/** 策略中唯一可变的部分（D11）：保密词表与白名单，网关按请求时的当前值处理。 */
export interface DataProtectionPolicy {
  terms: readonly DataProtectionTerm[]
  /** 整值匹配，不区分大小写。 */
  allowlist: readonly string[]
}

export type DataProtectionCounts = Record<DataProtectionCategory, number>

/** 识别引擎异常或短码碰撞：调用方必须失败即关闭，不得降级为不脱敏直发（方案 5.6）。 */
export class DataProtectionUnavailableError extends Error {
  readonly code = 'DATA_POLICY_UNAVAILABLE'
}
