import { createRouter, createWebHistory } from 'vue-router'

import { pinia } from '@/stores'
import { useAuthStore } from '@/stores/auth'
import { useUiModeStore } from '@/stores/ui-mode'
import { locationForMode } from './mode-routes'

const collabPlaceholder = () => import('@/views/collab/CollabPlaceholderView.vue')
const collabChats = () => import('@/views/collab/CollabChatsView.vue')

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/login', name: 'local-login', component: () => import('@/views/LocalLoginView.vue'), meta: { title: '登录', public: true } },
    { path: '/change-password', name: 'change-password', component: () => import('@/views/LocalLoginView.vue'), meta: { title: '修改密码', public: true } },
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
      meta: { title: '新对话', section: '员工工作台', mode: 'work' },
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('@/views/SkillPlazaView.vue'),
      meta: { title: 'Skill 广场', section: '员工工作台' },
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentPlazaView.vue'),
      meta: { title: 'AI 同事', section: '员工工作台', mode: 'work' },
    },
    {
      path: '/conversations/:id',
      name: 'conversation',
      component: () => import('@/views/ConversationView.vue'),
      meta: { title: '对话', section: '员工工作台', mode: 'work' },
    },
    { path: '/tasks/:id', redirect: (to) => ({ name: 'conversation', params: { id: to.params.id } }) },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspacesView.vue'),
      meta: { title: '项目空间', section: '员工工作台', mode: 'work' },
    },
    {
      path: '/workspaces/:id',
      name: 'workspace-detail',
      component: () => import('@/views/WorkspaceEntryView.vue'),
      // 子路由（空间内对话、任务详情）合并父级 meta，同属 A 工作模式。
      meta: { title: '项目空间', section: '员工工作台', mode: 'work' },
      children: [
        {
          // TW-10 空间内对话视图：团队会话在空间外壳内打开，不再跳到
          // 独立 /conversations 页；:conversationId 兼容 Run ID 与 Session ID。
          path: 'conversations/:conversationId',
          name: 'workspace-conversation',
          component: () => import('@/views/ConversationView.vue'),
          meta: { title: '对话', section: '员工工作台' },
        },
        {
          // 项目任务详情：在“任务”页签内展示任务信息与操作，由任务面板自行渲染（本记录不挂组件）；
          // Agent 任务的任务线程作为子路由嵌在详情下方，:conversationId 同样兼容 Run ID 与 Session ID。
          path: 'tasks/:taskId',
          name: 'workspace-task',
          meta: { title: '任务', section: '员工工作台' },
          children: [
            {
              path: 'thread/:conversationId',
              name: 'workspace-task-thread',
              component: () => import('@/views/ConversationView.vue'),
              meta: { title: '任务', section: '员工工作台' },
            },
          ],
        },
      ],
    },
    // B 协作模式专属路由（项目空间方案 12.5）。对话页（单聊）自 S5c 起；群聊、AI 同事与群组页在 S5d 实现前为占位页。
    { path: '/c', redirect: { name: 'collab-chats' } },
    { path: '/c/chats', name: 'collab-chats', component: collabChats, meta: { title: '对话', section: '协作模式', mode: 'collab' } },
    { path: '/c/chats/agent/:agentId', name: 'collab-agent-chat', component: collabChats, meta: { title: '对话', section: '协作模式', mode: 'collab' } },
    { path: '/c/chats/group/:workspaceId', name: 'collab-group-chat', component: collabChats, meta: { title: '群组', section: '协作模式', mode: 'collab' } },
    { path: '/c/groups', name: 'collab-groups', component: collabPlaceholder, meta: { title: '群组', section: '协作模式', mode: 'collab' } },
    { path: '/c/groups/:workspaceId', name: 'collab-group', component: collabPlaceholder, meta: { title: '群组', section: '协作模式', mode: 'collab' } },
    { path: '/c/agents', name: 'collab-agents', component: collabPlaceholder, meta: { title: 'AI 同事', section: '协作模式', mode: 'collab' } },
    { path: '/c/agents/:agentId', name: 'collab-agent', component: collabPlaceholder, meta: { title: 'AI 同事', section: '协作模式', mode: 'collab' } },
    { path: '/files', name: 'my-files', component: () => import('@/views/MyFilesView.vue'), meta: { title: '我的文件', section: '员工工作台' } },
    { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue'), meta: { title: '历史对话', section: '员工工作台' } },
    { path: '/sessions/:id', name: 'session-detail', component: () => import('@/views/SessionResumeView.vue'), meta: { title: '对话', section: '员工工作台' } },
    {
      path: '/automations',
      name: 'automations',
      component: () => import('@/views/AutomationsView.vue'),
      meta: { title: '定时任务', section: '员工工作台' },
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
  // 链接与模式无关：按本人当前模式把另一模式的专属地址映射到对应页（12.5）。
  const uiMode = useUiModeStore(pinia)
  await uiMode.ensureLoaded(authStore.user.id)
  return locationForMode(to, uiMode.mode) ?? true
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '员工工作台')} · dsh-work`
})

export default router

function errorStatus(cause: unknown) {
  if (typeof cause !== 'object' || cause === null || !('status' in cause)) return 0
  return typeof cause.status === 'number' ? cause.status : 0
}
