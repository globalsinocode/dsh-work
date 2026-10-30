<script setup lang="ts">
import { Document, Download, EditPen } from '@element-plus/icons-vue'

import ArtifactImageThumb from './ArtifactImageThumb.vue'
import type { Artifact } from '@/types/domain'
import { isImageArtifact, isOfficeArtifact, unavailableTextNote } from '@/utils/artifact-preview'
import '@/styles/conversation-thread.css'

/**
 * 一次执行登记的成果卡片（预览 / 下载 / 继续修改）。会话页的 RunMessageList 与任务对话共用（D37）；
 * 操作只发事件，写权限、预览右栏与引用由调用方决定。
 */
const props = withDefaults(defineProps<{
  artifacts: Artifact[]
  /** 调用方允许“继续修改”（可续写且属于可引用的这次执行）；卡片另按 artifact.canReference 判定。 */
  canContinueEditing?: boolean
  /** 已在输入区引用的成果文件，对应卡片显示“已引用”。 */
  referencedFileIds?: string[]
  /** 右栏正在预览的成果版本（`id@version`），对应卡片标为选中。 */
  previewKey?: string | null
}>(), { canContinueEditing: false, referencedFileIds: () => [], previewKey: null })

const emit = defineEmits<{
  preview: [artifact: Artifact]
  download: [artifact: Artifact]
  'continue-editing': [artifact: Artifact]
}>()

function isReferenced(artifact: Artifact) {
  return Boolean(artifact.fileId && props.referencedFileIds.includes(artifact.fileId))
}

/** Office/PDF 成果没有可用解析文本时，在卡片旁说明；点开右栏同样说明并提供下载。 */
function bodyUnavailableNote(artifact: Artifact) {
  return isOfficeArtifact(artifact.type) && artifact.textPreview !== 'available' ? unavailableTextNote(artifact) : ''
}

function isPreviewing(artifact: Artifact) {
  return props.previewKey === `${artifact.id}@${artifact.version}`
}
</script>

<template>
  <div
    v-if="artifacts.length"
    class="answer-artifacts"
    data-testid="answer-artifacts"
  >
    <div
      v-for="artifact in artifacts"
      :key="artifact.id"
      class="answer-artifact"
      :data-testid="`answer-artifact-${artifact.id}`"
    >
      <div class="answer-artifact__row">
        <button
          type="button"
          class="answer-artifact__open"
          :class="{ 'is-active': isPreviewing(artifact) }"
          :aria-label="`预览成果 ${artifact.name}`"
          :aria-pressed="isPreviewing(artifact)"
          :data-testid="`preview-artifact-${artifact.id}`"
          @click="emit('preview', artifact)"
        >
          <span><el-icon><Document /></el-icon></span>
          <span>
            <strong>{{ artifact.name }}</strong>
            <small>{{ artifact.size }} · V{{ artifact.version }}</small>
          </span>
          <span class="answer-artifact__state">{{ isPreviewing(artifact) ? '预览中' : '预览' }}</span>
        </button>
        <button
          type="button"
          class="answer-artifact__download"
          :aria-label="`下载成果 ${artifact.name}`"
          @click="emit('download', artifact)"
        >
          <el-icon><Download /></el-icon>
        </button>
        <button
          v-if="canContinueEditing && artifact.canReference && artifact.fileId"
          type="button"
          class="answer-artifact__revise"
          :data-testid="`continue-editing-${artifact.id}`"
          :disabled="isReferenced(artifact)"
          @click="emit('continue-editing', artifact)"
        >
          <el-icon><EditPen /></el-icon>
          {{ isReferenced(artifact) ? '已引用' : '继续修改' }}
        </button>
      </div>
      <p
        v-if="bodyUnavailableNote(artifact)"
        class="answer-artifact__unavailable"
        :data-testid="`artifact-body-unavailable-${artifact.id}`"
      >{{ bodyUnavailableNote(artifact) }}</p>
      <ArtifactImageThumb
        v-if="isImageArtifact(artifact.type)"
        :artifact="artifact"
        :active="isPreviewing(artifact)"
        @open="emit('preview', artifact)"
      />
    </div>
  </div>
</template>
