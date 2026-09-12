import { createRouter, createWebHistory } from 'vue-router'

import { pinia } from '@/stores'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/admin', redirect: '/overview' },
    { path: '/admin/overview', redirect: '/overview' },
    { path: '/admin/assistant', redirect: '/assistant' },
    { path: '/admin/agents', redirect: '/agents' },
    { path: '/admin/capabilities', redirect: '/capabilities' },
    { path: '/admin/runtimes', redirect: '/runtimes' },
    { path: '/admin/sessions', redirect: '/sessions' },
    { path: '/admin/workspaces', redirect: '/workspaces' },
    { path: '/admin/model-usage', redirect: '/model-usage' },
    { path: '/admin/model-governance', redirect: '/model-governance' },
    { path: '/admin/permissions', redirect: '/permissions' },
    { path: '/admin/identity', redirect: '/identity' },
    { path: '/admin/audit', redirect: '/audit' },
    { path: '/admin/health', redirect: '/health' },
    {
      path: '/login-error',
      name: 'auth-error',
      component: () => import('@/views/AuthErrorView.vue'),
      meta: { title: '登录失败', public: true },
    },
    {
      path: '/forbidden',
      name: 'forbidden',
      component: () => import('@/views/AccessDeniedView.vue'),
      meta: { title: '无权访问', public: true },
    },
    {
      path: '/overview',
      name: 'overview',
      component: () => import('@/views/AdminOverviewView.vue'),
      meta: { title: '运营概览', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: () => import('@/views/AdminAssistantView.vue'),
      meta: { title: '管理助手', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentManagementView.vue'),
      meta: { title: 'Agent 管理', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/capabilities',
      name: 'capabilities',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'Skill 与工具', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/model-governance',
      name: 'model-governance',
      component: () => import('@/views/ModelGovernanceView.vue'),
      meta: { title: '模型治理', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/model-usage',
      name: 'model-usage',
      component: () => import('@/views/ModelUsageView.vue'),
      meta: { title: '模型用量', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/runtimes',
      name: 'runtimes',
      component: () => import('@/views/RuntimeManagementView.vue'),
      meta: { title: 'Runtimes', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/views/SessionManagementView.vue'),
      meta: { title: 'Session 列表', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspaceManagementView.vue'),
      meta: { title: '工作空间', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/identity',
      name: 'identity',
      component: () => import('@/views/IdentityAccessView.vue'),
      meta: {
        title: '员工与权限',
        requiresAdmin: true,
        requiredPermission: 'adminRead',
        requiresAiHubIdentity: true,
      },
    },
    {
      path: '/permissions',
      name: 'permissions',
      component: () => import('@/views/PermissionManagementView.vue'),
      meta: { title: '工具权限', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('@/views/AuditView.vue'),
      meta: { title: '审计记录', requiresAdmin: true, requiredPermission: 'auditRead' },
    },
    {
      path: '/health',
      name: 'health',
      component: () => import('@/views/SystemHealthView.vue'),
      meta: { title: '系统健康', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在' },
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  const authStore = useAuthStore(pinia)
  try {
    await authStore.load()
  } catch (cause) {
    const status = errorStatus(cause)
    if (status === 401) {
      authStore.login(to.fullPath)
      return false
    }
    if (status === 403) return { name: 'forbidden' }
    return { name: 'auth-error', query: { code: 'session_unavailable' } }
  }
  if (to.meta.requiresAiHubIdentity && !authStore.identityAdministrationAvailable) {
    return { name: 'overview' }
  }
  if (to.meta.requiresAdmin && !authStore.canAccessAdmin) return { name: 'forbidden' }
  if (to.meta.requiredPermission === 'adminRead' && !authStore.canReadAdmin) {
    return authStore.canReadAudit ? { name: 'audit' } : { name: 'forbidden' }
  }
  if (to.meta.requiredPermission === 'auditRead' && !authStore.canReadAudit) {
    return authStore.canReadAdmin ? { name: 'overview' } : { name: 'forbidden' }
  }
  return true
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '管理后台')} · dsh-work`
})

export default router

function errorStatus(cause: unknown) {
  if (typeof cause !== 'object' || cause === null || !('status' in cause)) return 0
  return typeof cause.status === 'number' ? cause.status : 0
}
