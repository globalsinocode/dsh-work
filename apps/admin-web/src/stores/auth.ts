import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import { adminApi } from '../api/client'
import type { AdminRole, AdminSession, AdminUserProfile } from '../types/domain'

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
  const user = computed(() => sessionUser.value ?? loadingUser)
  const canReadAdmin = computed(() => hasPermission(
    permissions.value,
    'admin:read',
    'admin:write',
  ))
  const canReadAudit = computed(() => hasPermission(
    permissions.value,
    'audit:read',
  ))
  const canManage = computed(() => hasPermission(
    permissions.value,
    'admin:write',
  ))
  const canManageIdentity = computed(() => permissions.value.includes('admin:*'))
  const identityAdministrationAvailable = computed(() => (
    identityProvider.value === 'ai-hub-oidc' || identityProvider.value === 'local-password'
  ))
  const canAccessAdmin = computed(() =>
    sessionUser.value !== null && (canReadAdmin.value || canReadAudit.value || canManage.value),
  )
  const isAuditor = computed(() => canReadAudit.value && !canManage.value)
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
        initialized.value = true
      } catch (cause) {
        sessionUser.value = null
        identityProvider.value = null
        permissions.value = []
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
    identityAdministrationAvailable,
    isAuditor,
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
