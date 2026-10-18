<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { ProjectArchive, ProjectArchiveVersion } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 项目空间 S2：档案页签（docs/design/project-space-plan.md 第 7 节）。
 * 档案是条目列表，由项目档案员在任务完成后整理，非只读成员可添加、编辑、删除和回退；
 * 每次保存生成新版本并携带基于的版本号，版本已变化时服务端返回 409；
 * 前端收到 409 时把这一次修改重新应用到最新版本后再保存（人工优先，人工验收 6.6/6.8）。
 * 档案只在本页签展示，其他页面不提示。
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  /** 非只读成员且空间未归档。 */
  canWrite: boolean
}>()

const emit = defineEmits<{
  count: [value: number]
  /** 写入被拒绝（如空间已在别处归档、角色变化）：宿主据此刷新空间状态与角色。 */
  stale: []
}>()

const archive = ref<ProjectArchive | null>(null)
const loading = ref(false)
const loadError = ref(false)
const saving = ref(false)
const editIndex = ref<number | null>(null)
const editDraft = ref('')
const adding = ref(false)
const addDraft = ref('')
let requestSeq = 0

const items = computed(() => archive.value?.current?.items ?? [])
const current = computed(() => archive.value?.current ?? null)

async function load() {
  const workspaceId = props.workspaceId
  if (!workspaceId) return
  const seq = ++requestSeq
  loading.value = true
  loadError.value = false
  try {
    const result = await workbenchApi.getProjectArchive(workspaceId)
    if (seq !== requestSeq) return
    archive.value = result
    emit('count', result.current?.items.length ?? 0)
  } catch {
    if (seq !== requestSeq) return
    loadError.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(() => props.workspaceId, () => {
  archive.value = null
  editIndex.value = null
  adding.value = false
  void load()
}, { immediate: true })

function applyVersion(version: ProjectArchiveVersion) {
  archive.value = { current: version, archivistRunning: archive.value?.archivistRunning ?? false }
  emit('count', version.items.length)
}

/**
 * 一次人工修改：在给定条目上应用本次修改，得到新条目；无法应用（要修改的条目已不在）时返回 null。
 * 以操作而不是整份结果保存，档案在编辑期间被档案员或其他成员更新时，可以把这一次修改重新落到最新版本上。
 */
type ArchiveChange = (base: string[]) => string[] | null

interface ChangeHooks {
  /** 已保存或最新档案已包含本次修改；与展示新版本在同一时刻执行，避免输入框先随新版本重绘再关闭。 */
  settled: () => void
  /** 要修改的条目已被改掉或删掉；与展示最新档案在同一时刻执行。 */
  stale?: () => void
}

/**
 * 以整份条目保存为新版本，失败时保留输入。
 * 版本已变化（409）时人工优先：取最新档案，把本次修改重新应用后再保存一次。
 */
async function saveChange(change: ArchiveChange, action: string, hooks: ChangeHooks) {
  if (!props.canWrite || saving.value) return
  saving.value = true
  try {
    const first = change(items.value)
    if (!first) return
    try {
      applyVersion(await saveVersion(current.value?.versionNo ?? 0, first))
      hooks.settled()
      ElMessage.success(`已保存为第 ${current.value?.versionNo} 版`)
      return
    } catch (error) {
      if (!(error instanceof WorkbenchApiError && error.status === 409)) throw error
    }
    const latest = await workbenchApi.getProjectArchive(props.workspaceId)
    const latestItems = latest.current?.items ?? []
    const rebased = change(latestItems)
    if (!rebased || sameItems(rebased, latestItems)) {
      applyArchive(latest)
      if (rebased) hooks.settled()
      else hooks.stale?.()
      return
    }
    applyVersion(await saveVersion(latest.current?.versionNo ?? 0, rebased))
    hooks.settled()
    ElMessage.success(`档案刚被更新，已在最新内容上保存你的修改（第 ${current.value?.versionNo} 版）`)
  } catch (error) {
    notifyActionFailure(action, `项目空间“${props.workspaceName}”的档案`, error, '档案可能已被其他成员或档案员同时更新，请稍后重试。')
    if (!(error instanceof WorkbenchApiError && error.status === 409)) emit('stale')
  } finally {
    saving.value = false
  }
}

function saveVersion(baseVersionNo: number, next: string[]) {
  return workbenchApi.saveProjectArchive(props.workspaceId, { baseVersionNo, items: next })
}

function applyArchive(value: ProjectArchive) {
  requestSeq++
  archive.value = value
  emit('count', value.current?.items.length ?? 0)
}

function sameItems(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function startEdit(index: number) {
  adding.value = false
  editIndex.value = index
  editDraft.value = items.value[index] ?? ''
  void nextTick(() => document.getElementById(`project-archive-edit-${index}`)?.focus())
}

function cancelEdit() {
  editIndex.value = null
  editDraft.value = ''
}

async function saveEdit() {
  const index = editIndex.value
  if (index === null) return
  const text = editDraft.value.trim()
  if (!text) {
    ElMessage.warning('条目内容不能为空；不需要这一条时请删除')
    return
  }
  if (text === items.value[index]) {
    cancelEdit()
    return
  }
  const original = items.value[index]!
  await saveChange((base) => {
    const position = base.indexOf(original)
    return position < 0 ? null : base.map((item, at) => (at === position ? text : item))
  }, '保存档案条目', {
    settled: cancelEdit,
    stale: () => {
      // 要改的那条已被别人改掉或删掉：输入挪到新条目框，避免丢失。
      const draft = editDraft.value
      cancelEdit()
      adding.value = true
      addDraft.value = draft
      ElMessage.warning('你修改的条目刚被其他成员或档案员改动，已显示最新档案；你的内容放在“新条目”里，确认后可添加')
    },
  })
}

async function removeItem(index: number) {
  const text = items.value[index]
  if (text === undefined) return
  try {
    await ElMessageBox.confirm(`“${text}”会从档案中删除，并生成新版本；可在版本历史中回退。`, '删除这一条？', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  // 这一条已被别人删掉时视为完成。
  await saveChange(base => base.filter(item => item !== text), '删除档案条目', { settled: () => {} })
}

function startAdd() {
  editIndex.value = null
  adding.value = true
  addDraft.value = ''
  void nextTick(() => document.getElementById('project-archive-new')?.focus())
}

function cancelAdd() {
  adding.value = false
  addDraft.value = ''
}

async function saveNew() {
  const text = addDraft.value.trim()
  if (!text) {
    ElMessage.warning('请填写条目内容')
    return
  }
  await saveChange(base => (base.includes(text) ? base : [...base, text]), '添加档案条目', { settled: cancelAdd })
}

// ---------------------------------------------------------------------------
// 版本历史
// ---------------------------------------------------------------------------

const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref(false)
const versions = ref<ProjectArchiveVersion[]>([])
const selectedVersionNo = ref<number | null>(null)

async function openHistory(keepSelection = false) {
  historyOpen.value = true
  historyLoading.value = true
  historyError.value = false
  try {
    versions.value = await workbenchApi.listProjectArchiveVersions(props.workspaceId)
    const selected = keepSelection && versions.value.some(version => version.versionNo === selectedVersionNo.value)
    if (!selected) selectedVersionNo.value = versions.value[0]?.versionNo ?? null
  } catch {
    historyError.value = true
  } finally {
    historyLoading.value = false
  }
}

const selectedChanges = computed(() => {
  const index = versions.value.findIndex(version => version.versionNo === selectedVersionNo.value)
  if (index < 0) return null
  const version = versions.value[index]!
  const previous = versions.value[index + 1]?.items ?? []
  return {
    version,
    added: version.items.filter(item => !previous.includes(item)),
    removed: previous.filter(item => !version.items.includes(item)),
  }
})

async function rollbackTo(version: ProjectArchiveVersion) {
  const base = current.value
  if (!props.canWrite || !base || saving.value) return
  try {
    await ElMessageBox.confirm(
      `会以第 ${version.versionNo} 版的内容生成新版本，之后的版本仍保留在历史中。`,
      `回退到第 ${version.versionNo} 版？`,
      { confirmButtonText: '确认回退', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  saving.value = true
  try {
    applyVersion(await workbenchApi.rollbackProjectArchive(props.workspaceId, {
      versionNo: version.versionNo,
      baseVersionNo: base.versionNo,
    }))
    historyOpen.value = false
    ElMessage.success(`已回退到第 ${version.versionNo} 版，生成第 ${current.value?.versionNo} 版`)
  } catch (error) {
    if (error instanceof WorkbenchApiError && error.status === 409) {
      // 回退基于的版本已过时：刷新当前档案与版本历史，确认最新内容后可以再次回退。
      try {
        applyArchive(await workbenchApi.getProjectArchive(props.workspaceId))
        await openHistory(true)
        ElMessage.warning(`档案刚被更新，已刷新到第 ${current.value?.versionNo} 版；确认后可再次回退`)
      } catch (refreshError) {
        notifyActionFailure('回退项目档案', `项目空间“${props.workspaceName}”的档案`, refreshError, '档案已被更新，刷新页面后重试。')
      }
      return
    }
    notifyActionFailure('回退项目档案', `项目空间“${props.workspaceName}”的档案`, error, '档案可能已被更新，重新打开版本历史后重试。')
    emit('stale')
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

const sourceKindLabels: Record<ProjectArchiveVersion['sourceKind'], string> = {
  archivist: '项目档案员',
  manual: '手动编辑',
  rollback: '回退',
}

function sourceText(version: ProjectArchiveVersion) {
  if (version.sourceKind === 'archivist') {
    return version.sourceTasks.length
      ? `依据任务${version.sourceTasks.map(task => `「${task.title}」`).join('')}的成果`
      : '依据已完成任务的成果'
  }
  const who = version.createdBy?.displayName ?? '成员'
  return version.sourceKind === 'rollback' ? `${who}回退到第 ${version.rollbackFromVersionNo} 版` : `${who}手动编辑`
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

defineExpose({ reload: load })
</script>

<template>
  <section
    id="workspace-panel-archive"
    class="project-archive"
    role="tabpanel"
    aria-labelledby="workspace-tab-archive"
  >
    <header class="project-archive__header">
      <div>
        <span class="project-archive__eyebrow">项目协作</span>
        <h1>档案</h1>
        <p v-if="current" class="project-archive__meta" data-testid="project-archive-meta">
          <span>第 {{ current.versionNo }} 版</span>
          <span class="project-archive__source" :class="`project-archive__source--${current.sourceKind}`">
            {{ sourceKindLabels[current.sourceKind] }}
          </span>
          <span>{{ sourceText(current) }} · {{ formatTime(current.createdAt) }}</span>
          <span v-if="archive?.archivistRunning" class="project-archive__source project-archive__source--archivist">档案员整理中</span>
        </p>
      </div>
      <el-button v-if="current" data-testid="project-archive-history" @click="openHistory()">版本历史</el-button>
    </header>

    <p v-if="loading && !archive" class="project-archive__muted">正在加载档案…</p>
    <el-alert v-else-if="loadError" type="error" :closable="false" show-icon title="档案加载失败">
      <el-button size="small" @click="load">重试</el-button>
    </el-alert>
    <div v-else class="project-archive__body">
      <ol v-if="items.length" class="project-archive__list" aria-label="档案条目">
        <li v-for="(item, index) in items" :key="item" class="project-archive__item" data-testid="project-archive-item">
          <span class="project-archive__index" aria-hidden="true">{{ index + 1 }}</span>
          <template v-if="editIndex === index">
            <el-input
              :id="`project-archive-edit-${index}`"
              v-model="editDraft"
              class="project-archive__input"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 6 }"
              maxlength="500"
              :aria-label="`修改第 ${index + 1} 条`"
              @keydown.enter.exact.prevent="saveEdit"
              @keydown.esc="cancelEdit"
            />
            <div class="project-archive__actions">
              <el-button type="primary" size="small" :loading="saving" @click="saveEdit">保存</el-button>
              <el-button size="small" @click="cancelEdit">取消</el-button>
            </div>
          </template>
          <template v-else>
            <span class="project-archive__text">{{ item }}</span>
            <div v-if="canWrite" class="project-archive__actions">
              <el-button size="small" text :aria-label="`编辑第 ${index + 1} 条`" @click="startEdit(index)">编辑</el-button>
              <el-button size="small" text type="danger" :aria-label="`删除第 ${index + 1} 条`" @click="removeItem(index)">删除</el-button>
            </div>
          </template>
        </li>
      </ol>
      <p v-else class="project-archive__empty">还没有档案条目。项目任务完成后由档案员整理。</p>

      <template v-if="canWrite">
        <div v-if="adding" class="project-archive__add">
          <el-input
            id="project-archive-new"
            v-model="addDraft"
            class="project-archive__input"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 6 }"
            maxlength="500"
            placeholder="写一条结论、决策、术语或进展"
            aria-label="新条目"
            @keydown.enter.exact.prevent="saveNew"
            @keydown.esc="cancelAdd"
          />
          <div class="project-archive__actions">
            <el-button type="primary" size="small" :loading="saving" @click="saveNew">添加</el-button>
            <el-button size="small" @click="cancelAdd">取消</el-button>
          </div>
        </div>
        <el-button v-else-if="items.length < 50" data-testid="project-archive-add" :icon="Plus" @click="startAdd">添加一条</el-button>
      </template>
    </div>

    <el-drawer
      v-model="historyOpen"
      class="project-archive__drawer"
      title="档案版本历史"
      direction="rtl"
      size="min(520px, 100vw)"
      :append-to-body="false"
    >
      <p v-if="historyLoading" class="project-archive__muted">正在加载版本历史…</p>
      <el-alert v-else-if="historyError" type="error" :closable="false" show-icon title="版本历史加载失败">
        <el-button size="small" @click="openHistory()">重试</el-button>
      </el-alert>
      <template v-else>
        <ul class="project-archive__versions" aria-label="档案版本">
          <li
            v-for="version in versions"
            :key="version.versionId"
            class="project-archive__version"
            :class="{ 'is-selected': version.versionNo === selectedVersionNo }"
            data-testid="project-archive-version"
          >
            <div class="project-archive__version-main">
              <span class="project-archive__version-title">
                <strong>第 {{ version.versionNo }} 版</strong>
                <span class="project-archive__source" :class="`project-archive__source--${version.sourceKind}`">
                  {{ sourceKindLabels[version.sourceKind] }}
                </span>
                <span v-if="version.versionNo === current?.versionNo" class="project-archive__source">当前</span>
              </span>
              <span class="project-archive__version-meta">{{ sourceText(version) }} · {{ formatTime(version.createdAt) }}</span>
            </div>
            <div class="project-archive__actions">
              <el-button
                size="small"
                text
                :aria-pressed="version.versionNo === selectedVersionNo"
                @click="selectedVersionNo = version.versionNo"
              >
                查看变更
              </el-button>
              <el-button
                v-if="canWrite && version.versionNo !== current?.versionNo"
                size="small"
                type="danger"
                plain
                :loading="saving"
                @click="rollbackTo(version)"
              >
                回退到此版
              </el-button>
            </div>
          </li>
        </ul>
        <section v-if="selectedChanges" class="project-archive__changes" aria-live="polite" data-testid="project-archive-changes">
          <h2>第 {{ selectedChanges.version.versionNo }} 版的变更</h2>
          <ul v-if="selectedChanges.added.length || selectedChanges.removed.length">
            <li v-for="item in selectedChanges.added" :key="`add-${item}`" class="project-archive__change project-archive__change--added">
              <span class="project-archive__change-sign">新增</span>{{ item }}
            </li>
            <li v-for="item in selectedChanges.removed" :key="`del-${item}`" class="project-archive__change project-archive__change--removed">
              <span class="project-archive__change-sign">删除</span>{{ item }}
            </li>
          </ul>
          <p v-else class="project-archive__muted">与上一版内容相同。</p>
        </section>
      </template>
    </el-drawer>
  </section>
</template>

<style scoped>
.project-archive {
  width: 100%;
  height: 100%;
  padding: 30px 32px 48px;
  overflow-y: auto;
  background: var(--dsh-color-canvas);
}

.project-archive__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}

.project-archive__eyebrow {
  color: var(--dsh-color-brand);
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  letter-spacing: 0.1em;
}

.project-archive__header h1 {
  margin: 5px 0 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-page-title);
  font-weight: 680;
}

.project-archive__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
}

.project-archive__source {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsh-color-canvas);
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-badge);
  border: 1px solid var(--dsh-color-border);
}

.project-archive__source--archivist {
  border-color: transparent;
  background: var(--dsh-color-brand-soft);
  color: var(--dsh-color-brand-dark);
}

.project-archive__source--manual {
  border-color: transparent;
  background: var(--dsh-color-success-soft);
  color: var(--dsh-color-success);
}

.project-archive__source--rollback {
  border-color: transparent;
  background: var(--dsh-color-warning-soft);
  color: var(--dsh-color-warning);
}

.project-archive__muted,
.project-archive__empty {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.project-archive__body {
  display: grid;
  gap: 14px;
  justify-items: start;
  padding: 8px 20px 18px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-color-panel);
}

.project-archive__list {
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-archive__item,
.project-archive__add {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 10px;
  width: 100%;
  padding: 10px 0;
  border-bottom: 1px solid var(--dsh-color-border);
}

.project-archive__add {
  border-bottom: 0;
}

.project-archive__index {
  flex: 0 0 24px;
  padding-top: 2px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-badge);
  font-variant-numeric: tabular-nums;
}

.project-archive__text {
  flex: 1 1 260px;
  min-width: 0;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-body);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.project-archive__input {
  flex: 1 1 260px;
  min-width: 0;
}

.project-archive__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 6px;
}

.project-archive__actions .el-button + .el-button {
  margin-left: 0;
}

.project-archive__versions {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-archive__version {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-panel);
}

.project-archive__version.is-selected {
  border-color: var(--dsh-color-brand);
  background: var(--dsh-color-brand-soft);
}

.project-archive__version-main {
  display: grid;
  flex: 1 1 220px;
  gap: 4px;
  min-width: 0;
}

.project-archive__version-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-caption);
}

.project-archive__version-meta {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  overflow-wrap: anywhere;
}

.project-archive__changes {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-sm);
}

.project-archive__changes h2 {
  margin: 0 0 10px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.project-archive__changes ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-archive__change {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.project-archive__change--added {
  background: var(--dsh-color-success-soft);
  color: var(--dsh-color-success);
}

.project-archive__change--removed {
  background: var(--dsh-color-danger-soft);
  color: var(--dsh-color-danger);
  text-decoration: line-through;
}

.project-archive__change-sign {
  margin-right: 8px;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
  text-decoration: none;
  display: inline-block;
}

@media (max-width: 760px) {
  .project-archive {
    padding: 20px 16px 32px;
  }

  .project-archive__header {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .project-archive__body {
    padding: 4px 14px 14px;
  }
}
</style>
