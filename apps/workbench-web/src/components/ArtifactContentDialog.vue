<script setup lang="ts">
import { Close, Download } from '@element-plus/icons-vue'

import ArtifactPreviewBody from '@/components/ArtifactPreviewBody.vue'
import type { Artifact } from '@/types/domain'
import { downloadArtifactFile } from '@/utils/feedback'

/**
 * 执行隔离 2b-5：Office/PDF 成果的解析文本预览与图片预览（正文由 ArtifactPreviewBody 取得）。
 * 解析文本只是内容参考，不还原版式；不在工作台中渲染 Office/PDF 原文件。HTML 成果仍由
 * ArtifactPreviewDialog 在隔离沙箱中渲染。
 */
const props = defineProps<{
  open: boolean
  /** 成果版本；“我的文件”列表只有 id、版本、名称与类型。 */
  artifact: Pick<Artifact, 'id' | 'version' | 'name' | 'type'> | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
}>()

function download() {
  if (props.artifact) void downloadArtifactFile(props.artifact)
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="artifact-content"
    width="min(880px, calc(100vw - 32px))"
    :show-close="false"
    @update:model-value="(value: boolean) => emit('update:open', value)"
  >
    <template #header="{ titleId, titleClass }">
      <div class="artifact-content__header">
        <div :id="titleId" class="artifact-content__title">
          <span :class="titleClass">成果预览</span>
          <strong>{{ artifact?.name }} · V{{ artifact?.version }}</strong>
        </div>
        <div class="artifact-content__actions">
          <el-button text :icon="Download" data-testid="artifact-content-download" @click="download">下载</el-button>
          <button
            type="button"
            class="artifact-content__close"
            aria-label="关闭成果预览"
            data-testid="artifact-content-close"
            @click="emit('update:open', false)"
          >
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>
    </template>

    <div class="artifact-content__body" data-testid="artifact-content-dialog">
      <ArtifactPreviewBody :artifact="artifact" :active="open" />
    </div>
  </el-dialog>
</template>

<style scoped>
.artifact-content__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.artifact-content__title {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.artifact-content__title strong {
  overflow: hidden;
  margin-top: 3px;
  color: #4d534e;
  font-size: var(--dsh-font-size-badge);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-content__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
}

.artifact-content__close {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #7d827d;
  background: transparent;
  cursor: pointer;
}

.artifact-content__close:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.artifact-content__body {
  overflow: auto;
  max-height: min(68vh, 640px);
}
</style>
