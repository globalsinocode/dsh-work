<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { Bell } from '@element-plus/icons-vue'

import { useNotificationStore } from '@/stores/notifications'
import { describeWorkspaceActivity } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'

const store = useNotificationStore()
const contentStore = useContentStore()
const router = useRouter()

const hasUnread = computed(() => store.unreadTotal > 0)

function workspaceName(workspaceId: string) {
  return contentStore.workspaces.find(workspace => workspace.id === workspaceId)?.name ?? workspaceId
}

async function openInbox() {
  store.inboxOpen = true
  await store.loadPage()
}

async function markRead() {
  await store.markReadThroughHighestRendered()
}

function openItem(workspaceId: string) {
  void router.push(`/workspaces/${workspaceId}`)
  store.inboxOpen = false
}
</script>

<template>
  <div class="notification-inbox">
    <el-badge :hidden="!hasUnread" :value="store.unreadTotal" :max="99">
      <el-button circle aria-label="打开通知" @click="openInbox">
        <el-icon><Bell /></el-icon>
      </el-button>
    </el-badge>

    <el-drawer v-model="store.inboxOpen" title="工作空间通知" size="420px">
      <div class="notification-inbox__actions">
        <el-button size="small" :disabled="!store.items.length" @click="markRead">标记已读</el-button>
      </div>
      <el-empty v-if="!store.items.length && !store.loading" description="暂无通知" />
      <ul v-else class="notification-inbox__list">
        <li v-for="item in store.items" :key="`${item.sequence}-${item.id}`">
          <button class="notification-inbox__item" type="button" @click="openItem(item.workspaceId)">
            <strong>{{ workspaceName(item.workspaceId) }}</strong>
            <span>{{ describeWorkspaceActivity(item) }}</span>
            <small>{{ new Date(item.occurredAt).toLocaleString('zh-CN') }}</small>
          </button>
        </li>
      </ul>
    </el-drawer>
  </div>
</template>

<style scoped>
.notification-inbox__actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.notification-inbox__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.notification-inbox__item {
  width: 100%;
  text-align: left;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--el-bg-color);
  cursor: pointer;
  display: grid;
  gap: 4px;
}
</style>
