import type { AuditEvent } from './types.ts'

/**
 * Writes one structured, redacted audit event. Modules depend on this port instead of the
 * admin operations service, so recording an audit fact never couples them to admin.
 * Implemented by PostgresOperationsService.
 */
export interface AuditTrail {
  appendAudit(
    actorId: string,
    action: string,
    objectId: string,
    result: AuditEvent['status'],
    traceId: string,
    detail: string,
    objectType?: string,
  ): Promise<void>
}
