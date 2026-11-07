import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { ModelGatewayRequestLog, ModelGatewayRequestRecord } from './model-gateway-types.ts'

export class PostgresModelGatewayRequestLog implements ModelGatewayRequestLog {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async record(record: ModelGatewayRequestRecord): Promise<void> {
    await this.database`
      insert into model_gateway_requests (
        id, tenant_id, run_id, attempt_id, route_id, provider_key, model_key, endpoint, origin, outcome,
        http_status, error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at, finished_at
      ) values (
        ${record.id}, ${record.tenantId}, ${record.runId}, ${record.attemptId}, ${record.routeId}, ${record.providerKey},
        ${record.modelKey}, ${record.endpoint}, ${record.origin}, ${record.outcome}, ${record.httpStatus}, ${record.errorCode},
        ${record.inputTokens}, ${record.outputTokens}, ${record.cacheReadTokens}, ${record.cacheWriteTokens},
        ${record.startedAt}, ${record.finishedAt}
      )
    `
  }

  async listForAttempt(tenantId: string, attemptId: string): Promise<ModelGatewayRequestRecord[]> {
    const rows = await this.database<(Omit<ModelGatewayRequestRecord, 'startedAt' | 'finishedAt'> & { startedAt: Date; finishedAt: Date })[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId", route_id as "routeId",
             provider_key as "providerKey", model_key as "modelKey", endpoint, origin, outcome,
             http_status as "httpStatus", error_code as "errorCode", input_tokens as "inputTokens",
             output_tokens as "outputTokens", cache_read_tokens as "cacheReadTokens", cache_write_tokens as "cacheWriteTokens",
             started_at as "startedAt", finished_at as "finishedAt"
        from model_gateway_requests
       where tenant_id = ${tenantId} and attempt_id = ${attemptId}
       order by finished_at, id
    `
    return rows.map(row => ({ ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt.toISOString() }))
  }
}

export class MemoryModelGatewayRequestLog implements ModelGatewayRequestLog {
  readonly records: ModelGatewayRequestRecord[] = []

  async record(record: ModelGatewayRequestRecord): Promise<void> {
    this.records.push(structuredClone(record))
  }

  async listForAttempt(tenantId: string, attemptId: string): Promise<ModelGatewayRequestRecord[]> {
    return this.records
      .filter(record => record.tenantId === tenantId && record.attemptId === attemptId)
      .sort((left, right) => left.finishedAt.localeCompare(right.finishedAt))
      .map(record => structuredClone(record))
  }
}
