<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import {
  ArrowRight,
  ChatDotRound,
  Collection,
  Connection,
  Cpu,
  DataAnalysis,
  FolderOpened,
  Grid,
  Key,
  Menu,
  Monitor,
  PieChart,
  SwitchButton,
  Tickets,
  Tools,
  UserFilled,
} from '@element-plus/icons-vue'

import { AppLogo } from '@dsh-work/ui-core'

const props = defineProps<{
  currentPath: string
  routeTitle: string
  userName: string
  avatarText: string
  roleLabel: string
  canLogout: boolean
  canReadAdmin: boolean
  canReadAudit: boolean
  identityAdministrationAvailable: boolean
  conversationItems?: Array<{ id: string; title: string }>
  selectedConversationId?: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
  openWorkbench: []
  logout: []
  selectConversation: [id: string]
}>()
const mobileOpen = ref(false)
const collapsedGroups = ref<Record<string, boolean>>({})

interface NavigationItem {
  label: string
  path: string
  icon: Component
  permission: 'admin' | 'audit'
  requiresIdentityAdministration?: boolean
}

const navigationGroups: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: '概览',
    items: [
      { label: '管理助手', path: '/assistant', icon: ChatDotRound, permission: 'admin' },
      { label: '运营概览', path: '/overview', icon: DataAnalysis, permission: 'admin' },
    ],
  },
  {
    label: 'Agent 治理',
    items: [
      { label: 'Agent 管理', path: '/agents', icon: Grid, permission: 'admin' },
      { label: 'Skill 管理', path: '/skills', icon: Collection, permission: 'admin' },
      { label: '工具管理', path: '/tools', icon: Tools, permission: 'admin' },
      { label: '连接器管理', path: '/connectors', icon: Connection, permission: 'admin' },
    ],
  },
  {
    label: '运行治理',
    items: [
      { label: 'Session 列表', path: '/sessions', icon: ChatDotRound, permission: 'admin' },
      { label: '模型治理', path: '/model-governance', icon: Key, permission: 'admin' },
      { label: '模型用量', path: '/model-usage', icon: PieChart, permission: 'admin' },
    ],
  },
  {
    label: '组织与权限',
    items: [
      {
        label: '员工与权限',
        path: '/identity',
        icon: UserFilled,
        permission: 'admin',
        requiresIdentityAdministration: true,
      },
      { label: '工作空间', path: '/workspaces', icon: FolderOpened, permission: 'admin' },
      { label: '工具权限', path: '/permissions', icon: Key, permission: 'admin' },
    ],
  },
  {
    label: '安全与运维',
    items: [
      { label: 'Runtimes', path: '/runtimes', icon: Cpu, permission: 'admin' },
      { label: '审计记录', path: '/audit', icon: Tickets, permission: 'audit' },
      { label: '系统健康', path: '/health', icon: Monitor, permission: 'admin' },
    ],
  },
]

const visibleNavigationGroups = computed(() => navigationGroups
  .map(group => ({
    ...group,
    items: group.items.filter(item => {
      const permitted = item.permission === 'audit' ? props.canReadAudit : props.canReadAdmin
      const available = !item.requiresIdentityAdministration
        || props.identityAdministrationAvailable
      return permitted && available
    }),
  }))
  .filter(group => group.items.length > 0))

function toggleGroup(label: string) {
  collapsedGroups.value = {
    ...collapsedGroups.value,
    [label]: !collapsedGroups.value[label],
  }
}

function navigate(path: string) {
  mobileOpen.value = false
  emit('navigate', path)
}

function openConversation(id: string) {
  mobileOpen.value = false
  emit('selectConversation', id)
}

function onRoleCommand(command: string | number | object) {
  const value = String(command)
  if (value === 'workbench') emit('openWorkbench')
  if (value === 'logout') emit('logout')
}

watch(
  () => props.currentPath,
  () => {
    mobileOpen.value = false
  },
)
</script>

<template>
  <div class="admin-shell">
    <button v-if="mobileOpen" class="sidebar-scrim" type="button" aria-label="关闭导航" @click="mobileOpen = false"></button>
    <aside class="admin-sidebar" :class="{ 'admin-sidebar--mobile-open': mobileOpen }">
      <div class="admin-sidebar__logo">
        <AppLogo dark />
        <span class="brand-context">管理平台</span>
      </div>
      <nav class="admin-sidebar__nav" aria-label="管理后台主导航">
        <section v-for="group in visibleNavigationGroups" :key="group.label" class="admin-nav-group">
          <button
            class="admin-nav-group__label"
            type="button"
            :aria-expanded="!collapsedGroups[group.label]"
            @click="toggleGroup(group.label)"
          >
            <span>{{ group.label }}</span>
            <el-icon :class="{ 'is-open': !collapsedGroups[group.label] }"><ArrowRight /></el-icon>
          </button>
          <div v-show="!collapsedGroups[group.label]" class="admin-nav-group__items">
            <button
              v-for="item in group.items"
              :key="item.path"
              class="admin-nav-item"
              :class="{ 'admin-nav-item--active': currentPath.startsWith(item.path) }"
              type="button"
              @click="navigate(item.path)"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.label }}</span>
            </button>
          </div>
        </section>
        <section v-if="canReadAdmin && conversationItems" class="admin-nav-group" aria-label="对话记录">
          <button class="admin-nav-group__label" type="button" :aria-expanded="!collapsedGroups['对话记录']" aria-controls="admin-conversation-records" @click="toggleGroup('对话记录')">
            <span>对话记录</span>
            <el-icon :class="{ 'is-open': !collapsedGroups['对话记录'] }"><ArrowRight /></el-icon>
          </button>
          <div id="admin-conversation-records" v-show="!collapsedGroups['对话记录']" class="admin-nav-group__items">
            <div class="admin-conversation-list">
              <button v-for="conversation in conversationItems" :key="conversation.id" class="admin-nav-item admin-conversation-item" :class="{ 'admin-nav-item--active': currentPath === '/assistant' && conversation.id === selectedConversationId }" :aria-current="currentPath === '/assistant' && conversation.id === selectedConversationId ? 'page' : undefined" :title="conversation.title" type="button" @click="openConversation(conversation.id)">
                <el-icon><ChatDotRound /></el-icon><span>{{ conversation.title }}</span>
              </button>
              <p v-if="!conversationItems.length" class="admin-conversation-note">暂无对话记录</p>
            </div>
          </div>
        </section>
      </nav>
    </aside>

    <div class="admin-shell__body">
      <header class="admin-topbar">
        <div class="admin-topbar__context">
          <el-button class="mobile-menu" text :icon="Menu" aria-label="打开导航" @click="mobileOpen = true" />
          <strong>{{ routeTitle }}</strong>
        </div>
        <div class="admin-topbar__actions">
          <el-dropdown trigger="click" placement="bottom-end" @command="onRoleCommand">
            <button class="header-user-button" type="button">
              <span class="header-user-button__avatar">{{ avatarText }}</span>
              <span class="header-user-button__copy"><strong>{{ userName }}</strong><small>{{ roleLabel }}</small></span>
              <span class="header-user-button__chevron" aria-hidden="true">⌄</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="workbench"><el-icon><Grid /></el-icon>返回员工工作台</el-dropdown-item>
                <el-dropdown-item v-if="canLogout" divided command="logout"><el-icon><SwitchButton /></el-icon>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>
      <main class="admin-main"><slot /></main>
    </div>
  </div>
</template>

<style scoped>
.admin-shell { min-height: 100vh; background: var(--color-bg-page); }
.admin-sidebar { position: fixed; z-index: 30; inset: 0 auto 0 0; display: flex; width: var(--dsh-sidebar-width); flex-direction: column; overflow: hidden; border-right: 1px solid var(--color-border); background: var(--color-bg-base); }
.admin-sidebar__logo { display: flex; min-height: 68px; align-items: center; justify-content: space-between; gap: 10px; padding: 15px 18px; border-bottom: 1px solid var(--color-bg-subtle); }
.admin-sidebar__logo :deep(.logo__text strong) { font-size: var(--font-size-header); }
.admin-sidebar__logo :deep(.logo__text span) { font-size: var(--font-size-micro); }
.brand-context { flex: 0 0 auto; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); color: var(--color-text-muted); font-size: var(--font-size-badge); }
.admin-sidebar__nav { min-height: 0; flex: 1; padding: 12px 0; overflow: auto; }
.admin-nav-group { margin-bottom: 4px; }
.admin-conversation-item > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.admin-conversation-note { margin: calc(var(--spacing-card) / 2) var(--spacing-section); color: var(--color-text-muted); font-size: var(--font-size-badge); }
.admin-nav-group__label { display: flex; width: 100%; align-items: center; justify-content: space-between; padding: 8px 20px 4px; border: 0; color: var(--color-text-muted); background: transparent; cursor: pointer; font-size: var(--font-size-badge); font-weight: var(--font-weight-title); letter-spacing: .04em; text-transform: uppercase; }
.admin-nav-group__label:hover { color: var(--color-text-secondary); }
.admin-nav-group__label:focus-visible, .admin-nav-item:focus-visible, .header-user-button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
.admin-nav-group__label .el-icon { transition: transform 150ms ease; }
.admin-nav-group__label .el-icon.is-open { transform: rotate(90deg); }
.admin-nav-group__items { padding-top: 2px; }
.admin-nav-item { display: flex; width: calc(100% - 16px); min-height: 38px; align-items: center; gap: 10px; margin: 1px 8px; padding: 8px 12px; border: 0; border-radius: var(--radius-tag); color: var(--color-text-secondary); background: transparent; cursor: pointer; font-size: var(--font-size-body); text-align: left; transition: color 100ms ease, background 100ms ease; }
.admin-nav-item:hover { color: var(--color-text-primary); background: var(--color-bg-subtle); }
.admin-nav-item--active { color: var(--color-primary); background: var(--color-primary-light); font-weight: var(--font-weight-badge); }
.admin-nav-item .el-icon { width: 18px; flex: 0 0 auto; font-size: var(--font-size-header); }
.admin-shell__body { min-width: 0; min-height: 100vh; margin-left: var(--dsh-sidebar-width); }
.admin-topbar { position: sticky; z-index: 20; top: 0; display: flex; min-height: var(--dsh-topbar-height); align-items: center; justify-content: space-between; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-base); }
.admin-topbar__context, .admin-topbar__actions { display: flex; align-items: center; gap: 10px; }
.admin-topbar__context strong { color: var(--color-text-heading); font-size: var(--font-size-header); font-weight: var(--font-weight-heading); }
.header-user-button { display: flex; min-width: 0; align-items: center; gap: 8px; padding: 3px 7px; border: 0; border-radius: var(--radius-tag); color: var(--color-text-primary); background: transparent; cursor: pointer; text-align: left; }
.header-user-button:hover { background: var(--color-bg-subtle); }
.header-user-button__avatar { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: var(--color-text-primary); background: var(--color-bg-subtle); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.header-user-button__copy { display: flex; min-width: 0; flex-direction: column; }
.header-user-button__copy strong { max-width: 120px; overflow: hidden; font-size: var(--font-size-body); font-weight: var(--font-weight-badge); text-overflow: ellipsis; white-space: nowrap; }
.header-user-button__copy small { margin-top: 1px; color: var(--color-text-muted); font-size: var(--font-size-micro); }
.header-user-button__chevron { color: var(--color-text-muted); font-size: var(--font-size-caption); }
.admin-main { min-height: calc(100vh - var(--dsh-topbar-height)); padding: 10px 14px 18px; background: var(--color-bg-page); }
.mobile-menu { display: none; }
.sidebar-scrim { position: fixed; z-index: 25; inset: 0; display: none; border: 0; background: rgb(5 12 24 / 52%); }
:global(.role-menu__heading) { padding: 8px 16px 6px; color: var(--color-text-muted); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); }
@media (max-width: 820px) {
  .admin-sidebar { transform: translateX(-100%); box-shadow: 16px 0 40px rgb(5 12 24 / 14%); transition: transform 180ms ease; }
  .admin-sidebar--mobile-open { transform: translateX(0); }
  .sidebar-scrim { display: block; }
  .admin-shell__body { margin-left: 0; }
  .mobile-menu { display: inline-flex; }
  .admin-topbar { padding: 0 16px; }
}
</style>
