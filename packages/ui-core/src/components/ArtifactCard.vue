<script setup lang="ts">
import { computed } from 'vue'
import { Download, Document, View } from '@element-plus/icons-vue'

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
}>()

const emit = defineEmits<{
  download: []
  preview: []
}>()

const typeLabel = computed(() => props.artifact.type.toUpperCase())
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
      <p>{{ artifact.summary }}</p>
      <div class="artifact-card__meta">
        <span>{{ artifact.size }}</span>
        <span>{{ artifact.createdAt }}</span>
      </div>
    </div>
    <div class="artifact-card__actions">
      <el-button
        v-if="artifact.type === 'html'"
        text
        :icon="View"
        data-testid="artifact-preview-open"
        @click="emit('preview')"
      >预览</el-button>
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
</style>
