<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { useCollabConversationStore } from '@/stores/collab-conversations'
import type { ConversationTarget, Workspace } from '@/types/domain'
import { formatActivityTimeShort } from '@/utils/activity-time'
import CreateProjectSpaceDialog from '../CreateProjectSpaceDialog.vue'
import CollabAgentPickerDialog from './CollabAgentPickerDialog.vue'

/**
 * 协作模式对话页列表栏（D24）：单聊（按 AI 同事聚合）与群组按最近活动排序，支持搜索与分页；
 * 每行显示未读数（S5e，静音群组弱化显示）。“＋”发起单聊或新建群组（与群组页同一创建弹窗）。
 */
const props = defineProps<{
  activeKey?: string
  pendingAgent?: { id: string; name: string; description: string } | null
}>()
const emit = defineEmits<{
  select: [target: { type: 'agent' | 'group'; id: string }]
  'start-agent': [agentId: string]
}>()

const store = useCollabConversationStore()
const router = useRouter()
const keyword = ref(store.query)
const pickerOpen = ref(false)
const createOpen = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

// 回到对话页时重新取第一页：离开期间他人的发言要体现在预览与未读中。
onMounted(() => {
  void (store.loaded ? store.refresh() : store.load())
})
onBeforeUnmount(() => clearTimeout(timer))

watch(keyword, value => {
  clearTimeout(timer)
  timer = setTimeout(() => void store.load(value), 250)
})

const showPending = computed(() => {
  const pending = props.pendingAgent
  return !!pending && !store.targets.some(item => item.type === 'agent' && item.id === pending.id)
})
const rowCount = computed(() => store.targets.length + (showPending.value ? 1 : 0))
const firstLoading = computed(() => store.loading && !store.loaded)

function keyOf(target: ConversationTarget) {
  return `${target.type}:${target.id}`
}

function preview(target: ConversationTarget) {
  const last = target.lastMessage
  if (!last) return target.description || '还没有消息'
  if (target.type === 'group') return `${last.authorName}：${last.text}`
  return last.role === 'user' ? `我：${last.text}` : last.text
}

function unreadLabel(count: number) {
  return count > 99 ? '99+' : String(count)
}

/** 可访问名称只用对象名（+ 不可用 / 未读），不含预览，避免按名称点行时误匹配到群组预览。 */
function rowAriaLabel(target: ConversationTarget) {
  const parts = [target.name]
  if (target.type === 'agent' && !target.available) parts.push('不可用')
  if (target.unreadCount > 0) {
    const unread = target.unreadCount > 99 ? '99 条以上未读' : `${target.unreadCount} 条未读`
    parts.push(target.muted ? `${unread}（已静音）` : unread)
  }
  return parts.join('，')
}

function onMenu(command: string | number | object) {
  if (command === 'agent') pickerOpen.value = true
  if (command === 'group') createOpen.value = true
}

function onGroupCreated(workspace: Workspace) {
  void store.refresh()
  void router.push({ name: 'collab-group-chat', params: { id: workspace.id }, query: { info: '1' } })
}

function onPick(agentId: string) {
  emit('start-agent', agentId)
}
</script>

<template>
  <section class="collab-target-list" aria-label="对话列表">
    <header class="collab-target-list__head">
      <el-input v-model="keyword" class="collab-target-list__search" type="search" aria-label="搜索对话" placeholder="搜索" clearable />
      <el-dropdown trigger="click" @command="onMenu">
        <el-button class="collab-target-list__add" type="primary" circle aria-label="发起对话或新建群组">
          <el-icon aria-hidden="true"><Plus /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="agent">
              <span class="collab-target-list__menu-copy">
                <strong>发起对话</strong>
                <small>选择一位 AI 同事单聊</small>
              </span>
            </el-dropdown-item>
            <el-dropdown-item command="group">
              <span class="collab-target-list__menu-copy">
                <strong>新建群组</strong>
                <small>至少选择一个 AI 同事，创建后可邀请同事</small>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>

    <p class="collab-target-list__caption">对话 · {{ rowCount }}</p>

    <div class="collab-target-list__body">
      <el-alert v-if="store.error" class="collab-target-list__alert" type="error" :closable="false" show-icon :title="store.error">
        <el-button link type="primary" @click="store.refresh()">重试</el-button>
      </el-alert>
      <el-skeleton v-if="firstLoading" class="collab-target-list__skeleton" :rows="4" animated />
      <template v-else>
        <ul v-if="rowCount" class="collab-target-list__rows" aria-label="对话">
          <li v-if="showPending && pendingAgent">
            <button
              type="button"
              class="collab-target collab-target--pending"
              :aria-label="pendingAgent.name"
              aria-current="page"
              @click="emit('start-agent', pendingAgent.id)"
            >
              <span class="collab-target__avatar" aria-hidden="true">{{ pendingAgent.name.slice(0, 1) }}</span>
              <span class="collab-target__main">
                <span class="collab-target__name" aria-hidden="true">{{ pendingAgent.name }}</span>
                <span class="collab-target__preview" aria-hidden="true">{{ pendingAgent.description || '开始新的对话' }}</span>
              </span>
            </button>
          </li>
          <li v-for="target in store.targets" :key="keyOf(target)">
            <button
              type="button"
              class="collab-target"
              :class="{ 'collab-target--active': keyOf(target) === activeKey }"
              :aria-label="rowAriaLabel(target)"
              :aria-current="keyOf(target) === activeKey ? 'page' : undefined"
              @click="emit('select', { type: target.type, id: target.id })"
            >
              <span v-if="target.type === 'group'" class="collab-target__avatar collab-target__avatar--group" aria-hidden="true">
                <span v-for="(name, index) in target.avatarNames.slice(0, 4)" :key="index">{{ name.slice(0, 1) }}</span>
              </span>
              <span v-else class="collab-target__avatar" aria-hidden="true">{{ target.name.slice(0, 1) }}</span>
              <span class="collab-target__main" aria-hidden="true">
                <span class="collab-target__name">
                  <span class="collab-target__name-text">{{ target.name }}</span>
                  <span v-if="target.type === 'agent' && !target.available" class="collab-target__tag">不可用</span>
                </span>
                <span class="collab-target__preview">{{ preview(target) }}</span>
              </span>
              <span class="collab-target__side" aria-hidden="true">
                <time class="collab-target__time" :datetime="target.lastActiveAt">{{ formatActivityTimeShort(target.lastActiveAt) }}</time>
                <span
                  v-if="target.unreadCount > 0"
                  class="collab-target__unread"
                  :class="{ 'collab-target__unread--muted': target.muted }"
                  data-testid="conversation-unread"
                >
                  <span aria-hidden="true">{{ unreadLabel(target.unreadCount) }}</span>
                  <span class="collab-target-list__sr">{{ target.unreadCount > 99 ? '99 条以上未读' : `${target.unreadCount} 条未读` }}{{ target.muted ? '（已静音）' : '' }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <p v-else-if="!store.error" class="collab-target-list__empty">
          {{ store.query.trim() ? '没有匹配的对话' : '还没有对话，点“＋”发起与 AI 同事的对话' }}
        </p>
        <div v-if="store.nextCursor" class="collab-target-list__more">
          <el-button link type="primary" :loading="store.loadingMore" @click="store.loadMore()">加载更多</el-button>
        </div>
      </template>
    </div>

    <CollabAgentPickerDialog v-model="pickerOpen" @pick="onPick" />
    <CreateProjectSpaceDialog v-model="createOpen" mode="collab" @created="onGroupCreated" />
  </section>
</template>

<style scoped>
.collab-target-list { display: flex; height: 100%; min-width: 0; flex-direction: column; background: var(--dsh-color-panel); }
.collab-target-list__head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 4px; }
.collab-target-list__search { min-width: 0; flex: 1; }
.collab-target-list__add { flex: 0 0 auto; }
.collab-target-list__caption { margin: 0; padding: 8px 16px 4px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-micro); }
.collab-target-list__body { min-height: 0; flex: 1; overflow: auto; padding: 0 6px 8px; }
.collab-target-list__alert, .collab-target-list__skeleton { margin: 8px 6px; width: auto; }
.collab-target-list__rows { margin: 0; padding: 0; list-style: none; }
.collab-target-list__empty { margin: 32px 16px; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); line-height: 1.6; text-align: center; }
.collab-target-list__more { display: flex; justify-content: center; padding: 8px 0; }
.collab-target-list__menu-copy { display: flex; flex-direction: column; gap: 2px; }
.collab-target-list__menu-copy strong { color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); }
.collab-target-list__menu-copy em { margin-left: 4px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-micro); font-style: normal; font-weight: 400; }
.collab-target-list__menu-copy small { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }

.collab-target {
  display: flex; width: 100%; min-height: 64px; align-items: center; gap: 12px; padding: 10px;
  border: 0; border-radius: 10px; color: inherit; background: transparent; cursor: pointer; text-align: left;
}
.collab-target:hover { background: var(--collab-row-hover); }
.collab-target:focus-visible { outline: 2px solid var(--dsh-color-brand); outline-offset: -2px; }
.collab-target--active, .collab-target--pending, .collab-target[aria-current='page'] { background: var(--collab-row-active); }
.collab-target__avatar {
  display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 50%;
  color: var(--dsh-color-brand-dark); background: var(--dsh-color-brand-soft); font-size: var(--dsh-font-size-subheading); font-weight: 700;
}
.collab-target__avatar--group {
  grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 2px; padding: 4px;
  color: var(--dsh-color-brand-dark); background: var(--dsh-color-border); font-size: var(--dsh-font-size-micro);
}
.collab-target__avatar--group > span { display: grid; place-items: center; border-radius: 4px; background: var(--dsh-color-panel); }
.collab-target__main { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
.collab-target__name { display: flex; min-width: 0; align-items: center; gap: 6px; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); font-weight: 600; }
.collab-target__name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.collab-target__tag { flex: 0 0 auto; padding: 0 6px; border-radius: 4px; color: var(--dsh-color-warning); background: var(--dsh-color-warning-soft); font-size: var(--dsh-font-size-micro); font-weight: 500; }
.collab-target__preview { overflow: hidden; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.collab-target__side { display: flex; flex: 0 0 auto; align-self: stretch; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 2px; }
.collab-target__time { color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-micro); }
.collab-target__unread {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; color: #fff; background: var(--dsh-color-danger);
  font-size: var(--dsh-font-size-micro); font-weight: 600; line-height: 18px; text-align: center;
}
.collab-target__unread--muted { color: var(--dsh-color-muted); background: var(--dsh-color-border); }
.collab-target-list__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
