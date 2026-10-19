import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { isStrictResolvedPathInside } from '../../domain/host-path.ts'
import { assertObjectKey, ObjectNotFoundError, type ObjectStorage } from '../../domain/object-storage.ts'

/**
 * ObjectStorage on the local file system (single-node deployment). Objects are written to a
 * temporary file and hard-linked into place, so a crash never leaves a partial object and
 * a concurrent writer of the same key cannot replace an existing one. Reads refuse symlinks.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly root: string
  private readonly fileMode: number

  constructor(root: string, options: { fileMode?: number } = {}) {
    this.root = resolve(root)
    this.fileMode = options.fileMode ?? 0o600
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(key)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.tmp-${randomUUID()}`
    await writeFile(temporary, bytes, { flag: 'wx', mode: this.fileMode })
    try {
      await link(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async get(key: string): Promise<Buffer> {
    let handle
    try {
      handle = await open(this.pathFor(key), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key)
      throw error
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`存储对象不是普通文件：${key}`)
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  private pathFor(key: string) {
    assertObjectKey(key)
    const target = resolve(this.root, key)
    if (!isStrictResolvedPathInside(this.root, target)) throw new Error(`非法存储键：${key}`)
    return target
  }
}
