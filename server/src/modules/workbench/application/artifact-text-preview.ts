import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { BINARY_TEXT_TYPES, CONTAINER_EXTRACTOR_VERSION } from './container-artifact-text-extractor.ts'

/** Extractions whose text can be mounted as a Run input or previewed: uploads and text artifacts, and binary artifacts (2b-3). */
export const TEXT_EXTRACTOR_VERSIONS = ['m4-basic-v1', CONTAINER_EXTRACTOR_VERSION]

/** Preview state of an Office/PDF artifact's extracted text (2b-5); null for every other type. */
export type ArtifactTextPreviewState = 'available' | 'failed' | 'pending'

/**
 * Select-list fragment for artifact rows aliased `a` (artifacts) and `f` (file_objects):
 * `textPreview` is the latest extraction's outcome for Office/PDF artifacts (`pending` while
 * none exists), and `textPreviewError` the failure message when it failed.
 */
export function artifactTextPreviewColumns(database: DatabaseClient) {
  return database`
    case when a.artifact_type = any(${BINARY_TEXT_TYPES as string[]}) then coalesce((
      select case when fe.status = 'succeeded' then 'available' else 'failed' end
        from file_extractions fe
       where fe.tenant_id = f.tenant_id and fe.file_id = f.id and fe.extractor_version = any(${TEXT_EXTRACTOR_VERSIONS})
       order by fe.created_at desc, fe.id desc limit 1
    ), 'pending') end as "textPreview",
    case when a.artifact_type = any(${BINARY_TEXT_TYPES as string[]}) then (
      select case when fe.status = 'failed' then fe.error_message end
        from file_extractions fe
       where fe.tenant_id = f.tenant_id and fe.file_id = f.id and fe.extractor_version = any(${TEXT_EXTRACTOR_VERSIONS})
       order by fe.created_at desc, fe.id desc limit 1
    ) end as "textPreviewError"
  `
}

/** Copies the preview columns onto an API artifact, leaving them out for types without a text preview. */
export function withTextPreview<T extends object>(
  artifact: T,
  row: { textPreview?: ArtifactTextPreviewState | null; textPreviewError?: string | null },
): T & { textPreview?: ArtifactTextPreviewState; textPreviewError?: string } {
  if (!row.textPreview) return artifact
  return {
    ...artifact,
    textPreview: row.textPreview,
    ...(row.textPreview === 'failed' && row.textPreviewError ? { textPreviewError: row.textPreviewError } : {}),
  }
}
