<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, EditPen } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { ProjectBrief } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

// 桌面右栏与移动抽屉可能同时存在实例；用组件级唯一 id 避免 aria 关联指向另一份副本。
const briefTitleId = useId()
const briefBodyId = useId()

/**
 * 项目空间 S1：右栏顶部的项目简报（docs/design/project-space-plan.md 第 4 节）。
 * 全部成员可读；负责人与管理员在活动空间可编辑，每次保存生成新版本。
 * 被指派的 Agent 执行任务时会带上当前简报。
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  /** 负责人或管理员且空间未归档；由宿主按服务端角色判定。 */
  canEdit: boolean
}>()

const brief = ref<ProjectBrief | null>(null)
const loading = ref(false)
const loadError = ref(false)
const editorOpen = ref(false)
const draftContent = ref('')
const draftDueDate = ref<string | null>(null)
const saving = ref(false)
let requestSeq = 0

/** 右栏卡片可收起（项目空间 S2）；收起状态只是本浏览器的偏好，读写失败时按展开处理。 */
const collapsedStorageKey = 'dsh-work.project-brief.collapsed'
const collapsed = ref(readCollapsed())

function readCollapsed() {
  try {
    return window.localStorage.getItem(collapsedStorageKey) === '1'
  } catch {
    return false
  }
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  try {
    window.localStorage.setItem(collapsedStorageKey, collapsed.value ? '1' : '0')
  } catch {
    // 偏好未能保存不影响当前展示。
  }
}

async function load() {
  const workspaceId = props.workspaceId
  if (!workspaceId) return
  const seq = ++requestSeq
  loading.value = true
  loadError.value = false
  try {
    const result = await workbenchApi.getProjectBrief(workspaceId)
    if (seq !== requestSeq) return
    brief.value = result
  } catch {
    if (seq !== requestSeq) return
    loadError.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(() => props.workspaceId, () => {
  brief.value = null
  void load()
}, { immediate: true })

function openEditor() {
  if (!props.canEdit) return
  draftContent.value = brief.value?.content ?? ''
  draftDueDate.value = brief.value?.dueDate ?? null
  editorOpen.value = true
}

async function save() {
  if (!props.canEdit || saving.value) return
  const content = draftContent.value.trim()
  if (!content) {
    ElMessage.warning('请填写简报内容')
    return
  }
  saving.value = true
  try {
    brief.value = await workbenchApi.saveProjectBrief(props.workspaceId, { content, dueDate: draftDueDate.value || null })
    editorOpen.value = false
    ElMessage.success('项目简报已更新')
  } catch (error) {
    // 保存失败保留输入，便于修改后重试。
    notifyActionFailure('保存项目简报', `项目空间“${props.workspaceName}”`, error, '确认内容不超过 8000 字、你仍是负责人或管理员后重试。')
  } finally {
    saving.value = false
  }
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

defineExpose({ reload: load })
</script>

<template>
  <section class="project-brief" :aria-labelledby="briefTitleId" data-testid="project-brief">
    <header class="project-brief__header">
      <h2 :id="briefTitleId">
        <button
          class="project-brief__toggle"
          type="button"
          data-testid="project-brief-toggle"
          :aria-expanded="!collapsed"
          :aria-controls="briefBodyId"
          @click="toggleCollapsed"
        >
          <el-icon class="project-brief__chevron" :class="{ 'is-collapsed': collapsed }"><ArrowDown /></el-icon>
          项目简报
        </button>
      </h2>
      <el-button
        v-if="canEdit && brief && !collapsed"
        data-testid="project-brief-edit"
        text
        :icon="EditPen"
        @click="openEditor"
      >
        编辑简报
      </el-button>
    </header>

    <div v-show="!collapsed" :id="briefBodyId">
    <p v-if="loading && !brief" class="project-brief__muted">正在加载简报…</p>
    <p v-else-if="loadError" class="project-brief__muted">
      简报加载失败。
      <el-button text size="small" @click="load">重试</el-button>
    </p>
    <template v-else-if="brief">
      <p class="project-brief__content" data-testid="project-brief-content">{{ brief.content }}</p>
      <p v-if="brief.dueDate" class="project-brief__due" data-testid="project-brief-due">截止 {{ brief.dueDate }}</p>
      <p class="project-brief__meta">
        第 {{ brief.versionNo }} 版 · {{ brief.updatedBy.displayName }} 更新于 {{ formatTime(brief.updatedAt) }}
      </p>
    </template>
    <div v-else class="project-brief__empty">
      <p>还没有项目简报。写下目标、范围与约束，Agent 承接任务时会参考它。</p>
      <el-button v-if="canEdit" data-testid="project-brief-create" size="small" type="primary" plain @click="openEditor">
        填写简报
      </el-button>
      <small v-else>负责人或管理员可以填写简报。</small>
    </div>
    </div>

    <el-dialog
      v-model="editorOpen"
      title="编辑项目简报"
      width="min(560px, calc(100vw - 32px))"
      :close-on-click-modal="false"
      :append-to-body="false"
    >
      <form class="project-brief__form" @submit.prevent="save">
        <div class="project-brief__field">
          <span>简报内容</span>
          <el-input
            v-model="draftContent"
            data-testid="project-brief-input"
            type="textarea"
            :rows="8"
            maxlength="8000"
            show-word-limit
            placeholder="目标：……&#10;范围：……&#10;约束：……"
            aria-label="简报内容"
          />
        </div>
        <div class="project-brief__field">
          <span>截止时间（可选）</span>
          <el-date-picker
            class="project-field__control"
            v-model="draftDueDate"
            data-testid="project-brief-due-input"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            clearable
            aria-label="截止时间"
          />
        </div>
      </form>
      <template #footer>
        <el-button @click="editorOpen = false">取消</el-button>
        <el-button type="primary" data-testid="project-brief-save" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.project-brief {
  padding: 16px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md);
  background: var(--dsh-color-panel);
}

.project-brief__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.project-brief__header h2 {
  margin: 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-title);
  font-weight: 650;
}

.project-brief__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.project-brief__toggle:focus-visible {
  outline: 2px solid var(--dsh-color-brand);
  outline-offset: 2px;
  border-radius: 4px;
}

.project-brief__chevron {
  color: var(--dsh-color-muted);
  transition: transform 0.15s ease;
}

.project-brief__chevron.is-collapsed {
  transform: rotate(-90deg);
}

.project-brief__content {
  margin: 10px 0 0;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.project-brief__due {
  display: inline-block;
  margin: 10px 0 0;
  padding: 2px 8px;
  border-radius: var(--dsh-radius-sm);
  background: var(--dsh-color-warning-soft);
  color: var(--dsh-color-warning);
  font-size: var(--dsh-font-size-badge);
}

.project-brief__meta,
.project-brief__muted {
  margin: 10px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
}

.project-brief__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.project-brief__empty p {
  margin: 0;
}

.project-brief__form {
  display: grid;
  gap: 16px;
}

.project-brief__field {
  display: grid;
  gap: 6px;
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
}

/* 下拉与日期控件在网格表单中显式撑满：宽度由内容决定时，Element Plus 的尺寸计算会在视口变化后反复抖动。 */
.project-field__control {
  width: 100%;
}
</style>
