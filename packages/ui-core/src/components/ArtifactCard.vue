<script setup lang="ts">
import { computed } from 'vue'
import { Download, Document, View } from '@element-plus/icons-vue'

interface ArtifactCardItem {
  name: string
  type: 'xlsx' | 'docx' | 'pptx' | 'pdf' | 'png' | 'jpg' | 'markdown' | 'csv' | 'text' | 'html'
  version: number
  size: string
  createdAt: string
  summary: string
}

// previewable 未传时保持 undefined（不做布尔转换为 false），从而回落到“只有 HTML 提供预览”。
const props = withDefaults(defineProps<{
  artifact: ArtifactCardItem
  /** 来源说明（如项目空间的所属任务、承接 Agent 与发起人）；由宿主拼好后传入。 */
  origin?: string
  /** 是否提供“预览”；未传时只有 HTML 成果提供（宿主处理 preview 事件后再传）。 */
  previewable?: boolean
  /** 不能预览时代替按钮的说明，如解析失败的原因。 */
  previewNote?: string
}>(), { origin: undefined, previewable: undefined, previewNote: undefined })

const emit = defineEmits<{
  download: []
  preview: []
}>()

const typeLabel = computed(() => props.artifact.type.toUpperCase())
const canPreview = computed(() => props.previewable ?? props.artifact.type === 'html')
</script>

<template>
  <article class="artifact-card">
    <div class="artifact-card__icon" :class="`artifact-card__icon--${artifact.type}`">
      <el-icon><Document /></el-icon>
      <small>{{ typeLabel }}</small>
    </div>
    <div class="artifact-card__body">
      <div class="artifact-card__title-row">
        <strong :title="artifact.name">{{ artifact.name }}</strong>
        <span>V{{ artifact.version }}</span>
      </div>
      <p v-if="origin" class="artifact-card__origin" data-testid="artifact-card-origin" :title="origin">{{ origin }}</p>
      <p>{{ artifact.summary }}</p>
      <div class="artifact-card__meta">
        <span>{{ artifact.size }}</span>
        <span>{{ artifact.createdAt }}</span>
      </div>
    </div>
    <div class="artifact-card__actions">
      <el-button
        v-if="canPreview"
        text
        :icon="View"
        data-testid="artifact-preview-open"
        :aria-label="`预览 ${artifact.name}`"
        @click="emit('preview')"
      >预览</el-button>
      <span v-else-if="previewNote" class="artifact-card__preview-note" data-testid="artifact-preview-note">{{ previewNote }}</span>
      <el-button text :icon="Download" @click="emit('download')">下载</el-button>
    </div>
  </article>
</template>

<style scoped>
.artifact-card {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 13px;
  padding: 14px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 10px;
  background: #fff;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

.artifact-card:hover {
  border-color: #cdd7ec;
  box-shadow: 0 5px 18px rgb(30 50 90 / 6%);
}

.artifact-card__icon {
  position: relative;
  display: grid;
  width: 48px;
  height: 50px;
  place-items: center;
  border-radius: 9px;
  color: #315ab7;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.artifact-card__icon small {
  position: absolute;
  right: 4px;
  bottom: 3px;
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
}

.artifact-card__icon--xlsx {
  color: #167757;
  background: #e9f7f1;
}

.artifact-card__icon--pdf {
  color: #b42335;
  background: #fff0f2;
}

.artifact-card__icon--docx {
  color: #2f5ec4;
  background: #edf3ff;
}

.artifact-card__icon--html {
  color: #b4530a;
  background: #fff4e8;
}

.artifact-card__body {
  min-width: 0;
}

.artifact-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.artifact-card__title-row strong {
  overflow: hidden;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-card__title-row span {
  flex: 0 0 auto;
  padding: 2px 5px;
  border-radius: 4px;
  color: #6b7690;
  background: #f0f2f5;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.artifact-card__body p {
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-card__meta {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-badge);
}

.artifact-card__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.artifact-card__preview-note {
  max-width: 180px;
  color: #667085;
  font-size: var(--dsh-font-size-badge);
}

@media (max-width: 640px) {
  .artifact-card {
    grid-template-columns: 42px minmax(0, 1fr);
  }

  .artifact-card__icon {
    width: 42px;
    height: 44px;
  }

  .artifact-card__actions {
    grid-column: 2;
    justify-content: flex-start;
  }
}

/* 来源说明与摘要同样单行省略，悬停显示全文；颜色比摘要深一级以便区分。 */
.artifact-card__body .artifact-card__origin {
  color: var(--dsh-color-text);
}
</style>
