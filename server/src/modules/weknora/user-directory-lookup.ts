import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { WeknoraUserDirectoryLookup } from './access.ts'

export class PostgresWeknoraUserDirectoryLookup implements WeknoraUserDirectoryLookup {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async loadExternalUserId(userId: string): Promise<string | null> {
    const [row] = await this.database<{ externalUserId: string | null }[]>`
      select external_user_id as "externalUserId"
        from users
       where id = ${userId}
    `
    return row?.externalUserId ?? null
  }
}
