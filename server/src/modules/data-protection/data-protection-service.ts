import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { PlaceholderRestorer, deriveTenantKey, maskTexts } from './data-protection-masking.ts'
import { DataProtectionUnavailableError, type DataProtectionCounts, type DataProtectionPolicy } from './data-protection-types.ts'

export interface DataProtectionGatewayEvent {
  tenantId: string
  runId: string
  attemptId: string
  providerKey: string
  modelKey: string
  endpoint: 'chat' | 'search'
  trustLevel: 'internal' | 'external'
  counts: DataProtectionCounts
  action: 'masked' | 'passed'
  hasImage: boolean
}

export interface DataProtectionInputBlock {
  id: string
  tenantId: string
  userId: string
  entry: string
  sessionId: string | null
  secretCount: number
}

export interface DataProtectionStore {
  loadPolicy(tenantId: string): Promise<DataProtectionPolicy>
  recordGatewayEvent(event: DataProtectionGatewayEvent): Promise<void>
  recordInputBlock(block: DataProtectionInputBlock): Promise<void>
}

export class PostgresDataProtectionStore implements DataProtectionStore {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  /** 每个请求读取当前值：词表保存后立即对之后的请求生效（D11）。 */
  async loadPolicy(tenantId: string): Promise<DataProtectionPolicy> {
    const [terms, allowlist] = await Promise.all([
      this.database<{ value: string; caseSensitive: boolean; wholeWord: boolean }[]>`
        select value, case_sensitive as "caseSensitive", whole_word as "wholeWord"
          from data_protection_terms where tenant_id = ${tenantId}
      `,
      this.database<{ value: string }[]>`select value from data_protection_allowlist where tenant_id = ${tenantId}`,
    ])
    return { terms: [...terms], allowlist: allowlist.map(row => row.value) }
  }

  async recordInputBlock(block: DataProtectionInputBlock): Promise<void> {
    await this.database`
      insert into data_protection_input_blocks (id, tenant_id, user_id, entry, session_id, secret_count)
      values (${block.id}, ${block.tenantId}, ${block.userId}, ${block.entry}, ${block.sessionId}, ${block.secretCount})
      on conflict (id) do nothing
    `
  }

  async recordGatewayEvent(event: DataProtectionGatewayEvent): Promise<void> {
    await this.database`
      insert into data_protection_gateway_events (
        id, tenant_id, user_id, run_id, attempt_id, provider_key, model_key, endpoint, trust_level,
        secret_count, personal_count, term_count, action, has_image
      ) values (
        ${`dpe-${randomUUID()}`}, ${event.tenantId},
        (select requested_by from runs where tenant_id = ${event.tenantId} and id = ${event.runId}),
        ${event.runId}, ${event.attemptId}, ${event.providerKey}, ${event.modelKey}, ${event.endpoint}, ${event.trustLevel},
        ${event.counts.secret}, ${event.counts.personal}, ${event.counts.term}, ${event.action}, ${event.hasImage}
      )
    `
  }
}

export class MemoryDataProtectionStore implements DataProtectionStore {
  policy: DataProtectionPolicy = { terms: [], allowlist: [] }
  readonly events: DataProtectionGatewayEvent[] = []
  readonly inputBlocks: DataProtectionInputBlock[] = []

  async recordInputBlock(block: DataProtectionInputBlock): Promise<void> {
    if (!this.inputBlocks.some(existing => existing.id === block.id)) this.inputBlocks.push(structuredClone(block))
  }

  async loadPolicy(): Promise<DataProtectionPolicy> {
    return this.policy
  }

  async recordGatewayEvent(event: DataProtectionGatewayEvent): Promise<void> {
    this.events.push(structuredClone(event))
  }
}

/** 对模型网关提供的能力；网关按相同结构定义端口，两个模块互不引用。 */
export class DataProtectionService {
  private readonly store: DataProtectionStore
  private readonly masterKey: Uint8Array | undefined

  /** masterKey 缺失时遮盖一律失败即关闭，不得降级为直发。 */
  constructor(store: DataProtectionStore, masterKey: Uint8Array | undefined) {
    this.store = store
    this.masterKey = masterKey
  }

  async mask(tenantId: string, texts: readonly string[], contexts: readonly string[] = []) {
    if (!this.masterKey) throw new DataProtectionUnavailableError('未配置数据防护主密钥')
    const policy = await this.store.loadPolicy(tenantId)
    const result = maskTexts(texts, { tenantKey: deriveTenantKey(this.masterKey, tenantId), policy, contexts })
    return {
      texts: result.texts,
      counts: result.counts,
      hasPlaceholders: result.placeholders.size > 0,
      createRestorer: (encode?: (value: string) => string) => new PlaceholderRestorer(result.placeholders, encode),
    }
  }

  recordGatewayEvent(event: DataProtectionGatewayEvent): Promise<void> {
    return this.store.recordGatewayEvent(event)
  }
}
