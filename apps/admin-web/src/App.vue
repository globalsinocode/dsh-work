<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { AdminShell } from '@dsh-work/admin-components'
import { roleLabels, useAuthStore } from '@/stores/auth'
import { useAdminAssistantStore } from '@/stores/admin-assistant'
import { ADMIN_MODULE_LABELS, ADMIN_MODULES, READ_ONLY_MODULES, type AdminModule } from '@/utils/admin-modules'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const assistant = useAdminAssistantStore()
const conversationItems = computed(() => assistant.conversations
  .filter(conversation => conversation.saved)
  .map(conversation => ({ id: conversation.id, title: conversation.title })))
watch(() => authStore.canReadAdmin && authStore.user.id, (id) => { if (id) void assistant.load() }, { immediate: true })
const routeTitle = computed(() => String(route.meta.title ?? '管理后台'))
const routeSubtitle = computed(() => typeof route.meta.subtitle === 'string' ? route.meta.subtitle : undefined)
const publicRoute = computed(() => Boolean(route.meta.public))
const shellRoute = computed(() => route.matched.length > 0 && !publicRoute.value)
/** 只读模块的页面说明（管理端模块权限方案 AP15）：修改类操作已停用。 */
const readOnlyModule = computed(() => {
  const owner = route.meta.module as string | undefined
  if (!owner || !(ADMIN_MODULES as readonly string[]).includes(owner)) return null
  const module = owner as AdminModule
  if (READ_ONLY_MODULES.has(module) || authStore.moduleLevels[module] !== 'read') return null
  return ADMIN_MODULE_LABELS[module]
})

function navigate(path: string) {
  void router.push(path)
}

function selectConversation(id: string) {
  if (!authStore.canReadAdmin || !assistant.conversations.some(conversation => conversation.id === id)) return
  navigate(`/assistant?conversation=${encodeURIComponent(id)}`)
}

function openWorkbench() {
  const baseUrl = siblingApplicationUrl(import.meta.env.VITE_WORKBENCH_URL, '4174')
  window.location.assign(`${baseUrl}/workbench`)
}

function siblingApplicationUrl(configured: string | undefined, port: string) {
  if (configured) return configured.replace(/\/$/, '')
  const url = new URL(window.location.href)
  url.port = port
  return url.origin
}

function logout() {
  authStore.logout()
}
</script>

<template>
  <router-view v-if="publicRoute" />
  <AdminShell
    v-else-if="shellRoute"
    :current-path="route.path"
    :route-title="routeTitle"
    :route-subtitle="routeSubtitle"
    :user-name="authStore.user.name"
    :avatar-text="authStore.user.avatarText"
    :role-label="roleLabels[authStore.user.role]"
    :can-logout="authStore.identityProvider !== null && authStore.identityProvider !== 'prototype-sso'"
    :can-read-admin="authStore.canReadAdmin"
    :can-read-audit="authStore.canReadAudit"
    :identity-administration-available="authStore.identityAdministrationAvailable"
    :can-see="authStore.canSee"
    :conversation-items="conversationItems"
    :selected-conversation-id="assistant.selectedId"
    @navigate="navigate"
    @open-workbench="openWorkbench"
    @logout="logout"
    @select-conversation="selectConversation"
  >
    <el-alert
      v-if="readOnlyModule"
      class="module-read-only-alert"
      type="warning"
      :closable="false"
      show-icon
      :title="`你只有“查看${readOnlyModule}”权限，新建、编辑和删除等修改操作已停用。`"
    />
    <router-view />
  </AdminShell>
</template>

<style scoped>
.module-read-only-alert { margin-bottom: 10px; }
</style>
