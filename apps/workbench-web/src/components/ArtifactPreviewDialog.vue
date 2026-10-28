<script setup lang="ts">
import { ref } from 'vue'
import { Close, Download } from '@element-plus/icons-vue'

import ArtifactPreviewBody from '@/components/ArtifactPreviewBody.vue'
import type { Artifact } from '@/types/domain'
import { downloadArtifactFile } from '@/utils/feedback'

/**
 * HTML 成果预览对话框。取内容、沙箱与 CSP、防竞态都在 ArtifactPreviewBody；
 * 下载响应本身仍是 `Content-Disposition: attachment` + `nosniff`。
 */
const props = defineProps<{
  open: boolean
  artifact: Artifact | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
}>()

/** 打开或切换成果时由正文组件复位为“渲染预览”。 */
const viewMode = ref<'preview' | 'source'>('preview')

function download() {
  if (props.artifact) void downloadArtifactFile(props.artifact)
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="artifact-preview"
    width="min(880px, calc(100vw - 32px))"
    :show-close="false"
    @update:model-value="(value: boolean) => emit('update:open', value)"
  >
    <!-- 不传 title：aria-labelledby 指向同时含「成果预览」与文件名的头部元素。 -->
    <template #header="{ titleId, titleClass }">
      <div class="artifact-preview__header">
        <div :id="titleId" class="artifact-preview__title">
          <span :class="titleClass">成果预览</span>
          <strong>{{ artifact?.name }}</strong>
        </div>
        <div class="artifact-preview__header-actions">
          <el-radio-group v-model="viewMode" size="small" aria-label="预览方式">
            <el-radio-button value="preview">渲染预览</el-radio-button>
            <el-radio-button value="source">源代码</el-radio-button>
          </el-radio-group>
          <el-button text :icon="Download" data-testid="artifact-preview-download" @click="download">下载</el-button>
          <button
            data-testid="artifact-preview-close"
            class="artifact-preview__close"
            type="button"
            aria-label="关闭成果预览"
            @click="emit('update:open', false)"
          >
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>
    </template>

    <div class="artifact-preview__body" data-testid="artifact-preview-dialog">
      <p class="artifact-preview__hint">
        内容在隔离沙箱中渲染：页面脚本不能访问工作台数据、Cookie 或存储。V{{ artifact?.version }}
      </p>

      <ArtifactPreviewBody v-model:html-view="viewMode" :artifact="artifact" :active="open" />
    </div>
  </el-dialog>
</template>

<style scoped>
.artifact-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.artifact-preview__title {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.artifact-preview__title strong {
  overflow: hidden;
  margin-top: 3px;
  color: #4d534e;
  font-size: var(--dsh-font-size-badge);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-preview__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
}

.artifact-preview__close {
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

.artifact-preview__close:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.artifact-preview__hint {
  margin: 0 0 10px;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}
</style>
