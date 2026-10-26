import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import {
  defaultUserPreferences,
  type UiMode,
  type UserPreferenceStore,
  type UserPreferences,
  type UserPreferencesUpdate,
} from './user-preferences.ts'

const tenantId = 'tenant-dsh-work'

interface PreferenceRow {
  uiMode: UiMode
  updatedAt: Date
}

/** 用户偏好（S5a）：一行一个账号，没有记录即全部缺省。 */
export class PostgresUserPreferenceService implements UserPreferenceStore {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    const [row] = await this.database<PreferenceRow[]>`
      select ui_mode as "uiMode", updated_at as "updatedAt"
        from user_preferences
       where tenant_id = ${tenantId} and user_id = ${userId}
    `
    return row ? toView(row) : { ...defaultUserPreferences }
  }

  async updatePreferences(userId: string, update: UserPreferencesUpdate): Promise<UserPreferences> {
    const [row] = await this.database<PreferenceRow[]>`
      insert into user_preferences (tenant_id, user_id, ui_mode, updated_at)
      values (${tenantId}, ${userId}, ${update.uiMode}, now())
      on conflict (tenant_id, user_id)
        do update set ui_mode = excluded.ui_mode, updated_at = excluded.updated_at
      returning ui_mode as "uiMode", updated_at as "updatedAt"
    `
    if (!row) throw new Error('用户偏好保存失败')
    return toView(row)
  }
}

function toView(row: PreferenceRow): UserPreferences {
  return { uiMode: row.uiMode, updatedAt: row.updatedAt.toISOString() }
}
