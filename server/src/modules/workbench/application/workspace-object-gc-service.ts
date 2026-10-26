import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { ObjectStorage } from '../../../domain/object-storage.ts'

const tenantId = 'tenant-dsh-work'
const GRACE_MS = 24 * 60 * 60 * 1000

export interface WorkspaceObjectGcRecordInput {
  storageKey: string
  objectSha256: string
  reasonCode: string
  notBefore?: Date
}

export class PostgresWorkspaceObjectGcRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async upsertCandidate(input: WorkspaceObjectGcRecordInput): Promise<void> {
    const notBefore = input.notBefore ?? new Date(Date.now() + GRACE_MS)
    await this.database`
      insert into workspace_object_gc_candidates (
        tenant_id, storage_key, object_sha256, reason_code, not_before, status, attempts, updated_at
      ) values (
        ${tenantId}, ${input.storageKey}, ${input.objectSha256}, ${input.reasonCode}, ${notBefore}, 'pending', 0, now()
      )
      on conflict (tenant_id, storage_key) do update set
        object_sha256 = excluded.object_sha256,
        reason_code = excluded.reason_code,
        not_before = greatest(workspace_object_gc_candidates.not_before, excluded.not_before),
        status = case
          when workspace_object_gc_candidates.status = 'deleted' then workspace_object_gc_candidates.status
          else 'pending'
        end,
        updated_at = now()
    `
  }

  async listDue(limit: number): Promise<Array<{ storageKey: string; objectSha256: string; attempts: number }>> {
    return this.database<{ storageKey: string; objectSha256: string; attempts: number }[]>`
      select storage_key as "storageKey", object_sha256 as "objectSha256", attempts
        from workspace_object_gc_candidates
       where tenant_id = ${tenantId}
         and status in ('pending', 'failed')
         and not_before <= now()
       order by not_before asc, storage_key asc
       limit ${limit}
       for update skip locked
    `
  }

  async isReferenced(storageKey: string, transaction?: DatabaseTransaction): Promise<boolean> {
    const db = transaction ?? this.database
    const [fileObject] = await db<{ count: number }[]>`
      select count(*)::integer as count from file_objects
       where tenant_id = ${tenantId} and storage_key = ${storageKey}
    `
    if ((fileObject?.count ?? 0) > 0) return true
    const [extractionText] = await db<{ count: number }[]>`
      select count(*)::integer as count from file_extractions
       where tenant_id = ${tenantId} and text_storage_key = ${storageKey}
    `
    if ((extractionText?.count ?? 0) > 0) return true
    const [attachment] = await db<{ count: number }[]>`
      select count(*)::integer as count from file_extractions fe
       where fe.tenant_id = ${tenantId}
         and exists (
           select 1 from jsonb_array_elements(coalesce(fe.attachments, '[]'::jsonb)) elem
            where elem->>'storage_key' = ${storageKey}
         )
    `
    return (attachment?.count ?? 0) > 0
  }

  async markDeleted(storageKey: string): Promise<void> {
    await this.database`
      update workspace_object_gc_candidates
         set status = 'deleted', updated_at = now()
       where tenant_id = ${tenantId} and storage_key = ${storageKey}
    `
  }

  async markRetained(storageKey: string): Promise<void> {
    await this.database`
      update workspace_object_gc_candidates
         set status = 'retained', updated_at = now()
       where tenant_id = ${tenantId} and storage_key = ${storageKey}
    `
  }

  async markFailed(storageKey: string, errorCode: string): Promise<void> {
    await this.database`
      update workspace_object_gc_candidates
         set status = 'failed',
             attempts = attempts + 1,
             last_error_code = ${errorCode},
             updated_at = now()
       where tenant_id = ${tenantId} and storage_key = ${storageKey}
    `
  }
}

export class WorkspaceObjectGcService {
  private readonly repository: PostgresWorkspaceObjectGcRepository
  private readonly storage: ObjectStorage

  constructor(database: DatabaseClient, storage: ObjectStorage, repository = new PostgresWorkspaceObjectGcRepository(database)) {
    this.repository = repository
    this.storage = storage
  }

  async record(input: WorkspaceObjectGcRecordInput): Promise<void> {
    await this.repository.upsertCandidate(input)
  }

  async sweep(limit = 100): Promise<{ deleted: number; retained: number; failed: number }> {
    const due = await this.repository.listDue(limit)
    let deleted = 0
    let retained = 0
    let failed = 0
    for (const candidate of due) {
      try {
        if (await this.repository.isReferenced(candidate.storageKey)) {
          await this.repository.markRetained(candidate.storageKey)
          retained += 1
          continue
        }
        await this.storage.deleteIfExists(candidate.storageKey)
        await this.repository.markDeleted(candidate.storageKey)
        deleted += 1
      } catch {
        await this.repository.markFailed(candidate.storageKey, 'OBJECT_DELETE_FAILED')
        failed += 1
      }
    }
    if (failed > 0) {
      console.warn(`workspace_object_gc_sweep_failed count=${failed}`)
    }
    return { deleted, retained, failed }
  }
}
