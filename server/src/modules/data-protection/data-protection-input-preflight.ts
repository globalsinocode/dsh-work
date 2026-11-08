import { createHash, randomUUID } from 'node:crypto'

import { RequestError } from '../../domain/request-errors.ts'
import { inspectMessageForSecrets } from './data-protection-masking.ts'
import type { DataProtectionStore } from './data-protection-service.ts'

export type DataProtectionInputEntry = 'conversation' | 'task-execution' | 'automation-save' | 'automation-trigger' | 'routine-save' | 'routine-trigger'

/** D7 固定说明：只说类别，不显示取值或位置。 */
export const DATA_POLICY_BLOCKED_MESSAGE = '这条消息包含 密钥，按公司数据防护策略未发送给模型。请删除后重新发送。'

export function dataPolicyBlocked(): RequestError {
  return new RequestError(422, 'DATA_POLICY_BLOCKED', DATA_POLICY_BLOCKED_MESSAGE, '删除消息中的密钥后重新发送。')
}

function dataPolicyUnavailable(): RequestError {
  return new RequestError(503, 'DATA_POLICY_UNAVAILABLE', '数据防护暂时不可用，本轮未发送给模型', '请稍后重试；持续出现时联系管理员。')
}

/**
 * 输入预检（方案 5.6.1）：只查员工本条消息正文，只在本轮路由为外部厂商时进行。
 * 路由解析不出来时按外部厂商检查，宁可多查一次；识别或读词表失败则失败即关闭。
 */
export class DataProtectionInputPreflight {
  private readonly store: DataProtectionStore
  private readonly tenantId: string
  private readonly routeTrustLevel: () => Promise<'internal' | 'external'>
  private readonly onError: (message: string) => void

  constructor(options: {
    store: DataProtectionStore
    tenantId: string
    routeTrustLevel: () => Promise<'internal' | 'external'>
    onError?: (message: string) => void
  }) {
    this.store = options.store
    this.tenantId = options.tenantId
    this.routeTrustLevel = options.routeTrustLevel
    this.onError = options.onError ?? (() => undefined)
  }

  blockedError(): Error {
    return dataPolicyBlocked()
  }

  async check(input: { userId: string; entry: DataProtectionInputEntry; sessionId: string | null; text: string; dedupeKey?: string }): Promise<{ blocked: boolean }> {
    const trustLevel = await this.routeTrustLevel().catch(() => 'external' as const)
    if (trustLevel === 'internal') return { blocked: false }
    let secretCount: number
    try {
      ({ secretCount } = inspectMessageForSecrets(input.text, await this.store.loadPolicy(this.tenantId)))
    } catch (error) {
      this.onError(`data protection preflight failed: ${error instanceof Error ? error.name : 'unknown'}`)
      throw dataPolicyUnavailable()
    }
    if (secretCount === 0) return { blocked: false }
    try {
      // 同一次逻辑请求（重放、事务重试）只记一条。
      const id = input.dedupeKey
        ? `dpb-${createHash('sha256').update(JSON.stringify([this.tenantId, input.entry, input.sessionId, input.userId, input.dedupeKey])).digest('hex').slice(0, 32)}`
        : `dpb-${randomUUID()}`
      await this.store.recordInputBlock({ id, tenantId: this.tenantId, userId: input.userId, entry: input.entry, sessionId: input.sessionId, secretCount })
    } catch (error) {
      // 审计失败不放行：消息照样拦截。
      this.onError(`data protection input audit failed: ${error instanceof Error ? error.name : 'unknown'}`)
    }
    return { blocked: true }
  }
}
