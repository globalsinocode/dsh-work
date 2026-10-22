import { invalidRequest } from '../../../domain/request-errors.ts'

/** 员工端界面模式（S5，D19）：work = A 工作模式（缺省），collab = B 协作模式。 */
export const uiModes = ['work', 'collab'] as const
export type UiMode = (typeof uiModes)[number]

export interface UserPreferences {
  uiMode: UiMode
  /** 最近一次保存的时间；从未保存过时为 null（全部取缺省值）。 */
  updatedAt: string | null
}

export interface UserPreferencesUpdate {
  uiMode: UiMode
}

export const defaultUserPreferences: UserPreferences = { uiMode: 'work', updatedAt: null }

/** 只按本人读写：调用方必须传入已认证请求的 userId，不接受客户端指定的用户。 */
export interface UserPreferenceStore {
  getPreferences(userId: string): Promise<UserPreferences>
  updatePreferences(userId: string, update: UserPreferencesUpdate): Promise<UserPreferences>
}

/** PUT /me/preferences 的请求体：只接受已知字段，未知字段与非法值一律 422。 */
export function parseUserPreferencesUpdate(body: unknown): UserPreferencesUpdate {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('偏好设置必须是 JSON 对象')
  }
  const unknownFields = Object.keys(body).filter(key => key !== 'uiMode')
  if (unknownFields.length) throw invalidRequest(`不支持的偏好设置：${unknownFields.join('、')}`)
  const uiMode = (body as { uiMode?: unknown }).uiMode
  if (typeof uiMode !== 'string' || !(uiModes as readonly string[]).includes(uiMode)) {
    throw invalidRequest('uiMode 只能是 work 或 collab')
  }
  return { uiMode: uiMode as UiMode }
}
