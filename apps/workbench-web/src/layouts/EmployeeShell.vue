<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  AlarmClock,
  Clock,
  Collection,
  Delete as DeleteIcon,
  Download,
  Files,
  HomeFilled,
  Menu,
  Monitor,
  MoreFilled,
  Plus,
  Setting,
  Share,
  SwitchButton,
} from '@element-plus/icons-vue'

import { AppLogo } from '@dsh-work/ui-core'
import { roleLabels, useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { TaskRun } from '@/types/domain'
import { isTaskInArchivedWorkspace } from '@/utils/archived-workspaces'
import { conversationRemovalNotice } from '@/utils/content-lifecycle'
import { notifyActionFailure } from '@/utils/feedback'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const taskStore = useTaskStore()
const contentStore = useContentStore()

const mobileOpen = ref(false)
const deletingSessionId = ref<string>()

const navigation = [
  { label: '新对话', path: '/workbench', icon: HomeFilled },
  { label: '历史对话', path: '/history', icon: Clock },
  { label: '我的文件', path: '/files', icon: Files },
  { label: '团队空间', path: '/workspaces', icon: Collection },
  // AG-03 既有功能入口保留：不属于个人空间概念，不因 D12 收敛被摘掉。
  { label: '自动任务', path: '/automations', icon: AlarmClock },
]

function isActive(path: string) {
  if (path === '/workbench') return route.path === path
  return route.path.startsWith(path)
}

function navigate(path: string) {
  mobileOpen.value = false
  if (path === '/workbench') void router.push({ path, query: { new: String(Date.now()) } })
  else void router.push(path)
}

function openAdmin() {
  const baseUrl = siblingApplicationUrl(import.meta.env.VITE_ADMIN_URL, '4180')
  window.location.assign(`${baseUrl}/overview`)
}

function siblingApplicationUrl(configured: string | undefined, port: string) {
  if (configured) return configured.replace(/\/$/, '')
  const url = new URL(window.location.href)
  url.port = port
  return url.origin
}

function onAccountCommand(command: string | number | object) {
  const value = String(command)
  if (value === 'user-center') navigate('/settings')
  if (value === 'admin') openAdmin()
  if (value === 'logout') authStore.logout()
}

function copyConversationLink(task: TaskRun) {
  const path = router.resolve(`/conversations/${task.id}`).href
  void navigator.clipboard.writeText(new URL(path, window.location.origin).toString())
  ElMessage.success('对话链接已复制')
}

function exportConversation(task: TaskRun) {
  const content = task.messages
    .map((message) => `${message.role === 'user' ? '我' : 'dsh-work'}：${message.content}`)
    .join('\n\n')
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${task.title}-对话记录.txt`
  anchor.click()
  URL.revokeObjectURL(url)
  ElMessage.success('对话记录已导出')
}

async function deleteConversation(task: TaskRun) {
  if (deletingSessionId.value) return
  if (isTaskInArchivedWorkspace(task, contentStore.workspaces)) {
    ElMessage.warning('该对话所在工作空间已归档，仅保留只读查看与下载')
    return
  }
  if (['queued', 'running', 'awaiting_approval'].includes(task.status)) {
    ElMessage.warning('请先停止当前运行，再移除对话')
    return
  }

  try {
    await ElMessageBox.confirm(
      conversationRemovalNotice,
      `移除对话“${task.title}”？`,
      {
        confirmButtonText: '移除对话',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }

  const currentTask = taskStore.getTask(String(route.params.id))
  const deletingCurrentConversation = currentTask?.sessionId === task.sessionId
  deletingSessionId.value = task.sessionId
  try {
    await taskStore.deleteConversation(task.sessionId)
    ElMessage.success(`已移除对话“${task.title}”`)
    if (deletingCurrentConversation) await router.replace('/workbench')
  } catch (error) {
    notifyActionFailure('移除对话', `对话“${task.title}”`, error, '刷新对话状态；若仍在执行，请先停止后再移除。')
  } finally {
    deletingSessionId.value = undefined
  }
}

function onRecentConversationCommand(command: string | number | object, task: TaskRun) {
  const value = String(command)
  if (value === 'copy-link') copyConversationLink(task)
  if (value === 'export') exportConversation(task)
  if (value === 'delete') void deleteConversation(task)
}

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  },
)

watch(() => authStore.user.id, (id, previous) => {
  if (previous && id !== previous) { taskStore.reset(); contentStore.reset() }
  if (id === '—') return
  void Promise.all([taskStore.load(), contentStore.load()]).catch(cause => notifyActionFailure('加载工作台', '工作内容', cause))
}, { immediate: true })
onMounted(() => { void authStore.load().catch(cause => notifyActionFailure('加载身份', '当前账号', cause)) })
</script>

<template>
  <div class="employee-shell">
    <button
      v-if="mobileOpen"
      class="sidebar-scrim"
      type="button"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    ></button>

    <aside class="employee-sidebar" :class="{ 'employee-sidebar--mobile-open': mobileOpen }">
      <div class="employee-sidebar__logo">
        <AppLogo dark />
      </div>

      <button class="new-conversation-button" type="button" @click="navigate('/workbench')">
        <el-icon><Plus /></el-icon>
        发起新对话
      </button>

      <nav class="employee-sidebar__nav" aria-label="员工工作台主导航">
        <p class="employee-sidebar__section-label">工作入口</p>
        <button
          v-for="item in navigation"
          :key="item.path"
          class="nav-item"
          :class="{ 'nav-item--active': isActive(item.path) }"
          type="button"
          @click="navigate(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section class="employee-sidebar__recent">
        <div class="employee-sidebar__recent-title">最近对话</div>
        <div
          v-for="task in taskStore.recentTasks"
          :key="task.sessionId"
          class="recent-conversation"
        >
          <button
            class="recent-conversation__link"
            type="button"
            @click="navigate(`/conversations/${task.id}`)"
          >
            <span class="recent-conversation__dot" :class="`recent-conversation__dot--${task.status}`"></span>
            <span class="recent-conversation__title">{{ task.title }}</span>
            <span class="recent-conversation__time">{{ task.updatedAt }}</span>
          </button>
          <el-dropdown
            class="recent-conversation__menu"
            trigger="click"
            placement="bottom-end"
            :disabled="deletingSessionId === task.sessionId"
            @command="onRecentConversationCommand($event, task)"
          >
            <button
              class="recent-conversation__more"
              type="button"
              :aria-label="`打开对话“${task.title}”的更多操作`"
              :disabled="deletingSessionId === task.sessionId"
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="copy-link">
                  <el-icon><Share /></el-icon>
                  复制对话链接
                </el-dropdown-item>
                <el-dropdown-item command="export">
                  <el-icon><Download /></el-icon>
                  导出对话记录
                </el-dropdown-item>
                <el-dropdown-item
                  v-if="!isTaskInArchivedWorkspace(task, contentStore.workspaces)"
                  class="recent-conversation-delete-item"
                  divided
                  command="delete"
                >
                  <el-icon><DeleteIcon /></el-icon>
                  移除对话
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </section>

      <div class="employee-sidebar__footer">
        <el-dropdown trigger="click" placement="top-start" @command="onAccountCommand">
          <button class="profile-button" type="button" aria-label="打开用户中心">
            <span class="profile-button__avatar">{{ authStore.user.avatarText }}</span>
            <span class="profile-button__copy">
              <strong>{{ authStore.user.name }}</strong>
              <small>{{ roleLabels[authStore.user.role] }}</small>
            </span>
            <el-icon><MoreFilled /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu class="role-menu">
              <div class="role-menu__heading">用户中心</div>
              <el-dropdown-item command="user-center">
                <el-icon><Setting /></el-icon>
                个人资料与设置
              </el-dropdown-item>
              <el-dropdown-item v-if="authStore.canAccessAdmin" divided command="admin">
                <el-icon><Monitor /></el-icon>
                打开管理后台
              </el-dropdown-item>
              <el-dropdown-item v-if="authStore.identityProvider === 'ai-hub-oidc'" divided command="logout">
                <el-icon><SwitchButton /></el-icon>
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <div class="employee-shell__body">
      <el-button
        class="employee-mobile-menu"
        circle
        plain
        :icon="Menu"
        aria-label="打开导航"
        @click="mobileOpen = true"
      />
      <main class="employee-main"><router-view :key="authStore.user.id" /></main>
    </div>
  </div>
</template>

<style scoped>
.employee-shell {
  --dsh-sidebar-width: 236px;
  min-height: 100vh;
  background: #fff;
}

.employee-sidebar {
  position: fixed;
  z-index: 30;
  inset: 0 auto 0 0;
  display: flex;
  width: var(--dsh-sidebar-width);
  flex-direction: column;
  overflow: hidden;
  color: #303236;
  border-right: 1px solid #e7e7e5;
  background: #f4f4f2;
}

.employee-sidebar__logo {
  display: flex;
  align-items: center;
  min-height: 64px;
  padding: 14px 15px 12px 18px;
}

.new-conversation-button {
  display: flex;
  align-items: center;
  min-height: 40px;
  gap: 9px;
  margin: 3px 10px 14px;
  padding: 0 13px;
  border: 1px solid #dfdfdc;
  border-radius: 8px;
  color: #242528;
  background: #e7e7e4;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 70%);
  cursor: pointer;
  font-weight: 600;
}

.new-conversation-button:hover { background: #ddddda; }

.employee-sidebar__nav { padding: 0 8px; }

.employee-sidebar__section-label,
.employee-sidebar__recent-title {
  margin: 10px 10px 6px;
  color: #82827d;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 38px;
  gap: 10px;
  margin: 1px 0;
  padding: 0 11px;
  border: 0;
  border-radius: 8px;
  color: #464744;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.nav-item:hover { color: #20211f; background: #e9e9e6; }
.nav-item--active { color: #171817; background: #dededb; font-weight: 620; }
.nav-item .el-icon { width: 18px; font-size: var(--dsh-font-size-section); }

.employee-sidebar__recent {
  min-height: 0;
  flex: 1;
  margin-top: 15px;
  padding: 11px 8px;
  overflow: auto;
  border-top: 1px solid #e5e5e2;
}

.recent-conversation {
  position: relative;
  width: 100%;
  min-height: 34px;
  border-radius: 7px;
  color: #4d4e4b;
  background: transparent;
}

.recent-conversation:hover { color: #181918; background: #e9e9e6; }
.recent-conversation__link {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  gap: 7px;
  padding: 0 10px;
  border: 0;
  border-radius: inherit;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.recent-conversation__link:focus-visible,
.recent-conversation__more:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}

.recent-conversation__dot { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: #858580; }
.recent-conversation__dot--running { background: #527ce2; }
.recent-conversation__dot--succeeded { background: #31a47d; }
.recent-conversation__dot--failed { background: #d05c67; }
.recent-conversation__dot--awaiting_approval { background: #d18a37; }
.recent-conversation__title { min-width: 0; flex: 1; overflow: hidden; font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.recent-conversation__time { flex: 0 0 auto; color: #9a9a95; font-size: var(--dsh-font-size-micro); transition: opacity 120ms ease; }
.recent-conversation__menu {
  position: absolute;
  top: 50%;
  right: 5px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition: opacity 120ms ease;
}

.recent-conversation__more {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: #686965;
  background: transparent;
  cursor: pointer;
}

.recent-conversation__more:hover { color: #20211f; background: #ddddda; }
.recent-conversation:hover .recent-conversation__time,
.recent-conversation:focus-within .recent-conversation__time { opacity: 0; }
.recent-conversation:hover .recent-conversation__menu,
.recent-conversation:focus-within .recent-conversation__menu { opacity: 1; pointer-events: auto; }

.employee-sidebar__footer { padding: 9px 9px 11px; border-top: 1px solid #e3e3e0; }
.profile-button { display: flex; align-items: center; width: 100%; min-height: 48px; gap: 10px; padding: 6px 8px; border: 0; border-radius: 9px; color: #272825; background: transparent; cursor: pointer; text-align: left; }
.profile-button:hover { background: #e7e7e4; }
.profile-button__avatar { display: grid; width: 31px; height: 31px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: #124d3f; background: #bcebdc; font-size: var(--dsh-font-size-body); font-weight: 700; }
.profile-button__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.profile-button__copy strong { font-size: var(--dsh-font-size-caption); font-weight: 620; }
.profile-button__copy small { margin-top: 2px; color: #858580; font-size: var(--dsh-font-size-badge); }
.employee-shell__body { min-width: 0; min-height: 100vh; margin-left: var(--dsh-sidebar-width); }
.employee-main { min-height: 100vh; background: #fff; }
.employee-mobile-menu { display: none; }
.sidebar-scrim { position: fixed; z-index: 25; inset: 0; display: none; border: 0; background: rgb(5 12 24 / 52%); }

:global(.role-menu__heading) { padding: 8px 16px 6px; color: #8a94a5; font-size: var(--dsh-font-size-caption); font-weight: 650; }
:global(.recent-conversation-delete-item) { color: var(--el-color-danger); }

@media (hover: none) {
  .recent-conversation__time { opacity: 0; }
  .recent-conversation__menu { opacity: 1; pointer-events: auto; }
}

@media (max-width: 820px) {
  .employee-sidebar { transform: translateX(-100%); box-shadow: 16px 0 40px rgb(5 12 24 / 22%); transition: transform 180ms ease; }
  .employee-sidebar--mobile-open { transform: translateX(0); }
  .sidebar-scrim { display: block; }
  .employee-shell__body { margin-left: 0; }
  .employee-mobile-menu { position: fixed; z-index: 18; top: 12px; left: 12px; display: inline-flex; border-color: #dfdfdc; background: rgb(255 255 255 / 90%); box-shadow: 0 4px 16px rgb(24 25 24 / 8%); backdrop-filter: blur(8px); }
}
</style>
