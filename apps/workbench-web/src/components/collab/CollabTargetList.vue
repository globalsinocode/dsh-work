<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus } from '@element-plus/icons-vue'

import { useCollabConversationStore } from '@/stores/collab-conversations'
import type { ConversationTarget } from '@/types/domain'
import { formatActivityTimeShort } from '@/utils/activity-time'
import CollabAgentPickerDialog from './CollabAgentPickerDialog.vue'

/** 协作模式对话页列表栏（D24）：单聊（按 AI 同事聚合）与群组按最近活动排序，支持搜索与分页。 */
const props = defineProps<{
  activeKey?: string
  pendingAgent?: { id: string; name: string; description: string } | null
}>()
const emit = defineEmits<{
  select: [target: { type: 'agent' | 'group'; id: string }]
  'start-agent': [agentId: string]
}>()

const store = useCollabConversationStore()
const keyword = ref(store.query)
const pickerOpen = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  if (!store.loaded) void store.load()
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

function onMenu(command: string | number | object) {
  if (command === 'agent') pickerOpen.value = true
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
            <el-dropdown-item command="group" disabled>
              <span class="collab-target-list__menu-copy">
                <strong>新建群组 <em>即将上线</em></strong>
                <small>至少选择一个 Agent，可邀请同事</small>
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
            <button type="button" class="collab-target collab-target--pending" aria-current="page" @click="emit('start-agent', pendingAgent.id)">
              <span class="collab-target__avatar" aria-hidden="true">{{ pendingAgent.name.slice(0, 1) }}</span>
              <span class="collab-target__main">
                <span class="collab-target__name">{{ pendingAgent.name }}</span>
                <span class="collab-target__preview">{{ pendingAgent.description || '开始新的对话' }}</span>
              </span>
            </button>
          </li>
          <li v-for="target in store.targets" :key="keyOf(target)">
            <button
              type="button"
              class="collab-target"
              :class="{ 'collab-target--active': keyOf(target) === activeKey }"
              :aria-current="keyOf(target) === activeKey ? 'page' : undefined"
              @click="emit('select', { type: target.type, id: target.id })"
            >
              <span v-if="target.type === 'group'" class="collab-target__avatar collab-target__avatar--group" aria-hidden="true">
                <span v-for="(name, index) in target.avatarNames.slice(0, 4)" :key="index">{{ name.slice(0, 1) }}</span>
              </span>
              <span v-else class="collab-target__avatar" aria-hidden="true">{{ target.name.slice(0, 1) }}</span>
              <span class="collab-target__main">
                <span class="collab-target__name">
                  <span class="collab-target__name-text">{{ target.name }}</span>
                  <span v-if="target.type === 'agent' && !target.available" class="collab-target__tag">不可用</span>
                </span>
                <span class="collab-target__preview">{{ preview(target) }}</span>
              </span>
              <time class="collab-target__time" :datetime="target.lastActiveAt">{{ formatActivityTimeShort(target.lastActiveAt) }}</time>
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
.collab-target:hover { background: var(--dsh-color-canvas); }
.collab-target:focus-visible { outline: 2px solid var(--dsh-color-brand); outline-offset: -2px; }
.collab-target--active, .collab-target--pending, .collab-target[aria-current='page'] { background: var(--dsh-color-brand-soft); }
.collab-target__avatar {
  display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 50%;
  color: #fff; background: var(--dsh-color-brand); font-size: var(--dsh-font-size-subheading); font-weight: 700;
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
.collab-target__time { flex: 0 0 auto; align-self: flex-start; padding-top: 2px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-micro); }
</style>
