<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlarmClock,
  ChatDotRound,
  Clock,
  Collection,
  Document,
  Grid,
  Monitor,
  Setting,
  SwitchButton,
  UserFilled,
} from '@element-plus/icons-vue'

import { AppLogo } from '@dsh-work/ui-core'
import ModeSwitchMenu from '@/components/ModeSwitchMenu.vue'
import { useWorkbenchBootstrap } from '@/composables/useWorkbenchBootstrap'
import { roleLabels, useAuthStore } from '@/stores/auth'
import { useCollabConversationStore } from '@/stores/collab-conversations'

/** 协作模式壳层（项目空间方案 12.3）：窄图标栏（只显示图标）+ 主内容；窄屏改为底部标签栏。 */
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const conversations = useCollabConversationStore()

const navigation = [
  { label: '对话', path: '/c/chats', icon: ChatDotRound },
  { label: 'AI 同事', path: '/c/agents', icon: UserFilled },
  { label: '群组', path: '/c/groups', icon: Collection },
  { label: '定时任务', path: '/automations', icon: AlarmClock },
]

/** “对话”入口的 @ 提醒圆点（D38）。 */
function mentionDot(path: string) {
  return path === '/c/chats' && conversations.hasMention
}

function isActive(path: string) {
  return route.path === path || route.path.startsWith(`${path}/`)
}

function navigate(path: string) {
  void router.push(path)
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
  if (value === 'admin') openAdmin()
  else if (value === 'logout') authStore.logout()
  else if (value.startsWith('/')) navigate(value)
}

useWorkbenchBootstrap()
// D38：主导航“对话”在有 @ 本人的群组时显示提醒圆点；不在对话页时也加载一次对话列表。
onMounted(() => {
  if (!conversations.loaded) void conversations.load()
})
</script>

<template>
  <div class="collab-shell">
    <aside class="collab-rail">
      <div class="collab-rail__logo">
        <ModeSwitchMenu placement="right-start">
          <AppLogo compact />
        </ModeSwitchMenu>
      </div>

      <nav class="collab-rail__nav" aria-label="协作模式主导航">
        <el-tooltip v-for="item in navigation" :key="item.path" :content="item.label" placement="right" :show-after="300">
          <button
            class="collab-nav-item"
            :class="{ 'collab-nav-item--active': isActive(item.path) }"
            type="button"
            :aria-label="mentionDot(item.path) ? `${item.label}，有人@我` : item.label"
            :aria-current="isActive(item.path) ? 'page' : undefined"
            @click="navigate(item.path)"
          >
            <el-icon aria-hidden="true"><component :is="item.icon" /></el-icon>
            <span v-if="mentionDot(item.path)" class="collab-nav-item__dot" aria-hidden="true" data-testid="nav-mention-dot"></span>
            <!-- 宽屏只显示图标（名称在悬停提示与可访问名称中）；窄屏底部标签栏显示名称。 -->
            <span class="collab-nav-item__label" aria-hidden="true">{{ item.label }}</span>
          </button>
        </el-tooltip>
      </nav>

      <div class="collab-rail__account">
        <el-dropdown trigger="click" placement="right-end" @command="onAccountCommand">
          <button class="collab-avatar" type="button" aria-label="打开用户菜单">
            {{ authStore.user.avatarText }}
          </button>
          <template #dropdown>
            <el-dropdown-menu class="role-menu">
              <div class="role-menu__heading">{{ authStore.user.name }} · {{ roleLabels[authStore.user.role] }}</div>
              <el-dropdown-item command="/settings">
                <el-icon><Setting /></el-icon>
                用户中心
              </el-dropdown-item>
              <el-dropdown-item command="/skills">
                <el-icon><Grid /></el-icon>
                Skill 广场
              </el-dropdown-item>
              <el-dropdown-item command="/files">
                <el-icon><Document /></el-icon>
                我的文件
              </el-dropdown-item>
              <el-dropdown-item command="/history">
                <el-icon><Clock /></el-icon>
                历史对话
              </el-dropdown-item>
              <el-dropdown-item v-if="authStore.canAccessAdmin" divided command="admin">
                <el-icon><Monitor /></el-icon>
                打开管理后台
              </el-dropdown-item>
              <el-dropdown-item
                v-if="authStore.identityProvider !== null && authStore.identityProvider !== 'prototype-sso'"
                divided
                command="logout"
              >
                <el-icon><SwitchButton /></el-icon>
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <main class="collab-main"><router-view :key="authStore.user.id" /></main>
  </div>
</template>

<style scoped>
.collab-shell {
  --collab-rail-width: 56px;
  --collab-tabbar-height: 60px;
  /* 与工作模式侧栏（EmployeeShell）同一组中性色；协作模式各页面的选中、悬停与筛选也取这里。 */
  --collab-nav-bg: #f4f4f2;
  --collab-nav-border: #e7e7e5;
  --collab-nav-text: #464744;
  --collab-nav-hover: #e9e9e6;
  --collab-nav-active: #dededb;
  --collab-nav-active-text: #171817;
  --collab-row-hover: #f4f4f2;
  --collab-row-active: #ededeb;
  --collab-divider: #e7e7e5;
  --collab-canvas: #f7f7f5;
  --collab-chip-active-text: #1f5a49;
  --collab-chip-active-bg: #eaf4f0;
  --collab-chip-active-border: #cfe3db;
  min-height: 100vh;
  background: #fff;
}

.collab-rail {
  position: fixed;
  z-index: 30;
  inset: 0 auto 0 0;
  display: flex;
  width: var(--collab-rail-width);
  flex-direction: column;
  align-items: center;
  padding: 14px 0;
  color: var(--collab-nav-text);
  border-right: 1px solid var(--collab-nav-border);
  background: var(--collab-nav-bg);
}

.collab-rail__logo { display: flex; justify-content: center; min-height: 44px; }

.collab-rail__nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 18px;
  padding: 0 8px;
}

.collab-nav-item {
  position: relative;
  display: flex;
  width: 40px;
  height: 40px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0;
  border: 0;
  border-radius: var(--dsh-radius-md);
  color: var(--collab-nav-text);
  background: transparent;
  cursor: pointer;
}

.collab-nav-item:hover { color: var(--collab-nav-active-text); background: var(--collab-nav-hover); }
.collab-nav-item--active,
.collab-nav-item--active:hover { color: var(--collab-nav-active-text); background: var(--collab-nav-active); }
.collab-nav-item .el-icon { font-size: var(--dsh-font-size-section); }
.collab-nav-item__label { display: none; font-size: var(--dsh-font-size-badge); line-height: 1.2; }
.collab-nav-item__dot {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--collab-nav-bg);
  border-radius: 50%;
  background: var(--el-color-danger);
}

.collab-avatar {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--dsh-radius-md);
  color: #124d3f;
  background: #bcebdc;
  cursor: pointer;
  font-size: var(--dsh-font-size-body);
  font-weight: 700;
}

.collab-nav-item:focus-visible,
.collab-avatar:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.collab-main {
  min-width: 0;
  min-height: 100vh;
  margin-left: var(--collab-rail-width);
  background: #fff;
}

:global(.role-menu__heading) { padding: 8px 16px 6px; color: #8a94a5; font-size: var(--dsh-font-size-caption); font-weight: 650; }

@media (max-width: 820px) {
  .collab-rail {
    inset: 0 0 auto 0;
    width: auto;
    height: 52px;
    flex-direction: row;
    justify-content: space-between;
    padding: 0 16px;
    /* 不用 backdrop-filter：它会让下方 fixed 的底部标签栏以本栏为包含块，标签栏被顶到页面上方。 */
    border-bottom: 1px solid var(--dsh-color-border);
    background: #fff;
  }

  .collab-rail__logo { min-height: 0; }

  .collab-rail__nav {
    position: fixed;
    z-index: 30;
    inset: auto 0 0 0;
    height: var(--collab-tabbar-height);
    flex: none;
    flex-direction: row;
    justify-content: space-around;
    gap: 0;
    margin: 0;
    padding: 0 8px;
    border-top: 1px solid var(--collab-nav-border);
    background: var(--collab-nav-bg);
  }

  .collab-nav-item { flex: 1; width: auto; height: auto; padding: 8px 0 6px; border-radius: var(--dsh-radius-sm); }
  .collab-nav-item__dot { top: 5px; right: calc(50% - 15px); }
  .collab-nav-item__label { display: block; }
  .collab-nav-item--active,
  .collab-nav-item--active:hover { color: var(--collab-nav-active-text); background: var(--collab-nav-active); }

  .collab-main {
    /* 统一页头吸在固定顶栏之下。 */
    --dsh-page-topbar-offset: 52px;
    margin-left: 0;
    padding-top: 52px;
    padding-bottom: var(--collab-tabbar-height);
  }
}
</style>
