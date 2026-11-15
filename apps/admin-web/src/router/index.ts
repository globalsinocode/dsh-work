import { createRouter, createWebHistory } from 'vue-router'

import { pinia } from '@/stores'
import type { AdminRouteOwner } from '@/utils/admin-modules'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/login', name: 'local-login', component: () => import('@/views/LocalLoginView.vue'), meta: { title: '登录', public: true } },
    { path: '/change-password', name: 'change-password', component: () => import('@/views/LocalLoginView.vue'), meta: { title: '修改密码', public: true } },
    { path: '/', redirect: '/overview' },
    { path: '/admin', redirect: '/overview' },
    { path: '/admin/overview', redirect: '/overview' },
    { path: '/admin/assistant', redirect: '/assistant' },
    { path: '/admin/agents', redirect: '/agents' },
    { path: '/admin/capabilities', redirect: to => legacyCapabilityRedirect(to.query.tab) },
    { path: '/admin/skills', redirect: '/skills' },
    { path: '/admin/tools', redirect: '/runtimes' },
    { path: '/tools', redirect: '/runtimes' },
    { path: '/admin/connectors', redirect: '/connectors' },
    { path: '/admin/runtimes', redirect: '/runtimes' },
    { path: '/admin/sessions', redirect: '/sessions' },
    { path: '/admin/workspaces', redirect: '/workspaces' },
    { path: '/admin/model-usage', redirect: '/model-usage' },
    { path: '/admin/model-governance', redirect: '/model-governance' },
    { path: '/admin/permissions', redirect: '/runtimes' },
    { path: '/permissions', redirect: '/runtimes' },
    { path: '/admin/identity', redirect: '/identity' },
    { path: '/admin/audit', redirect: '/audit' },
    { path: '/admin/health', redirect: '/health' },
    { path: '/admin/approvals', redirect: '/approvals' },
    { path: '/admin/experience-iterations', redirect: '/experience-iterations' },
    {
      path: '/login-error',
      name: 'auth-error',
      component: () => import('@/views/AuthErrorView.vue'),
      meta: { title: '登录失败', public: true },
    },
    {
      path: '/no-access',
      name: 'module-forbidden',
      component: () => import('@/views/ModuleAccessDeniedView.vue'),
      meta: { title: '无权访问', requiresAdmin: true },
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
      meta: { title: '运营概览', requiresAdmin: true, module: 'ops' },
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: () => import('@/views/AdminAssistantView.vue'),
      meta: { title: '管理助手', requiresAdmin: true, module: 'any' },
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentManagementView.vue'),
      meta: { title: 'Agent 管理', requiresAdmin: true, module: 'agent' },
    },
    {
      path: '/agents/:agentId',
      name: 'agent-detail',
      component: () => import('@/views/AgentDetailView.vue'),
      meta: { title: 'Agent 详情', requiresAdmin: true, module: 'agent' },
      // 编辑类分区已移到草稿编辑流程：旧的验证与发布地址进入流程最后一步，旧的定义分区落到只读概览。
      beforeEnter: to => {
        const section = String(to.query.section ?? '')
        if (section === 'release') {
          return { name: 'agent-draft', params: to.params, query: { step: 'release' } }
        }
        if (section === 'profile' || section === 'capabilities') {
          return { name: 'agent-detail', params: to.params, query: { ...to.query, section: 'overview' } }
        }
        return true
      },
    },
    {
      path: '/agents/:agentId/draft',
      name: 'agent-draft',
      component: () => import('@/views/AgentDraftView.vue'),
      meta: { title: '编辑 Agent', requiresAdmin: true, module: 'agent' },
    },
    {
      path: '/agents/:agentId/release/:step(definition|checks|trial|review)?',
      redirect: to => ({ name: 'agent-draft', params: { agentId: to.params.agentId }, query: { step: 'release' } }),
    },
    {
      path: '/capabilities',
      redirect: to => legacyCapabilityRedirect(to.query.tab),
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'Skill 管理', requiresAdmin: true, module: 'skill' },
    },
    {
      path: '/skills/review',
      name: 'skill-review',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'Skill 待审核', requiresAdmin: true, module: 'skill' },
    },
    {
      path: '/skills/install',
      name: 'skill-install',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: '新增 Skill', requiresAdmin: true, module: 'skill' },
    },
    {
      path: '/connectors',
      name: 'connectors',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'MCP 连接器', requiresAdmin: true, module: 'connector' },
    },
    {
      path: '/mcp-reconciliation',
      name: 'mcp-reconciliation',
      component: () => import('@/views/McpReconciliationView.vue'),
      meta: { title: '调用对账', requiresAdmin: true, module: 'connector' },
    },
    {
      path: '/model-governance',
      name: 'model-governance',
      component: () => import('@/views/ModelGovernanceView.vue'),
      meta: { title: '模型治理', requiresAdmin: true, module: 'model' },
    },
    {
      path: '/model-usage',
      name: 'model-usage',
      component: () => import('@/views/ModelUsageView.vue'),
      meta: { title: '模型用量', requiresAdmin: true, module: 'model' },
    },
    {
      path: '/data-protection',
      name: 'data-protection',
      component: () => import('@/views/DataProtectionView.vue'),
      meta: { title: '数据防护', subtitle: '发往外部厂商的内容按规则遮盖，员工消息含密钥时不发送', requiresAdmin: true, module: 'dlp' },
    },
    {
      path: '/runtimes',
      name: 'runtimes',
      component: () => import('@/views/RuntimeManagementView.vue'),
      meta: { title: 'Runtimes', requiresAdmin: true, module: 'connector' },
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/views/SessionManagementView.vue'),
      meta: { title: 'Session 列表', requiresAdmin: true, module: 'ops' },
    },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspaceManagementView.vue'),
      meta: { title: '工作空间', requiresAdmin: true, module: 'ops' },
    },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: () => import('@/views/KnowledgeAdminView.vue'),
      meta: {
        title: '企业知识库',
        subtitle: '管理 WeKnora 连接、全部知识库与跨部门授权。文档由归属部门的员工在员工端上传和维护。',
        requiresAdmin: true,
        module: 'knowledge',
      },
    },
    {
      path: '/organization',
      name: 'organization',
      component: () => import('@/views/OrganizationView.vue'),
      meta: {
        title: '组织架构',
        subtitle: '维护部门树和员工的部门归属；员工的“部门”显示为其主部门。',
        requiresAdmin: true,
        module: 'org',
      },
    },
    {
      path: '/identity',
      name: 'identity',
      component: () => import('@/views/IdentityAccessView.vue'),
      meta: {
        title: '员工与权限',
        requiresAdmin: true,
        module: 'identity',
        requiresManagedIdentity: true,
      },
    },
    {
      path: '/dingtalk',
      name: 'dingtalk',
      component: () => import('@/views/DingTalkIntegrationView.vue'),
      meta: {
        title: '钉钉集成',
        subtitle: '钉钉工作通知与钉钉内打开员工端：应用配置、绑定情况、离职检查与未绑定名单。',
        requiresAdmin: true,
        module: 'dingtalk',
        requiresManagedIdentity: true,
      },
    },
    {
      path: '/experience-iterations',
      name: 'experience-iterations',
      component: () => import('@/views/ExperienceIterationView.vue'),
      meta: {
        title: '经验迭代',
        subtitle: '按稳定 Agent 归属；申请来自成功的 Run/Attempt，经管理员审核后发布不可变经验版本，不会自动修改 Soul、Skill 或权限。',
        requiresAdmin: true,
        module: 'agent',
      },
    },
    {
      path: '/approvals',
      name: 'approvals',
      component: () => import('@/views/ApprovalManagementView.vue'),
      meta: { title: '动作审批', requiresAdmin: true, module: 'agent' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('@/views/AuditView.vue'),
      meta: { title: '审计记录', requiresAdmin: true, module: 'audit' },
    },
    {
      path: '/health',
      name: 'health',
      component: () => import('@/views/SystemHealthView.vue'),
      meta: { title: '系统健康', requiresAdmin: true, module: 'ops' },
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
    if (cause instanceof Error && 'code' in cause && cause.code === 'password_change_required') {
      return { name: 'change-password', query: { return_to: to.fullPath } }
    }
    const status = errorStatus(cause)
    if (status === 401) {
      authStore.login(to.fullPath)
      return false
    }
    if (status === 403) return { name: 'forbidden' }
    return { name: 'auth-error', query: { code: 'session_unavailable' } }
  }
  if (to.meta.requiresManagedIdentity && !authStore.identityAdministrationAvailable) {
    return { name: 'overview' }
  }
  if (to.meta.requiresAdmin && !authStore.canAccessAdmin) return { name: 'forbidden' }
  // 管理端模块权限方案 AP15：根地址与 /overview 落到有权限的第一个页面；直接打开无权页面显示“无权访问”。
  if (to.name === 'overview' && !authStore.canRead('ops')) {
    const landing = authStore.landingRoute()
    if (landing !== '/overview') return landing
  }
  const owner = to.meta.module as AdminRouteOwner | undefined
  if (to.meta.requiresAdmin && owner && !authStore.canSee(owner)) {
    return { name: 'module-forbidden', query: { module: owner, from: to.fullPath } }
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
  if (tab === 'tools') return '/runtimes'
  if (tab === 'connectors') return '/connectors'
  return '/skills'
}
