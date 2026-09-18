import { createRouter, createWebHistory } from 'vue-router'

import { pinia } from '@/stores'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/workbench' },
    {
      path: '/login-error',
      name: 'auth-error',
      component: () => import('@/views/AuthErrorView.vue'),
      meta: { title: '登录失败', section: 'dsh-work', public: true },
    },
    {
      path: '/forbidden',
      name: 'forbidden',
      component: () => import('@/views/AccessDeniedView.vue'),
      meta: { title: '无权访问', section: 'dsh-work', public: true },
    },
    {
      path: '/workbench',
      name: 'workbench',
      component: () => import('@/views/WorkbenchView.vue'),
      meta: { title: '新对话', section: '员工工作台' },
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('@/views/SkillPlazaView.vue'),
      meta: { title: 'Skill 广场', section: '员工工作台' },
    },
    {
      path: '/conversations/:id',
      name: 'conversation',
      component: () => import('@/views/ConversationView.vue'),
      meta: { title: '对话', section: '员工工作台' },
    },
    { path: '/tasks/:id', redirect: (to) => ({ name: 'conversation', params: { id: to.params.id } }) },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspacesView.vue'),
      meta: { title: '团队空间', section: '员工工作台' },
    },
    {
      path: '/workspaces/:id',
      name: 'workspace-detail',
      component: () => import('@/views/WorkspaceEntryView.vue'),
      meta: { title: '团队空间', section: '员工工作台' },
      children: [
        {
          // TW-10 空间内对话视图：团队会话在空间外壳内打开，不再跳到
          // 独立 /conversations 页；:conversationId 兼容 Run ID 与 Session ID。
          path: 'conversations/:conversationId',
          name: 'workspace-conversation',
          component: () => import('@/views/ConversationView.vue'),
          meta: { title: '对话', section: '员工工作台' },
        },
      ],
    },
    { path: '/files', name: 'my-files', component: () => import('@/views/MyFilesView.vue'), meta: { title: '我的文件', section: '员工工作台' } },
    { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue'), meta: { title: '历史对话', section: '员工工作台' } },
    { path: '/sessions/:id', name: 'session-detail', component: () => import('@/views/SessionResumeView.vue'), meta: { title: '对话', section: '员工工作台' } },
    {
      path: '/automations',
      name: 'automations',
      component: () => import('@/views/AutomationsView.vue'),
      meta: { title: '自动任务', section: '员工工作台' },
    },
    {
      path: '/artifacts',
      name: 'artifacts',
      redirect: { path: '/files', query: { source: 'artifact' } },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '用户中心', section: '员工工作台' },
    },
    {
      path: '/admin/:pathMatch(.*)*',
      redirect: () => ({ name: 'workbench' }),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在', section: 'dsh-work' },
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
  return true
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '员工工作台')} · dsh-work`
})

export default router

function errorStatus(cause: unknown) {
  if (typeof cause !== 'object' || cause === null || !('status' in cause)) return 0
  return typeof cause.status === 'number' ? cause.status : 0
}
