<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { WorkspaceFileVersion } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { runGuardedAction } from '@/utils/action-guard'
import { triggerBlobDownload } from '@/utils/download-file'
import { canReferenceVersion, describeVersionParseStatus } from '@/utils/workspace-file-versions'

/**
 * 单个逻辑文件的版本列表（TW-07 / 3-T9）。
 *
 * 本组件只覆盖**读取轨**：归档空间的现任成员仍可打开列表并下载历史版本；
 * 上传新版本属执行轨（归档与只读成员由服务端 403），入口在文件行上，由宿主按
 * 「团队 + 活跃 + 非只读成员」判定后渲染。个人空间不渲染本组件（AC-23）。
 */
const props = withDefaults(defineProps<{
  open: boolean
  workspaceId: string
  logicalFileId: string
  fileName: string
  /** 是否允许引用历史版本（归档空间为 false，与「引用到对话」同口径）。 */
  canReference?: boolean
}>(), {
  canReference: true,
})

const emit = defineEmits<{
  'update:open': [boolean]
  /** 引用某个版本到新对话；宿主负责把该版本的不可变对象 id 交给 ConversationStarter。 */
  reference: [WorkspaceFileVersion]
}>()

const versions = ref<WorkspaceFileVersion[]>([])
const loading = ref(false)
const error = ref(false)

/**
 * 请求世代 + 发起时的 (空间, 逻辑文件) 双重比对：切换文件或关闭再打开另一个
 * 文件时，晚到的旧响应不得写进当前列表（与 3-T8 动态抽屉同一防竞态口径）。
 */
let requestSeq = 0

function isCurrentRequest(seq: number, workspaceId: string, logicalFileId: string) {
  return seq === requestSeq
    && workspaceId === props.workspaceId
    && logicalFileId === props.logicalFileId
}

/** 读取轨：版本列表与历史下载在归档空间仍可用（服务端 allowArchived）。 */
async function loadVersions(workspaceId = props.workspaceId, logicalFileId = props.logicalFileId) {
  if (!workspaceId || !logicalFileId) return
  const seq = ++requestSeq
  loading.value = true
  try {
    const page = await workbenchApi.listWorkspaceFileVersions(workspaceId, logicalFileId)
    if (!isCurrentRequest(seq, workspaceId, logicalFileId)) return
    versions.value = Array.isArray(page.items) ? page.items : []
    error.value = false
  } catch (cause) {
    if (!isCurrentRequest(seq, workspaceId, logicalFileId)) return
    versions.value = []
    error.value = true
    notifyActionFailure('加载文件版本', `文件“${props.fileName}”`, cause, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (isCurrentRequest(seq, workspaceId, logicalFileId)) loading.value = false
  }
}

/**
 * 打开、切换逻辑文件、关闭都先作废在途请求并清空上一份结果。
 *
 * 宿主在关闭后仍保留 `logicalFileId`（只在切换空间时置空），因此「关闭 A → 打开 B」
 * 会复用同一个组件实例：不清空就会把 A 的版本历史渲染在 B 的文件名之下，行内「下载」
 * 还会拿 A 的版本号去请求 B（评审 P1 实测）。清空 + 世代号也顺带保证关闭/卸载后晚到
 * 的失败不会弹给用户（评审 P2）。
 */
watch(
  () => [props.open, props.workspaceId, props.logicalFileId] as const,
  ([open]) => {
    requestSeq += 1
    versions.value = []
    error.value = false
    loading.value = false
    if (!open) return
    void loadVersions()
  },
  { immediate: true },
)

/** 组件卸载（例如切换空间）后在途请求一律作废，避免已离开的页面弹失败提示。 */
onBeforeUnmount(() => {
  requestSeq += 1
})

/** 历史版本下载：是否可下载一律以服务端 `canDownload` 为准（入口已按其渲染）。 */
function downloadVersion(version: WorkspaceFileVersion) {
  const key = `workspace-file:${props.workspaceId}:${props.logicalFileId}:v${version.versionNo}`
  void runGuardedAction(key, async () => {
    try {
      const blob = await workbenchApi.downloadWorkspaceFileVersion(
        props.workspaceId,
        props.logicalFileId,
        version.versionNo,
      )
      triggerBlobDownload(blob, version.name)
      ElMessage.success(`已下载“${version.name}”V${version.versionNo}`)
    } catch (cause) {
      notifyActionFailure(
        '版本下载',
        `文件“${version.name}”V${version.versionNo}`,
        cause,
        '刷新版本列表后重试；若仍失败，请联系工作空间管理员。',
      )
    }
  })
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="workspace-file-versions"
    width="min(640px, calc(100vw - 32px))"
    :show-close="false"
    @update:model-value="(value: boolean) => emit('update:open', value)"
  >
    <!--
      不传 `title` 是有意的：Element Plus 在 `title` 存在时只写死 `aria-label='文件版本'`
      （dialog.vue:75），不传时才写 `aria-labelledby=titleId`（:76），这样下面这个同时
      含「文件版本」与文件名的元素才能成为可访问名称，屏幕阅读器才能区分不同文件的
      版本弹窗（评审 nit）。
    -->
    <template #header="{ titleId, titleClass }">
      <div class="workspace-file-versions__header">
        <div :id="titleId" class="workspace-file-versions__title">
          <span :class="titleClass">文件版本</span>
          <strong>{{ fileName }}</strong>
        </div>
        <button
          data-testid="file-versions-close"
          class="workspace-file-versions__close"
          type="button"
          aria-label="关闭文件版本"
          @click="emit('update:open', false)"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </template>

    <div class="workspace-file-versions__body" data-testid="file-versions-dialog">
      <p class="workspace-file-versions__hint">
        新引用默认使用最新有效版本；历史 Run 与实际输入版本可按版本追溯。
      </p>

      <el-skeleton
        v-if="loading && !versions.length"
        data-testid="file-versions-skeleton"
        :rows="4"
        animated
      />

      <div v-else-if="error" data-testid="file-versions-error" class="workspace-file-versions__error">
        <p>版本加载失败</p>
        <el-button data-testid="file-versions-retry" @click="loadVersions()">重试</el-button>
      </div>

      <el-empty
        v-else-if="!versions.length"
        data-testid="file-versions-empty"
        description="该文件暂无版本记录"
      />

      <ul v-else class="workspace-file-versions__list">
        <li
          v-for="version in versions"
          :key="version.fileId"
          data-testid="file-versions-row"
          class="workspace-file-versions__row"
        >
          <div class="workspace-file-versions__row-head">
            <strong>V{{ version.versionNo }}</strong>
            <span
              v-if="version.current"
              data-testid="file-versions-current"
              class="workspace-file-versions__current"
            >当前版本</span>
            <span data-testid="file-versions-parse-status" class="workspace-file-versions__status">
              {{ describeVersionParseStatus(version.parseStatus) }}
            </span>
          </div>
          <p class="workspace-file-versions__meta">
            {{ version.size }} · {{ version.uploadedBy }}上传 · {{ version.uploadedAt }}
          </p>
          <p v-if="version.note" data-testid="file-versions-note" class="workspace-file-versions__note">
            更新说明：{{ version.note }}
          </p>
          <div class="workspace-file-versions__row-actions">
            <el-button
              v-if="version.canDownload"
              data-testid="file-versions-download"
              size="small"
              plain
              @click="downloadVersion(version)"
            >
              下载
            </el-button>
            <span v-else class="workspace-file-versions__unavailable">不可下载</span>
            <el-button
              v-if="canReference && canReferenceVersion(version)"
              data-testid="file-versions-reference"
              size="small"
              type="primary"
              plain
              @click="emit('reference', version)"
            >
              引用此版本
            </el-button>
          </div>
        </li>
      </ul>
    </div>
  </el-dialog>
</template>

<style scoped>
.workspace-file-versions__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-file-versions__title {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-file-versions__title strong {
  overflow: hidden;
  margin-top: 3px;
  color: #4d534e;
  font-size: var(--dsh-font-size-badge);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-versions__close {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #7d827d;
  background: transparent;
  cursor: pointer;
}

.workspace-file-versions__close:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.workspace-file-versions__hint {
  margin: 0 0 10px;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.workspace-file-versions__error {
  padding: 18px 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.workspace-file-versions__list {
  display: flex;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.workspace-file-versions__row {
  padding: 11px 13px;
  border: 1px solid #e5e8e4;
  border-radius: 10px;
  background: #fff;
}

.workspace-file-versions__row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-file-versions__row-head strong {
  color: #2c322e;
  font-size: var(--dsh-font-size-caption);
  font-weight: 680;
}

.workspace-file-versions__current {
  padding: 2px 7px;
  border-radius: 999px;
  color: #155e4b;
  background: #e7f4ee;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.workspace-file-versions__status {
  color: #6c726d;
  font-size: var(--dsh-font-size-micro);
}

.workspace-file-versions__meta {
  margin: 5px 0 0;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}

.workspace-file-versions__note {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  color: #5c635e;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.workspace-file-versions__row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}

.workspace-file-versions__unavailable {
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}
</style>
