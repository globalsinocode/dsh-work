import { randomBytes, randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction as TransactionSql } from '../../../infrastructure/postgres/database.ts'
import { stateConflict } from '../../../domain/request-errors.ts'
import {
  DATA_PROTECTION_MAX_TERMS,
  type DataProtectionAdminPort,
  type DataProtectionAllowRecord,
  type DataProtectionFilter,
  type DataProtectionOverview,
  type DataProtectionPreview,
  type DataProtectionRecord,
  type DataProtectionRecordPage,
  type DataProtectionTermInput,
  type DataProtectionTermRecord,
} from '../../../domain/data-protection.ts'
import { MODEL_USAGE_RANGE_DAYS, RELEASE_TRIAL_PURPOSE, RUN_SOURCE_BY_TASK_TYPE, UNASSIGNED_DEPARTMENT } from '../../../domain/model-usage.ts'
import { inspectMessageForSecrets, maskTexts } from '../../data-protection/data-protection-masking.ts'
import { PostgresDataProtectionStore } from '../../data-protection/data-protection-service.ts'

const tenantId = 'tenant-dsh-work'

export class PostgresDataProtectionAdminService implements DataProtectionAdminPort {
  private readonly database: DatabaseClient
  private readonly timezone: string
  private readonly store: PostgresDataProtectionStore

  constructor(database: DatabaseClient, timezone: string) {
    this.database = database
    this.timezone = timezone
    this.store = new PostgresDataProtectionStore(database)
  }

  /** 窗口起点：平台时区今天零点往前推。 */
  private since(filter: DataProtectionFilter) {
    const tz = this.timezone
    const days = MODEL_USAGE_RANGE_DAYS[filter.range]
    return this.database`((date_trunc('day', now() at time zone ${tz}) - make_interval(days => ${days - 1})) at time zone ${tz})`
  }

  async getOverview(filter: DataProtectionFilter): Promise<DataProtectionOverview> {
    const since = this.since(filter)
    const [[gateway], [blocks]] = await Promise.all([
      this.database<{ externalRequests: number; maskedRequests: number; imageRequests: number; secret: number; personal: number; term: number }[]>`
        select count(*) filter (where trust_level = 'external')::int as "externalRequests",
               count(*) filter (where action = 'masked')::int as "maskedRequests",
               count(*) filter (where has_image)::int as "imageRequests",
               coalesce(sum(secret_count), 0)::int as secret,
               coalesce(sum(personal_count), 0)::int as personal,
               coalesce(sum(term_count), 0)::int as term
          from data_protection_gateway_events
         where tenant_id = ${tenantId} and created_at >= ${since}
      `,
      this.database<{ blockedMessages: number; secret: number }[]>`
        select count(*)::int as "blockedMessages", coalesce(sum(secret_count), 0)::int as secret
          from data_protection_input_blocks
         where tenant_id = ${tenantId} and created_at >= ${since}
      `,
    ])
    return { ...gateway!, blockedMessages: blocks!.blockedMessages, secret: gateway!.secret + blocks!.secret }
  }

  async getRecords(filter: DataProtectionFilter, page: number, pageSize: number): Promise<DataProtectionRecordPage> {
    const sql = this.database
    const since = this.since(filter)
    const category = filter.category ?? null
    const employee = filter.employee ? `%${filter.employee.replace(/[\\%_]/g, '\\$&')}%` : null
    const scoped = sql`
      with hits as (
        select e.id, e.created_at, e.user_id, 'masked' as action, e.run_id, e.attempt_id, e.provider_key, e.model_key, e.endpoint,
               e.trust_level, e.secret_count, e.personal_count, e.term_count, e.has_image, null::text as entry, null::text as session_id
          from data_protection_gateway_events e
         where e.tenant_id = ${tenantId} and e.action = 'masked' and e.created_at >= ${since}
        union all
        select b.id, b.created_at, b.user_id, 'blocked', null, null, null, null, null,
               null, b.secret_count, 0, 0, false, b.entry, b.session_id
          from data_protection_input_blocks b
         where b.tenant_id = ${tenantId} and b.created_at >= ${since}
      ),
      rows as (
        select h.*, coalesce(u.display_name, h.user_id, '—') as employee_name,
               coalesce(nullif(btrim(u.department_id), ''), ${UNASSIGNED_DEPARTMENT}) as department,
               coalesce(mp.name, h.provider_key) as provider_name,
               case when h.action = 'blocked' then
                      case when h.entry like 'automation%' then 'automation' when h.entry = 'task-execution' then 'api' else 'conversation' end
                    when ra.manifest->>'purpose' = ${RELEASE_TRIAL_PURPOSE} then 'validation'
                    else coalesce(${sql.json(RUN_SOURCE_BY_TASK_TYPE)}::jsonb ->> t.source_type, 'system') end as source
          from hits h
          left join users u on u.tenant_id = ${tenantId} and u.id = h.user_id
          left join runs r on r.tenant_id = ${tenantId} and r.id = h.run_id
          left join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
          left join run_attempts ra on ra.tenant_id = ${tenantId} and ra.id = h.attempt_id
          left join model_providers mp on mp.tenant_id = ${tenantId} and mp.key = h.provider_key
         where (${filter.action ?? null}::text is null or h.action = ${filter.action ?? null})
           and (${category}::text is null
                or (${category} = 'secret' and h.secret_count > 0)
                or (${category} = 'personal' and h.personal_count > 0)
                or (${category} = 'term' and h.term_count > 0))
           and (${employee}::text is null or coalesce(u.display_name, h.user_id) ilike ${employee})
      )
    `
    const [items, [count]] = await Promise.all([
      sql<(Omit<DataProtectionRecord, 'time'> & { time: Date })[]>`
        ${scoped}
        select id, created_at as "time", user_id as "employeeId", employee_name as "employeeName", department, source, action,
               secret_count as secret, personal_count as personal, term_count as term,
               run_id as "runId", attempt_id as "attemptId", provider_name as "providerName", model_key as model, endpoint,
               trust_level as "trustLevel", has_image as "hasImage", entry, session_id as "sessionId"
          from rows order by created_at desc, id desc
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `,
      sql<{ total: number }[]>`${scoped} select count(*)::int as total from rows`,
    ])
    return { items: items.map(row => ({ ...row, time: row.time.toISOString() })), total: count!.total, page, pageSize }
  }

  async listTerms(): Promise<DataProtectionTermRecord[]> {
    const rows = await this.database<(Omit<DataProtectionTermRecord, 'createdAt'> & { createdAt: Date })[]>`
      select id, value, case_sensitive as "caseSensitive", whole_word as "wholeWord", created_at as "createdAt"
        from data_protection_terms where tenant_id = ${tenantId} order by created_at desc, id desc
    `
    return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))
  }

  /** 变更和审计同一事务提交；审计只记条数，不记词条内容（方案 5.8）。 */
  private async audit(transaction: TransactionSql, actorId: string, action: string, detail: string) {
    await transaction`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, ${action}, 'data_protection', 'data-protection', 'success',
              ${`trace-data-protection-${randomUUID()}`}, ${transaction.json({ detail })})
    `
  }

  async addTerms(terms: DataProtectionTermInput[], actorId: string): Promise<{ added: number; skipped: number }> {
    return this.database.begin(async (transaction) => {
      // 串行化同租户的导入，上限校验才可靠。
      await transaction`select pg_advisory_xact_lock(hashtext(${`data-protection-terms:${tenantId}`}))`
      const rows = terms.map(term => [`dpt-${randomUUID()}`, term.value, term.caseSensitive, term.wholeWord])
      const inserted = await transaction<{ id: string }[]>`
        insert into data_protection_terms (id, tenant_id, value, case_sensitive, whole_word)
        select item.id, ${tenantId}, item.value, item.case_sensitive::boolean, item.whole_word::boolean
          from jsonb_to_recordset(${transaction.json(rows.map(([id, value, caseSensitive, wholeWord]) => ({ id, value, case_sensitive: caseSensitive, whole_word: wholeWord })))})
               as item(id text, value text, case_sensitive boolean, whole_word boolean)
        on conflict (tenant_id, value) do nothing
        returning id
      `
      const [count] = await transaction<{ total: number }[]>`select count(*)::int as total from data_protection_terms where tenant_id = ${tenantId}`
      if (count!.total > DATA_PROTECTION_MAX_TERMS) throw stateConflict(`保密词表最多 ${DATA_PROTECTION_MAX_TERMS} 条`)
      const skipped = terms.length - inserted.length
      await this.audit(transaction, actorId, 'data-protection.terms.add', `新增 ${inserted.length} 条，跳过 ${skipped} 条`)
      return { added: inserted.length, skipped }
    })
  }

  async removeTerm(id: string, actorId: string): Promise<{ removed: boolean }> {
    return this.database.begin(async (transaction) => {
      const result = await transaction`delete from data_protection_terms where tenant_id = ${tenantId} and id = ${id}`
      if (result.count > 0) await this.audit(transaction, actorId, 'data-protection.terms.remove', '删除 1 条')
      return { removed: result.count > 0 }
    })
  }

  async listAllowlist(): Promise<DataProtectionAllowRecord[]> {
    const rows = await this.database<(Omit<DataProtectionAllowRecord, 'createdAt'> & { createdAt: Date })[]>`
      select id, value, created_at as "createdAt"
        from data_protection_allowlist where tenant_id = ${tenantId} order by created_at desc, id desc
    `
    return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))
  }

  async addAllow(value: string, actorId: string): Promise<{ added: boolean }> {
    return this.database.begin(async (transaction) => {
      const inserted = await transaction<{ id: string }[]>`
        insert into data_protection_allowlist (id, tenant_id, value)
        values (${`dpa-${randomUUID()}`}, ${tenantId}, ${value})
        on conflict (tenant_id, value) do nothing
        returning id
      `
      if (inserted.length > 0) await this.audit(transaction, actorId, 'data-protection.allowlist.add', '新增 1 条')
      return { added: inserted.length > 0 }
    })
  }

  async removeAllow(id: string, actorId: string): Promise<{ removed: boolean }> {
    return this.database.begin(async (transaction) => {
      const result = await transaction`delete from data_protection_allowlist where tenant_id = ${tenantId} and id = ${id}`
      if (result.count > 0) await this.audit(transaction, actorId, 'data-protection.allowlist.remove', '删除 1 条')
      return { removed: result.count > 0 }
    })
  }

  /** 用真实引擎和当前词表预览，只返回给页面，不写审计。占位符用一次性密钥，不需要环境主密钥。 */
  async preview(text: string): Promise<DataProtectionPreview> {
    const policy = await this.store.loadPolicy(tenantId)
    const result = maskTexts([text], { tenantKey: randomBytes(32), policy })
    return {
      maskedText: result.texts[0] ?? '',
      ...result.counts,
      wouldBlock: inspectMessageForSecrets(text, policy).secretCount > 0,
    }
  }
}
