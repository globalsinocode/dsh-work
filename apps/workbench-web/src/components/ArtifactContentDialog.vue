<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Close, Download } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import ArtifactTextView from '@/components/ArtifactTextView.vue'
import { useArtifactImage } from '@/composables/useArtifactImage'
import type { Artifact, ArtifactTextPreview } from '@/types/domain'
import { isImageArtifact, isOfficeArtifact } from '@/utils/artifact-preview'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

/**
 * 执行隔离 2b-5：Office/PDF 成果的解析文本预览与图片预览。解析文本只是内容参考，不还原版式；
 * 不在工作台中渲染 Office/PDF 原文件。HTML 成果仍由 ArtifactPreviewDialog 在隔离沙箱中渲染。
 */
const props = defineProps<{
  open: boolean
  /** 成果版本；“我的文件”列表只有 id、版本、名称与类型。 */
  artifact: Pick<Artifact, 'id' | 'version' | 'name' | 'type'> | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
}>()

const mode = computed(() => {
  if (!props.artifact) return null
  if (isImageArtifact(props.artifact.type)) return 'image' as const
  if (isOfficeArtifact(props.artifact.type)) return 'text' as const
  return null
})
const officeType = computed(() => props.artifact && isOfficeArtifact(props.artifact.type) ? props.artifact.type : null)

const preview = ref<ArtifactTextPreview | null>(null)
const loading = ref(false)
const error = ref(false)
let requestSeq = 0

async function loadText() {
  const artifact = props.artifact
  if (!artifact || mode.value !== 'text') return
  const seq = ++requestSeq
  loading.value = true
  error.value = false
  try {
    const result = await workbenchApi.getArtifactText(artifact.id, artifact.version)
    if (seq !== requestSeq) return
    preview.value = result
  } catch (cause) {
    if (seq !== requestSeq) return
    preview.value = null
    error.value = true
    notifyActionFailure('加载成果预览', `成果“${artifact.name}”V${artifact.version}`, cause, '稍后点击「重试」；也可下载后本地打开。')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(
  () => [props.open, props.artifact?.id, props.artifact?.version] as const,
  ([open]) => {
    requestSeq += 1
    preview.value = null
    error.value = false
    loading.value = false
    if (open) void loadText()
  },
  { immediate: true },
)
onBeforeUnmount(() => { requestSeq += 1 })

// 图片只在对话框打开时下载。
const image = useArtifactImage(() => props.open && mode.value === 'image' ? props.artifact : null)

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
      <template v-if="mode === 'text' && officeType">
        <el-skeleton v-if="loading" :rows="6" animated />
        <div v-else-if="error" class="artifact-content__status">
          <p>成果内容加载失败</p>
          <el-button data-testid="artifact-content-retry" @click="loadText()">重试</el-button>
        </div>
        <p v-else-if="preview?.status === 'failed'" class="artifact-content__status">无法生成正文：{{ preview.message }}，请下载查看</p>
        <p v-else-if="preview?.status === 'pending'" class="artifact-content__status">正文暂未生成，请稍后再看或下载查看</p>
        <ArtifactTextView v-else-if="preview?.status === 'available'" :type="officeType" :text="preview.text" layout="stacked" />
      </template>

      <template v-else-if="mode === 'image'">
        <el-skeleton v-if="image.loading.value" :rows="4" animated />
        <div v-else-if="image.error.value" class="artifact-content__status">
          <p>图片加载失败</p>
          <el-button data-testid="artifact-content-retry" @click="image.reload()">重试</el-button>
        </div>
        <img v-else-if="image.url.value" class="artifact-content__image" :src="image.url.value" :alt="artifact?.name ?? '成果图片'">
      </template>
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

.artifact-content__status {
  margin: 0;
  padding: 18px 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.artifact-content__image {
  display: block;
  max-width: 100%;
  max-height: min(64vh, 600px);
  margin: 0 auto;
  border-radius: 8px;
}
</style>
