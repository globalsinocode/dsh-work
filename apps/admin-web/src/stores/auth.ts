import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import { adminApi } from '../api/client'
import type { AdminRole, AdminSession, AdminUserProfile } from '../types/domain'
import { ADMIN_MODULES, emptyModuleLevels, moduleLevelsOf, type AdminModule, type AdminModuleLevels, type AdminRouteOwner } from '../utils/admin-modules'

export const roleLabels: Record<AdminRole, string> = {
  business_admin: '业务管理员',
  platform_admin: '平台管理员',
  auditor: '安全审计员',
}

const loadingUser: AdminUserProfile = {
  id: '—',
  name: '正在加载',
  title: '',
  department: '—',
  avatarText: '…',
  role: 'auditor',
  dataScopes: [],
}

export const useAuthStore = defineStore('admin-auth', () => {
  const sessionUser = ref<AdminUserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const error = ref('')
  const identityProvider = ref<AdminSession['identityProvider'] | null>(null)
  const permissions = ref<string[]>([])
  /** 会话返回的模块级别；旧服务端或测试只给权限码时为空，由权限码推算。 */
  const sessionModules = ref<Partial<AdminModuleLevels> | null>(null)
  const moduleLevels = computed<AdminModuleLevels>(() => (
    sessionModules.value ? { ...emptyModuleLevels(), ...sessionModules.value } : moduleLevelsOf(permissions.value)
  ))
  const platformAdmin = computed(() => permissions.value.includes('admin:*'))
  const user = computed(() => sessionUser.value ?? loadingUser)
  /** 持有任一模块管理权限（能使用管理助手与接入文档，管理端模块权限方案 AP15）。 */
  const canReadAdmin = computed(() => ADMIN_MODULES.some(module => moduleLevels.value[module] !== 'none'))
  const canRead = (module: AdminModule) => moduleLevels.value[module] !== 'none'
  const canWrite = (module: AdminModule) => moduleLevels.value[module] === 'write'
  /** 路由或菜单的归属是否可见：模块需要查看级别，any 需要任一模块权限，audit 需要审计读取。 */
  const canSee = (owner: AdminRouteOwner | string | undefined) => {
    if (!owner || owner === 'any') return canReadAdmin.value
    if (owner === 'audit') return canReadAudit.value
    return (ADMIN_MODULES as readonly string[]).includes(owner) && canRead(owner as AdminModule)
  }
  const canReadAudit = computed(() => hasPermission(
    permissions.value,
    'audit:read',
  ))
  /** @deprecated 只表示“持有全部模块修改权限”；页面改用 canWrite(模块)。 */
  const canManage = computed(() => ADMIN_MODULES.every(module => module === 'ops' || moduleLevels.value[module] === 'write'))
  const canManageIdentity = computed(() => canWrite('identity'))
  const canAccessDataProtectionTerms = computed(() => hasPermission(permissions.value, 'data-protection:terms'))
  const identityAdministrationAvailable = computed(() => (
    identityProvider.value === 'ai-hub-oidc' || identityProvider.value === 'local-password'
  ))
  const canAccessAdmin = computed(() =>
    sessionUser.value !== null && (canReadAdmin.value || canReadAudit.value || canManage.value),
  )

  /**
   * 落地页（方案 AP15）：有运营查看时进运营概览，否则进第一个能看的模块页面，都没有时进审计或管理助手。
   * 顺序与侧栏一致。
   */
  function landingRoute(): string {
    if (canRead('ops')) return '/overview'
    const order: Array<[AdminModule, string]> = [
      ['agent', '/agents'], ['skill', '/skills'], ['connector', '/connectors'], ['model', '/model-governance'],
      ['knowledge', '/knowledge'], ['identity', '/identity'], ['org', '/organization'], ['dingtalk', '/dingtalk'], ['dlp', '/data-protection'],
    ]
    // 员工与权限、钉钉集成只在受管身份下可用，否则路由守卫会把它们转回概览（requiresManagedIdentity）。
    const first = order.find(([module, path]) => canRead(module)
      && (identityAdministrationAvailable.value || (path !== '/identity' && path !== '/dingtalk')))
    if (first) return first[1]
    if (canReadAudit.value) return '/audit'
    return '/assistant'
  }
  let pendingLoad: Promise<void> | undefined

  async function load() {
    if (initialized.value) return
    if (pendingLoad) return pendingLoad
    pendingLoad = (async () => {
      loading.value = true
      error.value = ''
      try {
        const session = await adminApi.getSession()
        sessionUser.value = session.user
        identityProvider.value = session.identityProvider
        permissions.value = [...session.permissions]
        sessionModules.value = session.adminModules ?? null
        initialized.value = true
      } catch (cause) {
        sessionUser.value = null
        identityProvider.value = null
        permissions.value = []
        sessionModules.value = null
        error.value = cause instanceof Error ? cause.message : '登录会话加载失败'
        throw cause
      } finally {
        loading.value = false
        pendingLoad = undefined
      }
    })()
    return pendingLoad
  }

  function login(returnTo = currentReturnTo()) {
    window.location.assign(`/auth/admin/login?return_to=${encodeURIComponent(returnTo)}`)
  }

  function switchAccount(returnTo = '/overview') {
    window.location.assign(`/auth/admin/switch-account?return_to=${encodeURIComponent(returnTo)}`)
  }

  async function logout() {
    if (identityProvider.value === 'local-password') {
      try {
        const response = await fetch('/auth/admin/logout', { method: 'POST', credentials: 'same-origin' })
        if (!response.ok) throw new Error('退出登录失败，请重试')
        window.location.assign('/login')
      } catch (cause) {
        ElMessage.error(cause instanceof Error ? cause.message : '退出登录失败')
      }
      return
    }
    sessionUser.value = null
    identityProvider.value = null
    permissions.value = []
    initialized.value = false
    window.location.assign('/auth/admin/logout')
  }

  return {
    user,
    canAccessAdmin,
    canReadAdmin,
    canReadAudit,
    canManage,
    canManageIdentity,
    canAccessDataProtectionTerms,
    moduleLevels,
    platformAdmin,
    canRead,
    canWrite,
    canSee,
    landingRoute,
    identityAdministrationAvailable,
    initialized,
    loading,
    error,
    identityProvider,
    permissions,
    load,
    login,
    logout,
    switchAccount,
  }
})

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function hasPermission(permissions: string[], ...expected: string[]) {
  const granted = new Set(permissions)
  return granted.has('admin:*') || expected.some(permission => granted.has(permission))
}
