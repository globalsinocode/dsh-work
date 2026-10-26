<script setup lang="ts">
import { computed } from 'vue'
import { Download, Document } from '@element-plus/icons-vue'

interface ArtifactCardItem {
  name: string
  type: 'xlsx' | 'docx' | 'pdf' | 'markdown' | 'csv' | 'text' | 'html'
  version: number
  size: string
  createdAt: string
  summary: string
}

const props = defineProps<{
  artifact: ArtifactCardItem
  /** 来源说明（如项目空间的所属任务、承接 Agent 与发起人）；由宿主拼好后传入。 */
  origin?: string
}>()

const emit = defineEmits<{
  download: []
  preview: []
}>()

/** 图标角标：短缩写，避免 MARKDOWN 等长文案溢出 48px 图标区。 */
const ARTIFACT_TYPE_ABBREV: Record<ArtifactCardItem['type'], string> = {
  markdown: 'MD',
  xlsx: 'XLS',
  docx: 'DOC',
  pdf: 'PDF',
  csv: 'CSV',
  text: 'TXT',
  html: 'HTML',
}

const typeLabel = computed(() => ARTIFACT_TYPE_ABBREV[props.artifact.type])
</script>

<template>
  <article class="artifact-card">
    <div class="artifact-card__icon" :class="`artifact-card__icon--${artifact.type}`">
      <el-icon class="artifact-card__icon-graphic" aria-hidden="true"><Document /></el-icon>
      <span class="artifact-card__type">{{ typeLabel }}</span>
    </div>
    <button
      type="button"
      class="artifact-card__body"
      data-testid="artifact-card-open"
      :aria-label="artifact.name"
      @click="emit('preview')"
    >
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
    </button>
    <div class="artifact-card__actions">
      <el-button
        text
        :icon="Download"
        data-testid="artifact-card-download"
        @click.stop="emit('download')"
      >下载</el-button>
    </div>
  </article>
</template>

<style scoped>
.artifact-card {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
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
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  box-sizing: border-box;
  width: 52px;
  height: 52px;
  padding: 7px 4px 6px;
  border-radius: 9px;
  color: #315ab7;
  background: #edf3ff;
}

.artifact-card__icon-graphic {
  font-size: var(--dsh-font-size-header);
  line-height: 1;
}

.artifact-card__type {
  display: block;
  min-width: 26px;
  max-width: 100%;
  padding: 1px 4px;
  border-radius: 4px;
  color: inherit;
  background: rgb(255 255 255 / 58%);
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  line-height: 1.15;
  letter-spacing: 0.03em;
  text-align: center;
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
  padding: 0;
  border: none;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.artifact-card__body:hover {
  background: rgb(237 243 255 / 45%);
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
}

@media (max-width: 640px) {
  .artifact-card {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .artifact-card__icon {
    width: 48px;
    height: 48px;
    padding: 6px 3px 5px;
  }

  .artifact-card__icon-graphic {
    font-size: var(--dsh-font-size-section);
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
