import {
  defaultUserPreferences,
  type UserPreferenceStore,
  type UserPreferences,
  type UserPreferencesUpdate,
} from '../../modules/workbench/application/user-preferences.ts'

/** P0 冒烟用的内存偏好：随 `/api/testing/p0/reset` 重建，每个用例从缺省（工作模式）开始。 */
export class MemoryUserPreferenceStore implements UserPreferenceStore {
  private readonly rows = new Map<string, UserPreferences>()

  async getPreferences(userId: string): Promise<UserPreferences> {
    return { ...(this.rows.get(userId) ?? defaultUserPreferences) }
  }

  async updatePreferences(userId: string, update: UserPreferencesUpdate): Promise<UserPreferences> {
    const row = { uiMode: update.uiMode, updatedAt: new Date().toISOString() }
    this.rows.set(userId, row)
    return { ...row }
  }
}
