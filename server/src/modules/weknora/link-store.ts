import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'

export type WeknoraLinkSource = 'bind' | 'directory'

export interface WeknoraUserLink {
  userId: string
  weknoraUserId: string
  linkSource: WeknoraLinkSource
}

export class WeknoraLinkStore {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async findByUserId(userId: string): Promise<WeknoraUserLink | null> {
    const [row] = await this.database<WeknoraUserLink[]>`
      select user_id as "userId", weknora_user_id as "weknoraUserId", link_source as "linkSource"
        from user_weknora_links
       where user_id = ${userId}
    `
    return row ?? null
  }

  async upsert(userId: string, weknoraUserId: string, linkSource: WeknoraLinkSource) {
    await this.database`
      insert into user_weknora_links (user_id, weknora_user_id, link_source, linked_at)
      values (${userId}, ${weknoraUserId}, ${linkSource}, now())
      on conflict (user_id) do update
        set weknora_user_id = excluded.weknora_user_id,
            link_source = excluded.link_source,
            linked_at = now()
    `
  }

  async delete(userId: string) {
    await this.database`delete from user_weknora_links where user_id = ${userId}`
  }

  async saveBindState(state: string, userId: string, expiresAt: Date) {
    await this.database`
      insert into weknora_bind_states (state, user_id, expires_at)
      values (${state}, ${userId}, ${expiresAt})
    `
  }

  async consumeBindState(state: string): Promise<string | null> {
    const [row] = await this.database<{ userId: string }[]>`
      delete from weknora_bind_states
       where state = ${state} and expires_at > now()
      returning user_id as "userId"
    `
    return row?.userId ?? null
  }

  async purgeExpiredBindStates() {
    await this.database`delete from weknora_bind_states where expires_at <= now()`
  }
}
