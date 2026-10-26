<script setup lang="ts">
import { ArrowLeft, MoreFilled, Plus } from '@element-plus/icons-vue'

import type { Workspace } from '@/types/domain'

/**
 * 群组头部（S5d，12.3）：群组名称与成员数、其后“＋”添加成员（负责人与管理员）、右侧“⋯”群信息，其下为
 * “对话 / 任务 / 文件 / 成果 / 档案”页签。数据来自项目空间详情的同一份状态。
 */
defineProps<{
  workspace: Workspace
  tabs: Array<{ id: string; label: string; count: number | string }>
  activeTab: string
  canManageMembers: boolean
  infoOpen: boolean
}>()
const emit = defineEmits<{
  'select-tab': [tab: string]
  'add-member': []
  'toggle-info': []
  back: []
}>()

</script>

<template>
  <header class="collab-group-header">
    <div class="collab-group-header__top">
      <button type="button" class="collab-group-header__back" aria-label="返回对话列表" @click="emit('back')">
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <div class="collab-group-header__title">
        <h1>{{ workspace.name }}</h1>
        <span class="collab-group-header__meta">{{ workspace.memberCount }} 位成员<template v-if="workspace.status === 'archived'"> · 已归档</template></span>
        <button
          v-if="canManageMembers"
          type="button"
          class="collab-group-header__add"
          aria-label="添加成员"
          title="添加成员"
          @click="emit('add-member')"
        >
          <el-icon><Plus /></el-icon>
        </button>
      </div>
      <button
        type="button"
        class="collab-group-header__info"
        :class="{ 'is-active': infoOpen }"
        :aria-pressed="infoOpen"
        aria-label="群信息"
        title="群信息"
        @click="emit('toggle-info')"
      >
        <el-icon><MoreFilled /></el-icon>
      </button>
    </div>
    <nav class="collab-group-header__tabs" role="tablist" aria-label="群组内容">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="collab-group-header__tab"
        :class="{ 'is-active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="emit('select-tab', tab.id)"
      >
        {{ tab.label }}<span v-if="tab.id !== 'chat' && tab.count !== '' && tab.count !== 0" class="collab-group-header__count">{{ tab.count }}</span>
      </button>
    </nav>
  </header>
</template>

<style scoped>
.collab-group-header {
  flex: 0 0 auto;
  padding: 4px 16px 0;
  border-bottom: 1px solid var(--collab-divider, var(--dsh-color-border));
  background: #fff;
}

.collab-group-header__top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
}

.collab-group-header__back {
  display: none;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: var(--dsh-radius-sm);
  color: var(--dsh-color-text);
  background: transparent;
  cursor: pointer;
}

.collab-group-header__add {
  display: grid;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px dashed var(--dsh-color-border-strong);
  border-radius: 50%;
  color: var(--dsh-color-muted);
  background: transparent;
  cursor: pointer;
}

.collab-group-header__title {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
}

.collab-group-header__title h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-group-header__meta {
  flex: 0 0 auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-group-header__info {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--dsh-radius-md);
  color: var(--collab-nav-text, var(--dsh-color-text));
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-section);
}

.collab-group-header__info:hover { background: var(--collab-nav-hover, var(--dsh-color-canvas)); }
.collab-group-header__info.is-active { color: var(--collab-nav-active-text, var(--dsh-color-ink)); background: var(--collab-nav-active, var(--dsh-color-canvas)); }

.collab-group-header__tabs {
  display: flex;
  gap: 22px;
  margin-top: 0;
  overflow-x: auto;
}

.collab-group-header__tab {
  flex: 0 0 auto;
  padding: 6px 2px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--dsh-color-muted);
  background: transparent;
  cursor: pointer;
}

.collab-group-header__tab.is-active {
  border-bottom-color: var(--collab-nav-active-text, var(--dsh-color-ink));
  color: var(--dsh-color-ink);
  font-weight: 620;
}

.collab-group-header__count {
  margin-left: 4px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.collab-group-header button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

@media (max-width: 820px) {
  .collab-group-header { padding: 6px 12px 0; }
  .collab-group-header__back { display: grid; }
  .collab-group-header__tabs { gap: 16px; }
}
</style>
