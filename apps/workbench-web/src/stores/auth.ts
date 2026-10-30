import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import { WorkbenchApiError, workbenchApi } from '../api/client'
import { unregisterPushBeforeLogout } from '../composables/useSystemNotifications'
import type { UserProfile, UserRole, WorkbenchSession } from '../types/domain'

export const roleLabels: Record<UserRole, string> = {
  employee: '普通员工',
  department_manager: '部门负责人',
  business_admin: '业务管理员',
  platform_admin: '平台管理员',
  auditor: '安全审计员',
}

const loadingUser: UserProfile = {
  id: '—',
  name: '正在加载',
  title: '',
  department: '—',
  avatarText: '…',
  role: 'employee',
  dataScopes: [],
}

export const useAuthStore = defineStore('workbench-auth', () => {
  const sessionUser = ref<UserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const error = ref('')
  const identityProvider = ref<WorkbenchSession['identityProvider'] | null>(null)
  const user = computed(() => sessionUser.value ?? loadingUser)
  const canAccessAdmin = computed(() =>
    ['business_admin', 'platform_admin', 'auditor'].includes(user.value.role),
  )
  let pendingLoad: Promise<void> | undefined

  async function fetchAndApplySession() {
    loading.value = true
    error.value = ''
    try {
      const session = await workbenchApi.getSession()
      sessionUser.value = session.user
      identityProvider.value = session.identityProvider
      initialized.value = true
    } catch (cause) {
      if (cause instanceof WorkbenchApiError && cause.status === 401) {
        sessionUser.value = null
        identityProvider.value = null
        initialized.value = false
      } else if (cause instanceof WorkbenchApiError && cause.status === 403) {
        initialized.value = true
      } else {
        sessionUser.value = null
        identityProvider.value = null
        initialized.value = false
        error.value = cause instanceof Error ? cause.message : '登录会话加载失败'
      }
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    if (pendingLoad) return pendingLoad
    pendingLoad = fetchAndApplySession()
    try {
      await pendingLoad
    } finally {
      pendingLoad = undefined
    }
  }

  async function load() {
    if (initialized.value) return
    await refresh()
  }

  function login(returnTo = currentReturnTo()) {
    window.location.assign(`/auth/workbench/login?return_to=${encodeURIComponent(returnTo)}`)
  }

  function switchAccount(returnTo = '/workbench') {
    window.location.assign(`/auth/workbench/switch-account?return_to=${encodeURIComponent(returnTo)}`)
  }

  async function logout() {
    await unregisterPushBeforeLogout()
    if (identityProvider.value === 'local-password') {
      try {
        const response = await fetch('/auth/workbench/logout', { method: 'POST', credentials: 'same-origin' })
        if (!response.ok) throw new Error('退出登录失败，请重试')
        window.location.assign('/login')
      } catch (cause) {
        ElMessage.error(cause instanceof Error ? cause.message : '退出登录失败')
      }
      return
    }
    sessionUser.value = null
    identityProvider.value = null
    initialized.value = false
    window.location.assign('/auth/workbench/logout')
  }

  return {
    user,
    canAccessAdmin,
    initialized,
    loading,
    error,
    identityProvider,
    load,
    refresh,
    login,
    logout,
    switchAccount,
  }
})

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
