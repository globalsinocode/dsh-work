<script setup lang="ts">
import { computed, ref } from 'vue'
import { Close, Document, Download } from '@element-plus/icons-vue'

import ArtifactPreviewBody from '@/components/ArtifactPreviewBody.vue'
import type { Artifact } from '@/types/domain'
import { isOfficeArtifact } from '@/utils/artifact-preview'
import { downloadArtifactFile } from '@/utils/feedback'

/** 对话右栏的成果预览内容：标题与版本、下载、关闭，正文复用 ArtifactPreviewBody。摆放见 ArtifactPreviewPanel。 */
const props = defineProps<{ artifact: Artifact }>()
const emit = defineEmits<{ close: [] }>()

const htmlView = ref<'preview' | 'source'>('preview')
const meta = computed(() =>
  `V${props.artifact.version} · ${props.artifact.size}${isOfficeArtifact(props.artifact.type) && props.artifact.textPreview === 'available' ? ' · 解析文本' : ''}`)
</script>

<template>
  <div class="artifact-pane" data-testid="artifact-preview-panel">
    <header class="artifact-pane__header">
      <span class="artifact-pane__icon" aria-hidden="true"><el-icon><Document /></el-icon></span>
      <div class="artifact-pane__title">
        <span>成果预览</span>
        <strong :title="artifact.name">{{ artifact.name }}</strong>
        <small>{{ meta }}</small>
      </div>
      <el-button text :icon="Download" data-testid="artifact-panel-download" @click="downloadArtifactFile(artifact)">下载</el-button>
      <button type="button" class="artifact-pane__close" aria-label="关闭成果预览" @click="emit('close')">
        <el-icon><Close /></el-icon>
      </button>
    </header>

    <div v-if="artifact.type === 'html'" class="artifact-pane__toolbar">
      <el-radio-group v-model="htmlView" size="small" aria-label="预览方式">
        <el-radio-button value="preview">渲染预览</el-radio-button>
        <el-radio-button value="source">源代码</el-radio-button>
      </el-radio-group>
      <span>隔离沙箱渲染：页面脚本不能访问工作台数据、Cookie 或存储</span>
    </div>

    <div class="artifact-pane__body">
      <ArtifactPreviewBody v-model:html-view="htmlView" :artifact="artifact" active text-layout="tabs" />
    </div>
  </div>
</template>

<style scoped>
.artifact-pane {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  color: var(--dsh-color-ink);
  background: #fff;
  /* 正文里的 iframe 与图片撑满右栏可用高度。 */
  --artifact-preview-frame-height: calc(100vh - 190px);
  --artifact-preview-image-height: calc(100vh - 160px);
}

.artifact-pane__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid #eceeeb;
}

.artifact-pane__icon {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: #356858;
  background: #eef4f1;
}

.artifact-pane__title {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
}

.artifact-pane__title span,
.artifact-pane__title small {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.artifact-pane__title span {
  font-size: var(--dsh-font-size-micro);
}

.artifact-pane__title strong {
  overflow: hidden;
  font-size: var(--dsh-font-size-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-pane__close {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #7d827d;
  background: transparent;
  cursor: pointer;
}

.artifact-pane__close:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.artifact-pane__toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 8px 16px;
  border-bottom: 1px solid #f0f1ef;
  color: var(--dsh-color-muted);
  background: #fafbfa;
  font-size: var(--dsh-font-size-micro);
}

.artifact-pane__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 14px 16px 24px;
}
</style>
