<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Close, Download } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { Artifact } from '@/types/domain'
import { parseCsvPreview, renderMarkdownPreview } from '@/utils/artifact-preview'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

/**
 * HTML 成果预览。内容由鉴权下载接口取回后交给
 * `sandbox="allow-scripts"` 的 iframe：沙箱不给 `allow-same-origin`，
 * 渲染文档处于 opaque origin——内联脚本可以执行（交互式看板/图表需要），
 * 但无法访问工作台 DOM、Cookie、Storage，也不能顶层跳转或弹窗。
 * 在此之上再注入 `<meta>` CSP（srcdoc 文档拿不到 HTTP 头）：只允许内联
 * 脚本/样式与 data: 图片，`connect-src` 随 `default-src 'none'` 关闭，
 * 脚本无法 fetch/XHR/beacon 外发数据。下载响应本身仍是
 * `Content-Disposition: attachment` + `nosniff`。
 */
const PREVIEW_CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`

function withPreviewCsp(markup: string) {
  if (!markup) return markup
  const headMatch = markup.match(/<head[^>]*>/i)
  if (headMatch) return markup.replace(headMatch[0], `${headMatch[0]}${PREVIEW_CSP_TAG}`)
  const htmlMatch = markup.match(/<html[^>]*>/i)
  if (htmlMatch) return markup.replace(htmlMatch[0], `${htmlMatch[0]}<head>${PREVIEW_CSP_TAG}</head>`)
  return `${PREVIEW_CSP_TAG}${markup}`
}

function isOfficeUnsupported(type: Artifact['type'] | undefined) {
  return type === 'xlsx' || type === 'docx'
}

const props = defineProps<{
  open: boolean
  artifact: Artifact | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
}>()

const rawText = ref('')
const pdfObjectUrl = ref('')
const sandboxedHtml = computed(() => withPreviewCsp(rawText.value))
const loading = ref(false)
const error = ref(false)
const viewMode = ref<'preview' | 'source'>('preview')

const artifactType = computed(() => props.artifact?.type)
const csvPreview = computed(() => (artifactType.value === 'csv' ? parseCsvPreview(rawText.value) : null))
const markdownHtml = computed(() => (artifactType.value === 'markdown' ? renderMarkdownPreview(rawText.value) : ''))

let requestSeq = 0

function revokePdfUrl() {
  if (!pdfObjectUrl.value) return
  URL.revokeObjectURL(pdfObjectUrl.value)
  pdfObjectUrl.value = ''
}

async function loadContent() {
  const artifact = props.artifact
  if (!artifact || isOfficeUnsupported(artifact.type)) return
  const seq = ++requestSeq
  loading.value = true
  try {
    const blob = await workbenchApi.downloadArtifact(artifact.id, artifact.version)
    if (seq !== requestSeq) return
    if (artifact.type === 'pdf') {
      revokePdfUrl()
      pdfObjectUrl.value = URL.createObjectURL(blob)
      rawText.value = ''
    } else {
      rawText.value = await blob.text()
    }
    error.value = false
  } catch (cause) {
    if (seq !== requestSeq) return
    rawText.value = ''
    revokePdfUrl()
    error.value = true
    notifyActionFailure('加载成果预览', `成果“${artifact.name}”V${artifact.version}`, cause, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function resetPreviewState() {
  requestSeq += 1
  rawText.value = ''
  revokePdfUrl()
  error.value = false
  loading.value = false
  viewMode.value = 'preview'
}

watch(
  () => [props.open, props.artifact?.id, props.artifact?.version, props.artifact?.type] as const,
  ([open]) => {
    resetPreviewState()
    if (!open || !props.artifact) return
    if (isOfficeUnsupported(props.artifact.type)) return
    void loadContent()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  requestSeq += 1
  revokePdfUrl()
})

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
    <template #header="{ titleId, titleClass }">
      <div class="artifact-preview__header">
        <div :id="titleId" class="artifact-preview__title">
          <span :class="titleClass">成果预览</span>
          <strong>{{ artifact?.name }}</strong>
        </div>
        <div class="artifact-preview__header-actions">
          <el-radio-group
            v-if="artifactType === 'html'"
            v-model="viewMode"
            size="small"
            aria-label="预览方式"
          >
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
      <p v-if="artifactType === 'html'" class="artifact-preview__hint">
        内容在隔离沙箱中渲染：页面脚本不能访问工作台数据、Cookie 或存储。V{{ artifact?.version }}
      </p>
      <p v-else class="artifact-preview__hint">V{{ artifact?.version }}</p>

      <el-skeleton
        v-if="loading"
        data-testid="artifact-preview-skeleton"
        :rows="6"
        animated
      />

      <div v-else-if="error" data-testid="artifact-preview-error" class="artifact-preview__error">
        <p>成果内容加载失败</p>
        <el-button data-testid="artifact-preview-retry" @click="loadContent()">重试</el-button>
      </div>

      <p
        v-else-if="isOfficeUnsupported(artifactType)"
        data-testid="artifact-preview-unsupported"
        class="artifact-preview__unsupported"
      >
        暂不支持在线预览
      </p>

      <iframe
        v-else-if="artifactType === 'html' && viewMode === 'preview'"
        data-testid="artifact-preview-frame"
        class="artifact-preview__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        :srcdoc="sandboxedHtml"
        :title="`成果预览：${artifact?.name ?? ''}`"
      />
      <pre
        v-else-if="artifactType === 'html' && viewMode === 'source'"
        data-testid="artifact-preview-source"
        class="artifact-preview__source"
      ><code>{{ rawText }}</code></pre>

      <div
        v-else-if="artifactType === 'markdown'"
        data-testid="artifact-preview-markdown"
        class="dsh-markdown-content artifact-preview__markdown"
        v-html="markdownHtml"
      />

      <template v-else-if="artifactType === 'csv' && csvPreview">
        <p v-if="csvPreview.truncated" data-testid="artifact-preview-csv-notice" class="artifact-preview__notice">
          仅显示前 500 行，完整内容请下载
        </p>
        <div class="artifact-preview__csv-wrap">
          <table data-testid="artifact-preview-csv" class="artifact-preview__csv">
            <thead>
              <tr>
                <th v-for="(header, index) in csvPreview.headers" :key="`h-${index}`">{{ header }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in csvPreview.rows" :key="`r-${rowIndex}`">
                <td v-for="(cell, cellIndex) in row" :key="`c-${rowIndex}-${cellIndex}`">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <pre
        v-else-if="artifactType === 'text'"
        data-testid="artifact-preview-text"
        class="artifact-preview__source"
      >{{ rawText }}</pre>

      <iframe
        v-else-if="artifactType === 'pdf' && pdfObjectUrl"
        data-testid="artifact-preview-pdf"
        class="artifact-preview__frame"
        referrerpolicy="no-referrer"
        :src="pdfObjectUrl"
        :title="`成果预览：${artifact?.name ?? ''}`"
      />
    </div>
  </el-dialog>
</template>

<style>
@import '@dsh-work/ui-core/markdown-content.css';
</style>

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
  margin: 0 0 12px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.artifact-preview__notice {
  margin: 0 0 10px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.artifact-preview__error,
.artifact-preview__unsupported {
  padding: 18px 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.artifact-preview__frame {
  display: block;
  width: 100%;
  height: min(62vh, 560px);
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md, 12px);
  background: var(--dsh-color-panel, #fff);
}

.artifact-preview__source {
  overflow: auto;
  max-height: min(62vh, 560px);
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md, 12px);
  color: var(--dsh-color-text);
  background: var(--dsh-color-canvas);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--dsh-font-size-caption, 13px);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-preview__markdown {
  overflow: auto;
  max-height: min(62vh, 560px);
  padding: 16px 18px;
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md, 12px);
  background: var(--dsh-color-panel, #fff);
}

.artifact-preview__csv-wrap {
  overflow: auto;
  max-height: min(62vh, 560px);
  border: 1px solid var(--dsh-color-border);
  border-radius: var(--dsh-radius-md, 12px);
  background: var(--dsh-color-panel, #fff);
}

.artifact-preview__csv {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95em;
}

.artifact-preview__csv th,
.artifact-preview__csv td {
  padding: 8px 10px;
  border: 1px solid var(--dsh-color-border);
  text-align: left;
  vertical-align: top;
}

.artifact-preview__csv th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsh-color-canvas);
  color: var(--dsh-color-ink);
  font-weight: 650;
  white-space: nowrap;
}

.artifact-preview__csv td {
  color: var(--dsh-color-text);
  white-space: nowrap;
}
</style>
