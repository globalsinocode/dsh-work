<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { workbenchApi } from '@/api/client'
import type { WorkspaceFile, WorkspaceFileProjection } from '@/types/domain'

const props = defineProps<{
  workspaceId: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  select: [file: WorkspaceFileProjection]
}>()

const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const items = ref<WorkspaceFile[]>([])
const nextCursor = ref<string | null>(null)

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

async function loadPage(cursor?: string) {
  if (!props.workspaceId) return
  const loadingMoreMode = Boolean(cursor)
  if (loadingMoreMode) loadingMore.value = true
  else loading.value = true
  error.value = ''
  try {
    const page = await workbenchApi.listWorkspaceFiles(props.workspaceId, { cursor })
    if (loadingMoreMode) {
      items.value = [...items.value, ...page.items.filter(row => !items.value.some(item => item.id === row.id))]
    } else {
      items.value = page.items
    }
    nextCursor.value = page.nextCursor
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文件加载失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

watch(
  () => [open.value, props.workspaceId] as const,
  ([visible, workspaceId]) => {
    if (visible && workspaceId) void loadPage()
  },
)

function selectFile(file: WorkspaceFile) {
  if (file.canReference !== true || !file.logicalFileId) return
  emit('select', {
    id: file.id,
    logicalFileId: file.logicalFileId,
    name: file.name,
    source: 'workspace',
    sizeLabel: file.sizeLabel ?? file.size,
    versionNo: file.versionNo ?? 1,
    versionCount: file.versionCount ?? 1,
    parseStatus: (file.parseStatus ?? 'pending') as WorkspaceFileProjection['parseStatus'],
    parseErrorCode: file.parseErrorCode ?? null,
    canReference: true,
    canDownload: file.canDownload ?? false,
    createdAt: file.createdAt ?? file.uploadedAt,
    updatedAt: file.updatedAt ?? file.uploadedAt,
  })
  open.value = false
}

function describeStatus(file: WorkspaceFile) {
  if (file.parseStatus === 'pending') return '解析中'
  if (file.parseStatus === 'failed') return file.parseErrorCode ? `解析失败（${file.parseErrorCode}）` : '解析失败'
  return file.canReference ? '可引用' : '不可引用'
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="选择团队文件"
    width="520px"
    append-to-body
    destroy-on-close
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <el-skeleton v-if="loading" animated :rows="4" />
    <ul v-else class="picker-list">
      <li v-for="file in items" :key="file.id">
        <button
          type="button"
          class="picker-row"
          :disabled="file.canReference !== true"
          :aria-label="`选择 ${file.name}`"
          @click="selectFile(file)"
        >
          <strong>{{ file.name }}</strong>
          <span>{{ file.sizeLabel ?? file.size }} · {{ describeStatus(file) }}</span>
        </button>
      </li>
    </ul>
    <template #footer>
      <el-button v-if="nextCursor" :loading="loadingMore" aria-label="加载更多" @click="loadPage(nextCursor ?? undefined)">
        加载更多
      </el-button>
      <el-button @click="open = false">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.picker-row {
  width: 100%;
  text-align: left;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--el-fill-color-blank);
  cursor: pointer;
}

.picker-row:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.picker-row strong {
  display: block;
}
</style>
