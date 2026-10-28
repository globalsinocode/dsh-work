<script setup lang="ts">
import { computed, ref } from 'vue'
import { Close, Download, FullScreen, ScaleToOriginal } from '@element-plus/icons-vue'

import ArtifactPreviewBody from '@/components/ArtifactPreviewBody.vue'
import type { Artifact } from '@/types/domain'
import { isOfficeArtifact } from '@/utils/artifact-preview'
import { downloadArtifactFile } from '@/utils/feedback'

/** 对话右栏的成果预览内容：一行标题栏（文件名与版本、HTML 预览方式、下载、全屏、关闭），正文复用 ArtifactPreviewBody。摆放见 ArtifactPreviewPanel。 */
const props = withDefaults(defineProps<{
  artifact: Artifact
  /** 是否提供全屏展开；已经全屏的手机宽度不提供。 */
  canExpand?: boolean
  expanded?: boolean
}>(), { canExpand: false, expanded: false })
const emit = defineEmits<{ close: []; 'toggle-expand': [] }>()

const htmlView = ref<'preview' | 'source'>('preview')
const meta = computed(() =>
  `V${props.artifact.version} · ${props.artifact.size}${isOfficeArtifact(props.artifact.type) && props.artifact.textPreview === 'available' ? ' · 解析文本' : ''}`)
</script>

<template>
  <div class="artifact-pane" :class="{ 'artifact-pane--expanded': expanded }" data-testid="artifact-preview-panel">
    <!-- 顶部只占一行，给正文留出尽量多的高度；可访问名称“成果预览：文件名”在外层右栏或抽屉上。 -->
    <header class="artifact-pane__header">
      <div class="artifact-pane__title">
        <strong :title="artifact.name">{{ artifact.name }}</strong>
        <small>{{ meta }}</small>
      </div>
      <el-radio-group v-if="artifact.type === 'html'" v-model="htmlView" size="small" aria-label="预览方式">
        <el-radio-button value="preview">渲染预览</el-radio-button>
        <el-radio-button value="source">源代码</el-radio-button>
      </el-radio-group>
      <button
        type="button"
        class="artifact-pane__action"
        aria-label="下载"
        title="下载"
        data-testid="artifact-panel-download"
        @click="downloadArtifactFile(artifact)"
      >
        <el-icon><Download /></el-icon>
      </button>
      <button
        v-if="canExpand"
        type="button"
        class="artifact-pane__action"
        :aria-label="expanded ? '退出全屏' : '全屏查看'"
        :title="expanded ? '退出全屏' : '全屏查看'"
        @click="emit('toggle-expand')"
      >
        <el-icon><component :is="expanded ? ScaleToOriginal : FullScreen" /></el-icon>
      </button>
      <button type="button" class="artifact-pane__action" aria-label="关闭成果预览" title="关闭" @click="emit('close')">
        <el-icon><Close /></el-icon>
      </button>
    </header>

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
  /* 正文里的 iframe 与图片撑满右栏可用高度（减去一行标题栏与正文内边距）。 */
  --artifact-preview-frame-height: calc(100vh - 72px);
  --artifact-preview-image-height: calc(100vh - 72px);
}

.artifact-pane__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 4px 8px 4px 16px;
  border-bottom: 1px solid #eceeeb;
}

.artifact-pane__title {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: baseline;
  gap: 8px;
  margin-right: 4px;
}

.artifact-pane__title strong {
  overflow: hidden;
  font-size: var(--dsh-font-size-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-pane__title small {
  flex: 0 0 auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
  white-space: nowrap;
}

.artifact-pane__action {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #5f655f;
  background: transparent;
  cursor: pointer;
}

.artifact-pane__action:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.artifact-pane__body {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 10px 16px 16px;
}

/* 全屏时正文最宽 1200px 并居中，滚动条仍在窗口边缘。 */
.artifact-pane--expanded .artifact-pane__body {
  padding-inline: max(16px, calc((100% - 1200px) / 2));
}
</style>
