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
    { path: '/admin/capabilities', redirect: to => legacyCapabilityRedirect(to.query.tab) },
    { path: '/admin/skills', redirect: '/skills' },
    { path: '/admin/tools', redirect: '/tools' },
    { path: '/admin/connectors', redirect: '/connectors' },
    { path: '/admin/runtimes', redirect: '/runtimes' },
    { path: '/admin/sessions', redirect: '/sessions' },
    { path: '/admin/workspaces', redirect: '/workspaces' },
    { path: '/admin/model-usage', redirect: '/model-usage' },
    { path: '/admin/model-governance', redirect: '/model-governance' },
    { path: '/admin/permissions', redirect: '/permissions' },
    { path: '/admin/identity', redirect: '/identity' },
    { path: '/admin/audit', redirect: '/audit' },
    { path: '/admin/health', redirect: '/health' },
    { path: '/admin/approvals', redirect: '/approvals' },
    { path: '/admin/memories', redirect: '/memories' },
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
      path: '/agents/:agentId/release',
      redirect: to => ({ name: 'agent-release-definition', params: { agentId: to.params.agentId } }),
    },
    {
      path: '/agents/:agentId/release/definition',
      name: 'agent-release-definition',
      component: () => import('@/views/AgentReleaseWorkbenchView.vue'),
      meta: { title: 'Agent 发布工作台 · 定义与依赖', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/agents/:agentId/release/checks',
      name: 'agent-release-checks',
      component: () => import('@/views/AgentReleaseWorkbenchView.vue'),
      meta: { title: 'Agent 发布工作台 · 检查与案例', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/agents/:agentId/release/trial',
      name: 'agent-release-trial',
      component: () => import('@/views/AgentReleaseWorkbenchView.vue'),
      meta: { title: 'Agent 发布工作台 · 试运行', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/agents/:agentId/release/review',
      name: 'agent-release-review',
      component: () => import('@/views/AgentReleaseWorkbenchView.vue'),
      meta: { title: 'Agent 发布工作台 · 审核发布', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/capabilities',
      redirect: to => legacyCapabilityRedirect(to.query.tab),
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'Skill 管理', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/skills/install',
      name: 'skill-install',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: '新增 Skill', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/tools',
      name: 'tools',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'DSH 工具管理', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/connectors',
      name: 'connectors',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'MCP 连接器', requiresAdmin: true, requiredPermission: 'adminRead' },
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
      path: '/memories',
      name: 'memories',
      component: () => import('@/views/MemoryGovernanceView.vue'),
      meta: { title: '受控记忆', requiresAdmin: true, requiredPermission: 'adminRead' },
    },
    {
      path: '/approvals',
      name: 'approvals',
      component: () => import('@/views/ApprovalManagementView.vue'),
      meta: { title: '动作审批', requiresAdmin: true, requiredPermission: 'adminRead' },
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
      path: '/docs/guide',
      name: 'docs-guide',
      component: () => import('@/views/IntegrationGuideView.vue'),
      meta: { title: '接入规范', requiresAdmin: true },
    },
    {
      path: '/docs/api',
      name: 'docs-api',
      component: () => import('@/views/ApiDocsView.vue'),
      meta: { title: '接口文档', requiresAdmin: true },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
      meta: { title: '关于 dsh-work', requiresAdmin: true },
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

function legacyCapabilityRedirect(tab: unknown) {
  if (tab === 'install') return '/skills/install'
  if (tab === 'tools') return '/tools'
  if (tab === 'connectors') return '/connectors'
  return '/skills'
}
