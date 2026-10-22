import {
  parseUserPreferencesUpdate,
  type UserPreferenceStore,
} from '../../modules/workbench/application/user-preferences.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * 本人的员工端偏好（S5a，D19）：界面模式按账号保存，跨设备一致。
 * 只读写当前登录账号自己的记录，不接受路径或请求体指定其他用户。
 */
export function registerUserPreferenceRoutes(
  router: Router,
  preferences: UserPreferenceStore,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/me/preferences`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    return envelope('workbench', await preferences.getPreferences(identity.userId), adapter)
  })

  router.put(`${basePath}/me/preferences`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const update = parseUserPreferencesUpdate(await readJsonBody<unknown>(request))
    return envelope('workbench', await preferences.updatePreferences(identity.userId, update), adapter)
  })
}
