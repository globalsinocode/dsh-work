/**
 * Durable storage for immutable business objects: uploaded files, extracted text, run
 * artifacts and Skill folders. PostgreSQL holds the metadata and the key; the bytes live
 * behind this port so the local disk can later be replaced by NAS or object storage
 * without touching business services. Attempt working directories are not stored here;
 * they are local to the Runtime host.
 */
export interface ObjectStorage {
  /**
   * Writes an object once. Keys are unique or content-addressed, so an existing object
   * under the same key is kept and the call succeeds. Readers never see a partial object.
   */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<void>
  /** Reads an object; throws ObjectNotFoundError when the key has no object. */
  get(key: string): Promise<Buffer>
}

export class ObjectNotFoundError extends Error {
  readonly key: string

  constructor(key: string) {
    super(`存储对象不存在：${key}`)
    this.name = 'ObjectNotFoundError'
    this.key = key
  }
}

/** Keys are relative `/`-separated paths without empty, `.` or `..` segments. */
export function assertObjectKey(key: string): void {
  const segments = key.split('/')
  if (!key || key.length > 1024 || key.includes('\0') || key.includes('\\')
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`非法存储键：${JSON.stringify(key)}`)
  }
}
