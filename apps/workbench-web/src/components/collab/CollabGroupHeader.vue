<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeft, InfoFilled, Plus } from '@element-plus/icons-vue'

import type { Workspace } from '@/types/domain'

/**
 * 群组头部（S5d，12.3）：成员头像叠放、“＋”添加成员（负责人与管理员）、群组名称，其下为
 * “对话 / 任务 / 文件 / 成果 / 档案”页签与“群信息”。数据来自项目空间详情的同一份状态。
 */
const props = defineProps<{
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

const avatars = computed(() => props.workspace.members.slice(0, 4))
const extraMembers = computed(() => Math.max(props.workspace.memberCount - avatars.value.length, 0))
</script>

<template>
  <header class="collab-group-header">
    <div class="collab-group-header__top">
      <button type="button" class="collab-group-header__back" aria-label="返回对话列表" @click="emit('back')">
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <span class="collab-group-header__avatars" aria-hidden="true">
        <span v-for="name in avatars" :key="name" class="collab-group-header__avatar">{{ name.slice(0, 1) }}</span>
        <span v-if="extraMembers" class="collab-group-header__avatar collab-group-header__avatar--more">+{{ extraMembers }}</span>
      </span>
      <button
        v-if="canManageMembers"
        type="button"
        class="collab-group-header__add"
        aria-label="添加成员"
        @click="emit('add-member')"
      >
        <el-icon><Plus /></el-icon>
      </button>
      <div class="collab-group-header__title">
        <h1>{{ workspace.name }}</h1>
        <p>{{ workspace.memberCount }} 位成员<template v-if="workspace.status === 'archived'"> · 已归档</template></p>
      </div>
      <button
        type="button"
        class="collab-group-header__info"
        :class="{ 'is-active': infoOpen }"
        :aria-pressed="infoOpen"
        aria-label="群信息"
        @click="emit('toggle-info')"
      >
        <el-icon><InfoFilled /></el-icon>
        <span>群信息</span>
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
  padding: 10px 20px 0;
  border-bottom: 1px solid var(--dsh-color-border);
  background: #fff;
}

.collab-group-header__top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
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

.collab-group-header__avatars {
  display: flex;
}

.collab-group-header__avatar {
  display: grid;
  width: 30px;
  height: 30px;
  margin-left: -8px;
  place-items: center;
  border: 2px solid #fff;
  border-radius: 50%;
  color: var(--dsh-color-brand-dark);
  background: var(--dsh-color-brand-soft);
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.collab-group-header__avatar:first-child { margin-left: 0; }
.collab-group-header__avatar--more { color: var(--dsh-color-muted); background: var(--dsh-color-canvas); }

.collab-group-header__add {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px dashed var(--dsh-color-border-strong);
  border-radius: 50%;
  color: var(--dsh-color-muted);
  background: transparent;
  cursor: pointer;
}

.collab-group-header__title {
  min-width: 0;
  flex: 1;
}

.collab-group-header__title h1 {
  margin: 0;
  overflow: hidden;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-group-header__title p {
  margin: 2px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.collab-group-header__info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md);
  color: var(--dsh-color-text);
  background: #fff;
  cursor: pointer;
}

.collab-group-header__info.is-active {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}

.collab-group-header__tabs {
  display: flex;
  gap: 22px;
  margin-top: 6px;
  overflow-x: auto;
}

.collab-group-header__tab {
  flex: 0 0 auto;
  padding: 8px 2px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--dsh-color-muted);
  background: transparent;
  cursor: pointer;
}

.collab-group-header__tab.is-active {
  border-bottom-color: var(--el-color-primary);
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
  .collab-group-header__info span { display: none; }
  .collab-group-header__tabs { gap: 16px; }
}
</style>
