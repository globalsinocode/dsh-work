/**
 * 一个 Attempt 经模型网关产生的用量，按请求类型汇总（对话、联网搜索各一行）。
 * 由消费方（run 模块）定义，模型网关模块按相同结构实现，两个模块互不引用。
 */
export interface AttemptModelUsageLine {
  endpoint: 'chat' | 'search'
  providerKey: string
  /** 实际模型：取厂商成功返回的请求所用模型；没有成功请求时取最后一次请求的模型。 */
  modelKey: string
  /** 请求次数，含 DSH 的重试。 */
  requests: number
  /** 失败的请求次数（被中止的不计入）。 */
  failedRequests: number
  /** 厂商成功返回的请求次数。 */
  succeededRequests: number
  /** 是否有请求带回了用量；有成功请求却都没带用量时，调用方退回会话日志或估算。 */
  usageReported: boolean
  /** 只统计返回了用量的请求；没有任何请求返回用量时为 0。 */
  inputTokens: number
  outputTokens: number
  /** 返回用量的请求全部带有缓存数据时才有值，否则为 null（厂商未返回，不记为 0）。 */
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export interface ModelUsageMeterPort {
  /**
   * 没有网关记录时返回空数组（网关上线前的运行、测试替身），调用方沿用原有计量。
   * afterCancel：取消时被中止的请求由网关在连接断开后才写入记录，实现方先稍等再汇总。
   */
  summarizeAttempt(tenantId: string, attemptId: string, options?: { afterCancel?: boolean }): Promise<AttemptModelUsageLine[]>
}
