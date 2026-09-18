<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowRight, Plus, Search, UserFilled } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { Workspace, WorkspaceStatusFilter } from '@/types/domain'

const contentStore = useContentStore()
const route = useRoute()
const router = useRouter()
const query = ref('')
const createDialogOpen = ref(false)
const newWorkspaceName = ref('')
const newWorkspaceDescription = ref('')
const creating = ref(false)

/**
 * 归档筛选（design §2.1 / §6）：全部 / 活动 / 已归档，默认全部；状态写入路由
 * `?status=`（沿用对话页签 `?view=history` 的写法），刷新与深链可恢复。
 */
const statusOptions: Array<{ id: WorkspaceStatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活动' },
  { id: 'archived', label: '已归档' },
]
function parseStatusFilter(raw: unknown): WorkspaceStatusFilter {
  return raw === 'active' || raw === 'archived' ? raw : 'all'
}
const statusFilter = ref<WorkspaceStatusFilter>('all')
/**
 * 非「全部」筛选的结果单独存放，避免用筛选结果覆盖全局 `contentStore.workspaces`
 * ——那会改变其它页面（个人空间默认空间、详情回退）的可见范围（AC-23）。
 * 「全部」直接复用全局列表（服务端默认 all），个人空间恒显。
 */
const filteredWorkspacesPage = ref<Workspace[]>([])
const loadingFiltered = ref(false)
/** 筛选请求失败时的错误文案；非空表示当前页签没有可信数据。 */
const filterError = ref<string | null>(null)
let listToken = 0

const sourceWorkspaces = computed(() =>
  (statusFilter.value === 'all' ? contentStore.workspaces : filteredWorkspacesPage.value)
    .filter(workspace => workspace.type === 'team'),
)
const loading = computed(() => (statusFilter.value === 'all' ? contentStore.loading : loadingFiltered.value))

const filteredWorkspaces = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return [...sourceWorkspaces.value]
    .filter((workspace) =>
      !keyword || `${workspace.name} ${workspace.description} ${workspace.owner}`.toLowerCase().includes(keyword),
    )

})

const emptyDescription = computed(() =>
  statusFilter.value === 'archived' && !query.value.trim() ? '暂无已归档的团队空间' : '没有匹配的工作空间',
)

const canCreate = computed(() => Boolean(newWorkspaceName.value.trim()))

/**
 * tablist 键盘操作（design §4「支持键盘」/ AC-16）。roving tabindex 只解决
 * 「Tab 进入一次」，必须自己实现方向键与 Home/End，否则非选中项键盘不可达。
 * 视觉上仍是同一组按钮，选中后把焦点移到新选中项。
 */
function onFilterKeydown(event: KeyboardEvent, current: WorkspaceStatusFilter) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const index = statusOptions.findIndex(option => option.id === current)
  if (index < 0) return
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? statusOptions.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + statusOptions.length) % statusOptions.length
  const next = statusOptions[nextIndex]
  if (!next) return
  setStatusFilter(next.id)
  void nextTick(() => {
    const target = document.querySelector<HTMLButtonElement>(`[data-testid="workspace-filter-${next.id}"]`)
    target?.focus()
  })
}

let lastLoadedStatus: WorkspaceStatusFilter | null = null
async function loadStatusFilter(status: WorkspaceStatusFilter) {
  if (status === 'all') {
    lastLoadedStatus = 'all'
    filteredWorkspacesPage.value = []
    return
  }
  // 同参去重：点击改路由会使 watch 再调一次，这里避免重复请求（真实路由下
  // 原本每次切换会发两次同样的请求）。去重只在**成功后**记账，失败时不记，
  // 以便用户在原页签上重试。
  if (lastLoadedStatus === status && !filterError.value) return
  const token = ++listToken
  loadingFiltered.value = true
  filterError.value = null
  // 先清空上一个筛选的结果：否则请求失败时，新页签下会继续显示旧筛选的卡片
  // （符合性/质量评审 F4）。
  filteredWorkspacesPage.value = []
  try {
    const list = await workbenchApi.getWorkspaces(status)
    if (token !== listToken) return
    filteredWorkspacesPage.value = list
    lastLoadedStatus = status
  } catch (error) {
    if (token !== listToken) return
    filterError.value = error instanceof Error ? error.message : '加载工作空间失败'
    ElMessage.error(filterError.value)
  } finally {
    if (token === listToken) loadingFiltered.value = false
  }
}

/** 失败后允许原地重试（去重记账只在成功时写入，这里显式重跑当前筛选）。 */
function retryStatusFilter() {
  lastLoadedStatus = null
  void loadStatusFilter(statusFilter.value)
}

function setStatusFilter(next: WorkspaceStatusFilter) {
  if (statusFilter.value === next) return
  statusFilter.value = next
  const nextQuery = { ...route.query }
  if (next === 'all') delete nextQuery.status
  else nextQuery.status = next
  void router.replace({ query: nextQuery })
  void loadStatusFilter(next)
}

/**
 * 深链/浏览器前进后退：路由 query 是筛选状态的唯一来源。
 * 实际路由下 `setStatusFilter` 的 `router.replace` 会让这个 watch 也触发一次，
 * 因此 `loadStatusFilter` 自带同参去重（见 `lastLoadedStatus`），保证每次切换
 * 只发一次请求，同时「点击」与「深链」两条路径都能正确加载。
 */
watch(
  () => route.query.status,
  (raw) => {
    const next = parseStatusFilter(raw)
    statusFilter.value = next
    void loadStatusFilter(next)
  },
  { immediate: true },
)

function openWorkspace(workspace: Workspace) {
  void router.push(`/workspaces/${workspace.id}`)
}

async function createWorkspace() {
  if (!canCreate.value) return
  creating.value = true
  try {
    const workspace = await contentStore.createTeamWorkspace({
      name: newWorkspaceName.value.trim(),
      description: newWorkspaceDescription.value.trim(),
    })
    ElMessage.success(`已创建团队工作空间“${newWorkspaceName.value.trim()}”`)
    newWorkspaceName.value = ''
    newWorkspaceDescription.value = ''
    createDialogOpen.value = false
    await router.push(`/workspaces/${workspace.id}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建工作空间失败')
  } finally {
    creating.value = false
  }
}

onMounted(() => contentStore.refresh())
</script>

<template>
  <div class="page-container page-container--wide workspace-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">团队空间</h1>
        <p class="page-description">进入已加入的团队，使用团队资料和获准的 Agent 开展工作。个人对话和文件请使用左侧入口。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="createDialogOpen = true">创建团队工作空间</el-button>
    </header>

    <div class="workspace-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工作空间名称或负责人" />
      <div class="workspace-filter" data-testid="workspace-status-filter" role="tablist" aria-label="工作空间归档筛选">
        <button
          v-for="option in statusOptions"
          :key="option.id"
          :data-testid="`workspace-filter-${option.id}`"
          class="workspace-filter__item"
          :class="{ 'is-active': statusFilter === option.id }"
          type="button"
          role="tab"
          :aria-selected="statusFilter === option.id"
          :tabindex="statusFilter === option.id ? 0 : -1"
          @click="setStatusFilter(option.id)"
          @keydown="onFilterKeydown($event, option.id)"
        >
          {{ option.label }}
        </button>
      </div>
      <span>{{ filteredWorkspaces.length }} 个可访问工作空间</span>
    </div>

    <div v-if="loading" class="workspace-grid">
      <div v-for="index in 3" :key="index" class="workspace-card panel workspace-card--skeleton">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <div v-else-if="filteredWorkspaces.length" class="workspace-grid">
      <button
        v-for="workspace in filteredWorkspaces"
        :key="workspace.id"
        class="workspace-card panel"
        :class="{ 'workspace-card--personal': workspace.type === 'personal' }"
        type="button"
        @click="openWorkspace(workspace)"
      >
        <div class="workspace-card__top">
          <span class="workspace-card__icon" :class="{ 'workspace-card__icon--personal': workspace.type === 'personal' }">
            <el-icon><UserFilled /></el-icon>
          </span>
          <span class="workspace-card__tags">
            <StatusTag status="neutral" :label="workspace.type === 'personal' ? '个人工作空间' : '团队工作空间'" />
            <StatusTag
              v-if="workspace.type === 'team' && workspace.status === 'archived'"
              data-testid="workspace-card-archived-tag"
              status="warning"
              label="已归档"
            />
          </span>
        </div>
        <h2>{{ workspace.name }}</h2>
        <p>{{ workspace.description }}</p>
        <div class="workspace-card__metrics">
          <div><strong>{{ workspace.sessionCount }}</strong><span>对话</span></div>
          <div><strong>{{ workspace.files.length }}</strong><span>文件</span></div>
          <div><strong>{{ workspace.artifactCount }}</strong><span>成果</span></div>
          <div><strong>{{ workspace.memberCount }}</strong><span>{{ workspace.type === 'personal' ? '访问者' : '成员' }}</span></div>
        </div>
        <div class="workspace-card__footer">
          <span v-if="workspace.type === 'personal'">仅你可访问 · {{ workspace.updatedAt }}更新</span>
          <span v-else>负责人 {{ workspace.owner }} · {{ workspace.updatedAt }}更新</span>
          <el-icon><ArrowRight /></el-icon>
        </div>
      </button>
    </div>

    <el-empty
      v-else-if="filterError"
      data-testid="workspace-filter-error"
      :description="`加载失败：${filterError}`"
    >
      <el-button @click="retryStatusFilter">重试</el-button>
    </el-empty>

    <el-empty v-else :description="emptyDescription">
      <el-button @click="query = ''">清除筛选</el-button>
    </el-empty>

    <el-dialog v-model="createDialogOpen" title="创建团队工作空间" width="min(520px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="工作空间名称" required>
          <el-input v-model="newWorkspaceName" maxlength="40" show-word-limit placeholder="例如：九月交付风险分析" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input
            v-model="newWorkspaceDescription"
            type="textarea"
            :rows="3"
            maxlength="120"
            show-word-limit
            placeholder="说明团队将围绕什么业务主题开展协作"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!canCreate" :loading="creating" @click="createWorkspace">创建工作空间</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.workspace-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 17px;
}

.workspace-toolbar .el-input {
  width: 290px;
}

/* 归档筛选（design §2.1）：紧凑分段按钮，沿用页签 item 的描边 + 字号规范。 */
.workspace-filter {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: stretch;
  gap: 2px;
  padding: 2px;
  border: 1px solid #e3e5e2;
  border-radius: 9px;
  background: #fff;
}

.workspace-filter__item {
  min-height: 26px;
  padding: 0 11px;
  border: 0;
  border-radius: 7px;
  color: #777c77;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  transition: color 140ms ease, background 140ms ease;
}

.workspace-filter__item:hover {
  color: #244d40;
  background: #f4f7f5;
}

.workspace-filter__item.is-active {
  color: #1f5a49;
  background: #eaf4f0;
  font-weight: 620;
}

.workspace-filter__item:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -2px;
}

.workspace-toolbar > span {
  margin-left: auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.workspace-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
}

.workspace-card {
  display: flex;
  min-height: 300px;
  flex-direction: column;
  padding: 20px;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}

.workspace-card:hover {
  transform: translateY(-2px);
  border-color: #bdcae6;
  box-shadow: 0 12px 32px rgb(30 50 90 / 8%);
}

.workspace-card--skeleton {
  cursor: default;
}

.workspace-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.workspace-card__tags {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.workspace-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 11px;
  color: #315dc4;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.workspace-card__icon--personal {
  color: #147454;
  background: #eaf7f1;
}

.workspace-card h2 {
  margin: 18px 0 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
}

.workspace-card > p {
  min-height: 46px;
  margin: 8px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.65;
}

.workspace-card__metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 20px;
  padding: 13px 0;
  border-top: 1px solid #eef0f4;
  border-bottom: 1px solid #eef0f4;
}

.workspace-card__metrics div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-right: 1px solid #edf0f4;
  text-align: center;
}

.workspace-card__metrics div:last-child {
  border-right: 0;
}

.workspace-card__metrics strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-subheading);
}

.workspace-card__metrics span {
  margin-top: 3px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-micro);
}

.workspace-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 17px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

@media (max-width: 1120px) {
  .workspace-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .workspace-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .workspace-toolbar .el-input {
    width: 100%;
  }

  .workspace-toolbar > span {
    margin-left: 0;
  }

  .workspace-grid {
    grid-template-columns: 1fr;
  }
}
</style>
