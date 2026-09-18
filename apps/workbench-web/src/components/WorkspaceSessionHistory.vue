<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import { useTaskStore } from '@/stores/tasks'
import type { WorkspaceSessionSummary } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { formatActivityTime, formatActivityTimeShort } from '@/utils/activity-time'

/**
 * 团队空间「历史对话」视图（design §2.2，TW-03 第一批）。
 *
 * - 只由 `WorkspaceDetailView` 的团队分支挂载；个人空间不渲染本组件，因此也不会
 *   产生 `listWorkspaceSessions` 请求（AC-23）。
 * - TW-10 起列表返回空间内全部会话（共享讨论）；每行显示发起人，零 Run 的
 *   讨论会话显示「暂无运行」，打开时退回 Session 身份；目标统一为空间内
 *   对话视图（/workspaces/:id/conversations/:target）。
 * - 排序固定为服务端「最近活动倒序」，前端不再排序，首版不提供排序切换。
 */
const props = withDefaults(
  defineProps<{
    workspaceId: string
    workspaceName?: string
    /** 当前操作人是否有可发起的 Agent 成员，用于「本人尚无对话」时的引导文案。 */
    canStartConversation?: boolean
    /**
     * 归档只读态（design §2.7）：归档空间不引导「返回新对话」，空态改为只读说明，
     * 不展示「请联系负责人添加可用 Agent 成员」（归档不是缺 Agent 能力）。
     */
    archived?: boolean
  }>(),
  { workspaceName: '', canStartConversation: false, archived: false },
)

const emit = defineEmits<{ 'start-new': [] }>()

/** 服务端 limit 允许 1..100；首屏一页 20 条与会话列表默认值一致。 */
const PAGE_SIZE = 20
/** 搜索防抖：服务端按标题过滤，输入过程中不逐字请求。 */
const SEARCH_DEBOUNCE_MS = 300

/** 侧栏 5px 状态点语义（EmployeeShell）与可访问文案（design §4）。 */
const runStatusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  awaiting_approval: '等待确认',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已停止',
}

const router = useRouter()
const taskStore = useTaskStore()

const items = ref<WorkspaceSessionSummary[]>([])
const nextCursor = ref<string | null>(null)
const keyword = ref('')
const appliedQuery = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const initialized = ref(false)
const failed = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined

const searchedTitle = computed(() => appliedQuery.value)
/**
 * 空态（TW-10 共享列表口径）：只有「空间尚无对话」与「筛选无结果」；
 * 归档空间维持只读说明。
 */
const emptyState = computed<'none' | 'own' | 'filter' | 'archived'>(() => {
  if (items.value.length || loading.value || !initialized.value || failed.value) return 'none'
  if (appliedQuery.value) return 'filter'
  return props.archived ? 'archived' : 'own'
})

async function fetchPage(cursor?: string) {
  return workbenchApi.listWorkspaceSessions(props.workspaceId, {
    ...(appliedQuery.value ? { query: appliedQuery.value } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  })
}

/** 递增请求令牌：后发请求覆盖先发结果，避免旧响应覆盖新筛选。 */
let loadToken = 0

async function load(silent = false) {
  const token = ++loadToken
  loading.value = true
  try {
    const page = await fetchPage()
    if (token !== loadToken) return
    items.value = page.items
    nextCursor.value = page.nextCursor
    failed.value = false
  } catch (error) {
    if (token !== loadToken || silent) return
    // 保留输入与已加载内容（design §3.3）；首屏失败时给出行内重试。
    // silent（SSE 触发的后台刷新）失败不打断用户，保留旧列表等待下一事件。
    failed.value = true
    notifyActionFailure(
      '加载历史对话',
      `工作空间“${props.workspaceName || props.workspaceId}”`,
      error,
      '稍后重试；若仍失败，请联系工作空间管理员。',
    )
  } finally {
    if (token === loadToken) {
      loading.value = false
      initialized.value = true
    }
  }
}

async function loadMore() {
  const cursor = nextCursor.value
  if (!cursor || loadingMore.value) return
  const token = loadToken
  loadingMore.value = true
  try {
    const page = await fetchPage(cursor)
    if (token !== loadToken) return
    items.value = [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch (error) {
    // 已加载行与游标保持不变，用户可再次点击「加载更多」重试。
    notifyActionFailure(
      '加载更多历史对话',
      `工作空间“${props.workspaceName || props.workspaceId}”`,
      error,
      '稍后点击「加载更多」重试。',
    )
  } finally {
    loadingMore.value = false
  }
}

function clearFilter() {
  keyword.value = ''
  appliedQuery.value = ''
  nextCursor.value = null
  void load()
}

function reset() {
  items.value = []
  nextCursor.value = null
  appliedQuery.value = ''
  keyword.value = ''
  initialized.value = false
  failed.value = false
}

function openSession(item: WorkspaceSessionSummary) {
  // 服务端兼容 Run ID 链接并解析回 Session；没有 Run 的会话退回 Session 身份。
  // TW-10 空间内对话视图：历史会话在空间外壳内打开，停留在 /workspaces/:id 上下文。
  const target = item.latestRun?.id ?? item.sessionId
  void router.push(`/workspaces/${props.workspaceId}/conversations/${target}`)
}

function dotStatus(item: WorkspaceSessionSummary) {
  return item.latestRun?.status ?? ''
}

function dotLabel(item: WorkspaceSessionSummary) {
  return runStatusLabels[dotStatus(item)] ?? '暂无运行'
}

/** 立即按当前输入搜索（Enter 或防抖到期）；相同关键词不重复请求。 */
function applySearchNow() {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }
  const next = keyword.value.trim()
  if (next === appliedQuery.value) return
  appliedQuery.value = next
  void load()
}

watch(keyword, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(applySearchNow, SEARCH_DEBOUNCE_MS)
  if (value.length === 0) applySearchNow()
})

watch(() => props.workspaceId, (workspaceId, previous) => {
  if (previous) taskStore.unsubscribeWorkspaceSessions(previous)
  if (workspaceId) taskStore.subscribeWorkspaceSessions(workspaceId)
  reset()
  void load()
})

/**
 * TW-10 实时更新：订阅本空间的会话活动流——其他成员发消息、@ 触发或
 * 会话删除时服务端推标记，防抖后静默重取第一页（保留当前筛选词）。
 * 后台刷新失败保留旧列表，不打扰用户。
 */
watch(
  () => taskStore.sessionActivity,
  () => {
    if (!initialized.value) return
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer)
    liveRefreshTimer = setTimeout(() => void load(true), 300)
  },
)

onMounted(() => {
  taskStore.subscribeWorkspaceSessions(props.workspaceId)
  void load()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer)
  taskStore.unsubscribeWorkspaceSessions(props.workspaceId)
  // 卸载后丢弃在途响应。
  loadToken += 1
})
</script>

<template>
  <div class="session-history" data-testid="workspace-session-history">
    <div class="panel session-history__toolbar">
      <el-input
        v-model="keyword"
        class="session-history__search"
        placeholder="搜索对话标题"
        clearable
        :prefix-icon="Search"
        aria-label="搜索对话标题"
        @keyup.enter="applySearchNow"
      />
      <span class="session-history__page-info" data-testid="session-history-page-info">
        已加载 {{ items.length }} 个对话{{ nextCursor ? '（还有更多）' : '' }}
      </span>
    </div>

    <el-skeleton v-if="loading && !items.length" class="session-history__skeleton" :rows="5" animated />

    <el-empty
      v-else-if="failed && !items.length"
      data-testid="session-history-error"
      description="历史对话加载失败"
    >
      <el-button @click="load">重试</el-button>
    </el-empty>

    <el-empty
      v-else-if="emptyState === 'archived'"
      data-testid="session-history-empty-archived"
      description="该空间已归档，你没有可查看的历史对话"
    />

    <el-empty
      v-else-if="emptyState === 'own'"
      data-testid="session-history-empty-own"
      description="本工作空间还没有对话"
    >
      <el-button
        v-if="canStartConversation"
        type="primary"
        @click="emit('start-new')"
      >
        发起新对话
      </el-button>
      <p v-else class="session-history__own-guidance">
        当前角色不能发起对话，或该空间尚无可用 Agent 成员。
      </p>
    </el-empty>

    <el-empty
      v-else-if="emptyState === 'filter'"
      data-testid="session-history-empty-filter"
      :description="`没有找到标题包含“${searchedTitle}”的对话`"
    >
      <el-button @click="clearFilter">清除筛选</el-button>
    </el-empty>

    <div v-else-if="items.length" class="panel session-history__list">
      <button
        v-for="item in items"
        :key="item.sessionId"
        class="session-history-row"
        data-testid="session-history-row"
        type="button"
        @click="openSession(item)"
      >
        <span
          class="session-history-row__dot"
          :class="`session-history-row__dot--${dotStatus(item) || 'none'}`"
          data-testid="session-history-dot"
          role="img"
          :aria-label="dotLabel(item)"
        ></span>
        <span class="session-history-row__title" :title="item.title">{{ item.title }}</span>
        <span class="session-history-row__creator" data-testid="session-history-creator">{{ item.creatorName }}</span>
        <span class="session-history-row__time">
          <span class="session-history-row__time-full" data-testid="session-history-time">{{ formatActivityTime(item.lastActiveAt) }}</span>
          <span class="session-history-row__time-short">{{ formatActivityTimeShort(item.lastActiveAt) }}</span>
        </span>
        <StatusTag
          v-if="item.latestRun"
          class="session-history-row__status"
          :status="item.latestRun.status"
        />
        <StatusTag
          v-else
          class="session-history-row__status"
          status="none"
          label="暂无运行"
        />
      </button>

      <div class="session-history__pager">
        <el-button
          v-if="nextCursor"
          data-testid="session-history-load-more"
          :loading="loadingMore"
          @click="loadMore"
        >
          加载更多
        </el-button>
        <span v-else class="session-history__pager-end" data-testid="session-history-end">已加载全部</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-history {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 24px;
  overflow-y: auto;
  background: #f8faf8;
}

.session-history__toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 10px 16px;
  box-shadow: none;
}

.session-history__search {
  width: 290px;
  max-width: 100%;
}

.session-history__page-info {
  flex: 0 0 auto;
  color: #8b918c;
  font-size: var(--dsh-font-size-badge);
}

.session-history__own-guidance {
  margin: 0;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.session-history__skeleton {
  padding: 4px;
}

.session-history__list {
  overflow: hidden;
  flex: 0 0 auto;
  box-shadow: none;
}

.session-history-row {
  display: grid;
  width: 100%;
  grid-template-columns: 12px minmax(0, 1fr) 96px 96px auto;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 10px 16px;
  border: 0;
  border-bottom: 1px solid #e8ebe8;
  color: inherit;
  background: #fff;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: background 120ms ease;
}

.session-history-row:last-of-type {
  border-bottom: 0;
}

.session-history-row:hover {
  background: #f7faf8;
}

.session-history-row:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -3px;
}

.session-history-row__dot {
  width: 5px;
  height: 5px;
  justify-self: center;
  border-radius: 50%;
  background: #858580;
}

.session-history-row__dot--running { background: #527ce2; }
.session-history-row__dot--succeeded { background: #31a47d; }
.session-history-row__dot--failed { background: #d05c67; }
.session-history-row__dot--awaiting_approval { background: #d18a37; }

.session-history-row__title {
  min-width: 0;
  overflow: hidden;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-history-row__creator,
.session-history-row__time {
  overflow: hidden;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-history-row__time-short {
  display: none;
}

.session-history-row__status {
  justify-self: end;
}

.session-history__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60px;
  padding: 10px 16px;
  border-top: 1px solid #e8ebe8;
  background: #fff;
}

.session-history__pager-end {
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}

@media (max-width: 640px) {
  .session-history {
    padding: 14px 14px 20px;
  }

  .session-history__toolbar {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .session-history__search {
    width: 100%;
  }

}

@media (max-width: 520px) {
  /* design §2.2：≤520px 隐藏发起人，时间只保留短格式。 */
  .session-history-row {
    grid-template-columns: 12px minmax(0, 1fr) 76px auto;
    gap: 10px;
    padding: 10px 12px;
  }

  .session-history-row__creator {
    display: none;
  }

  .session-history-row__time-full {
    display: none;
  }

  .session-history-row__time-short {
    display: inline;
  }
}
</style>
