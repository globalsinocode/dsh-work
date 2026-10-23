<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatLineRound } from '@element-plus/icons-vue'
import { describeWorkspaceActivity } from '@dsh-work/workbench-components'

import { workbenchApi } from '@/api/client'
import CreateProjectSpaceDialog from '@/components/CreateProjectSpaceDialog.vue'
import CollabAvatar from '@/components/collab/CollabAvatar.vue'
import CollabDirectoryLayout from '@/components/collab/CollabDirectoryLayout.vue'
import CollabProfile from '@/components/collab/CollabProfile.vue'
import type { ProjectTaskStatus, Workspace, WorkspaceActivityItem, WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'

/** 协作模式「群组」页（D25，样式按 B 原型）：团队项目空间的目录，左列表 + 右居中概览。 */
type GroupFilter = 'all' | 'active' | 'archived'
const filterOptions: Array<{ id: GroupFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活动' },
  { id: 'archived', label: '已归档' },
]
const roleNotes: Partial<Record<WorkspaceMember['role'], string>> = { owner: '负责人', admin: '管理员', viewer: '只读' }

const route = useRoute()
const router = useRouter()
const filter = ref<GroupFilter>('all')
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
const taskCounts = ref<Record<ProjectTaskStatus, number> | null>(null)
const latestActivity = ref<string | null>(null)
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
  taskCounts.value = null
  latestActivity.value = null
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
      if (!live()) return
      const counts: Record<ProjectTaskStatus, number> = { todo: 0, in_progress: 0, done: 0 }
      for (const task of page.items) counts[task.status] += 1
      taskCounts.value = counts
    }),
    workbenchApi.listWorkspaceActivity(id, { limit: 1 }).then(page => {
      if (live()) latestActivity.value = page.items[0] ? describe(page.items[0]) : ''
    }),
  ]
  await Promise.allSettled(tasks)
  if (live()) detailLoading.value = false
}

function listSub(group: Workspace) {
  return `${group.memberCount} 位员工`
}

const detailSub = computed(() => {
  if (!selected.value) return ''
  const people = humans.value.length || selected.value.memberCount
  return agentMembers.value.length ? `${people} 位员工 · ${agentMembers.value.length} 个 Agent` : `${people} 位员工`
})
const loadingText = '加载中…'
const facts = computed(() => {
  if (!selected.value) return []
  const counts = taskCounts.value
  const tasks = counts === null
    ? loadingText
    : [[counts.in_progress, '进行中'], [counts.todo, '待办'], [counts.done, '已完成']]
      .filter(([count]) => Number(count) > 0)
      .map(([count, label]) => `${count} 个${label}`)
      .join(' · ') || '暂无任务'
  return [
    { label: '状态', value: selected.value.status === 'archived' ? '已归档（只读）' : '活动' },
    { label: '任务', value: tasks },
    { label: '最近活动', value: latestActivity.value === null ? loadingText : latestActivity.value || '暂无活动' },
  ]
})
const memberChips = computed(() => [
  ...humans.value.map(member => ({
    key: `u:${member.userId}`,
    label: roleNotes[member.role] ? `${member.displayName}（${roleNotes[member.role]}）` : member.displayName,
    agent: false,
  })),
  ...agentMembers.value.map(member => ({ key: `a:${member.id}`, label: member.name, agent: true })),
])

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
    <template #action>
      <button type="button" class="dir-action" @click="createOpen = true">＋ 新建群组</button>
    </template>
    <template #filter>
      <div role="group" aria-label="群组筛选" class="group-filter">
        <button
          v-for="option in filterOptions"
          :key="option.id"
          type="button"
          class="dir-chip"
          :aria-pressed="filter === option.id"
          @click="setFilter(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
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
          <CollabAvatar kind="group" :names="group.members" />
          <span class="dir-row__main">
            <span class="dir-row__name">{{ group.name }}</span>
            <span class="dir-row__sub">{{ listSub(group) }}</span>
          </span>
          <span v-if="group.status === 'archived'" class="dir-row__badge">已归档</span>
        </button>
      </li>
    </template>

    <CollabProfile
      v-if="selected"
      class="group-detail"
      :name="selected.name"
      :sub="detailSub"
      :description="briefSummary || selected.description || (detailLoading && briefSummary === null ? '' : '尚未填写简报')"
      :facts="facts"
    >
      <template #avatar><CollabAvatar kind="group" :names="selected.members" :size="88" /></template>
      <template #actions>
        <el-button type="primary" :icon="ChatLineRound" @click="openChat(selected.id)">{{ selected.status === 'archived' ? '查看对话' : '发消息' }}</el-button>
        <el-button @click="openChat(selected.id, true)">管理群组</el-button>
      </template>
      <section class="collab-profile__card" aria-label="成员">
        <h3>成员</h3>
        <p v-if="!memberChips.length" class="group-detail__muted">{{ detailLoading ? '加载中…' : '暂无成员' }}</p>
        <ul v-else class="group-detail__chips">
          <li v-for="chip in memberChips" :key="chip.key" :class="{ 'is-agent': chip.agent }">{{ chip.label }}</li>
        </ul>
      </section>
    </CollabProfile>
  </CollabDirectoryLayout>

  <CreateProjectSpaceDialog v-model="createOpen" mode="collab" @created="onCreated" />
</template>

<style scoped>
.group-filter { display: flex; flex-wrap: wrap; gap: 6px; }
.group-detail__muted { margin: 0; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); }
.group-detail__chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.group-detail__chips li {
  padding: 4px 12px; border-radius: 14px; color: var(--dsh-color-text); background: var(--dsh-color-canvas);
  font-size: var(--dsh-font-size-caption);
}
.group-detail__chips li.is-agent { color: var(--dsh-color-brand-dark); background: var(--dsh-color-brand-soft); }
</style>
