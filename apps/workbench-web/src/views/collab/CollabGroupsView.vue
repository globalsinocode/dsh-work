<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { describeWorkspaceActivity } from '@dsh-work/workbench-components'

import { workbenchApi } from '@/api/client'
import CreateProjectSpaceDialog from '@/components/CreateProjectSpaceDialog.vue'
import CollabDirectoryLayout from '@/components/collab/CollabDirectoryLayout.vue'
import type { Workspace, WorkspaceActivityItem, WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'

/** 协作模式「群组」页（D25）：团队项目空间的目录，左列表 + 右概览。 */
type GroupFilter = 'active' | 'archived'
const filterOptions: Array<{ id: GroupFilter; label: string }> = [
  { id: 'active', label: '活动' },
  { id: 'archived', label: '已归档' },
]

const route = useRoute()
const router = useRouter()
const filter = ref<GroupFilter>('active')
const keyword = ref('')
const groups = ref<Workspace[]>([])
const loading = ref(true)
const errorMessage = ref('')
const createOpen = ref(false)
let listToken = 0

const selectedId = computed(() => {
  const raw = route.params.id
  return typeof raw === 'string' ? raw : ''
})
const selected = computed(() => groups.value.find(group => group.id === selectedId.value))
const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return groups.value
  return groups.value.filter(group => group.name.toLowerCase().includes(text))
})

async function loadGroups() {
  const token = ++listToken
  loading.value = true
  errorMessage.value = ''
  groups.value = []
  try {
    const items = await workbenchApi.getWorkspaces(filter.value)
    if (token !== listToken) return
    groups.value = items.filter(item => item.type !== 'personal')
  } catch (cause) {
    if (token !== listToken) return
    errorMessage.value = cause instanceof Error ? cause.message : '群组加载失败'
  } finally {
    if (token === listToken) loading.value = false
  }
}

function setFilter(next: GroupFilter) {
  if (filter.value === next) return
  filter.value = next
  void loadGroups()
}

function select(id: string) {
  void router.push({ name: 'collab-group', params: { id } })
}
function back() {
  void router.push({ name: 'collab-groups' })
}
function openChat(id: string, info = false) {
  void router.push({ name: 'collab-group-chat', params: { id }, query: info ? { info: '1' } : {} })
}
function onCreated(workspace: Workspace) {
  void router.push({ name: 'collab-group-chat', params: { id: workspace.id }, query: { info: '1', invite: '1' } })
}

/** 详情：每个分项独立加载，失败只影响自己；选中项切换后丢弃迟到的响应。 */
const briefSummary = ref<string | null>(null)
const humans = ref<WorkspaceMember[]>([])
const agentMembers = ref<WorkspaceAgentMember[]>([])
const inProgress = ref<number | null>(null)
const activities = ref<string[]>([])
const detailLoading = ref(false)
let detailToken = 0

function summarize(text: string) {
  const trimmed = text.trim()
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}
function describe(item: WorkspaceActivityItem) {
  return describeWorkspaceActivity({
    kind: item.kind,
    actorDisplayName: item.actorDisplayName,
    safeMetadata: item.safeMetadata,
  })
}

async function loadDetail(id: string) {
  const token = ++detailToken
  briefSummary.value = null
  humans.value = []
  agentMembers.value = []
  inProgress.value = null
  activities.value = []
  if (!id) {
    detailLoading.value = false
    return
  }
  detailLoading.value = true
  const live = () => token === detailToken
  const tasks = [
    workbenchApi.getProjectBrief(id).then(brief => {
      if (live()) briefSummary.value = brief ? summarize(brief.content) : ''
    }),
    workbenchApi.listWorkspaceMembers(id).then(directory => {
      if (live()) humans.value = directory.items
    }),
    workbenchApi.listWorkspaceAgentMembers(id).then(items => {
      if (live()) agentMembers.value = items
    }),
    workbenchApi.listProjectTasks(id, { limit: 100 }).then(page => {
      if (live()) inProgress.value = page.items.filter(task => task.status === 'in_progress').length
    }),
    workbenchApi.listWorkspaceActivity(id, { limit: 3 }).then(page => {
      if (live()) activities.value = page.items.slice(0, 3).map(describe)
    }),
  ]
  await Promise.allSettled(tasks)
  if (live()) detailLoading.value = false
}

watch(selectedId, id => void loadDetail(id), { immediate: true })
onMounted(loadGroups)
</script>

<template>
  <CollabDirectoryLayout
    v-model:keyword="keyword"
    title="群组"
    list-label="群组"
    search-label="搜索群组"
    search-placeholder="搜索"
    :selected="!!selected"
    @back="back"
  >
    <template v-if="filter === 'active'" #action>
      <el-button type="primary" size="small" :icon="Plus" @click="createOpen = true">新建群组</el-button>
    </template>
    <template #filter>
      <el-radio-group :model-value="filter" size="small" aria-label="群组筛选" @update:model-value="setFilter($event as GroupFilter)">
        <el-radio-button v-for="option in filterOptions" :key="option.id" :value="option.id" :label="option.label" />
      </el-radio-group>
    </template>
    <template #status>
      <el-skeleton v-if="loading" :rows="4" animated />
      <el-alert v-else-if="errorMessage" type="error" :closable="false" show-icon :title="errorMessage">
        <el-button link type="primary" @click="loadGroups">重试</el-button>
      </el-alert>
      <p v-else-if="!groups.length" class="dir-status">{{ filter === 'archived' ? '没有已归档的群组' : '还没有群组，点“新建群组”开始' }}</p>
      <p v-else-if="!filtered.length" class="dir-status">没有匹配的群组</p>
    </template>
    <template v-if="filtered.length" #items>
      <li v-for="group in filtered" :key="group.id">
        <button
          type="button"
          class="dir-row"
          :aria-current="group.id === selectedId ? 'page' : undefined"
          @click="select(group.id)"
        >
          <span class="dir-row__avatar dir-row__avatar--puzzle" aria-hidden="true">
            <span v-for="(member, index) in group.members.slice(0, 4)" :key="index">{{ member.slice(0, 1) }}</span>
          </span>
          <span class="dir-row__main">
            <span class="dir-row__name">{{ group.name }}</span>
            <span class="dir-row__sub">{{ group.memberCount }} 位成员</span>
          </span>
        </button>
      </li>
    </template>

    <article v-if="selected" class="group-detail">
      <h2 class="group-detail__name">{{ selected.name }}</h2>
      <section class="group-detail__section">
        <h3>简报摘要</h3>
        <p v-if="detailLoading && briefSummary === null" class="group-detail__muted">加载中…</p>
        <p v-else-if="briefSummary">{{ briefSummary }}</p>
        <p v-else class="group-detail__muted">尚未填写简报</p>
      </section>
      <section class="group-detail__section">
        <h3>员工</h3>
        <p v-if="humans.length">{{ humans.map(member => member.displayName).join('、') }}</p>
        <p v-else class="group-detail__muted">{{ detailLoading ? '加载中…' : '暂无' }}</p>
      </section>
      <section class="group-detail__section">
        <h3>Agent 成员</h3>
        <p v-if="agentMembers.length">{{ agentMembers.map(member => member.name).join('、') }}</p>
        <p v-else class="group-detail__muted">{{ detailLoading ? '加载中…' : '暂无' }}</p>
      </section>
      <section class="group-detail__section">
        <h3>进行中任务</h3>
        <p>{{ inProgress === null ? '—' : inProgress }}</p>
      </section>
      <section class="group-detail__section">
        <h3>最近活动</h3>
        <ul v-if="activities.length" class="group-detail__activity">
          <li v-for="(line, index) in activities" :key="index">{{ line }}</li>
        </ul>
        <p v-else class="group-detail__muted">{{ detailLoading ? '加载中…' : '暂无活动' }}</p>
      </section>
      <div class="group-detail__actions">
        <el-button type="primary" @click="openChat(selected.id)">{{ selected.status === 'archived' ? '查看对话' : '发消息' }}</el-button>
        <el-button @click="openChat(selected.id, true)">管理群组</el-button>
      </div>
    </article>
  </CollabDirectoryLayout>

  <CreateProjectSpaceDialog v-model="createOpen" mode="collab" @created="onCreated" />
</template>

<style scoped>
.group-detail { display: flex; flex-direction: column; gap: 16px; }
.group-detail__name { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-section); }
.group-detail__section h3 { margin: 0 0 4px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-micro); font-weight: 600; }
.group-detail__section p { margin: 0; color: var(--dsh-color-text); font-size: var(--dsh-font-size-body); line-height: 1.6; }
.group-detail__section .group-detail__muted { color: var(--dsh-color-subtle); }
.group-detail__activity { margin: 0; padding-left: 18px; color: var(--dsh-color-text); font-size: var(--dsh-font-size-caption); line-height: 1.7; }
.group-detail__actions { display: flex; gap: 8px; }
</style>
