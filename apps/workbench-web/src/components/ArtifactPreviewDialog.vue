<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Close, Download } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { Artifact } from '@/types/domain'
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

/** 把预览 CSP 注入 <head>；没有 <head>/<html> 时前置，解析器会自动归入 head。 */
function withPreviewCsp(markup: string) {
  if (!markup) return markup
  const headMatch = markup.match(/<head[^>]*>/i)
  if (headMatch) return markup.replace(headMatch[0], `${headMatch[0]}${PREVIEW_CSP_TAG}`)
  const htmlMatch = markup.match(/<html[^>]*>/i)
  if (htmlMatch) return markup.replace(htmlMatch[0], `${htmlMatch[0]}<head>${PREVIEW_CSP_TAG}</head>`)
  return `${PREVIEW_CSP_TAG}${markup}`
}
const props = defineProps<{
  open: boolean
  artifact: Artifact | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
}>()

const html = ref('')
/** 交给 iframe srcdoc 的版本：注入 CSP 后的副本；源代码视图仍展示原始内容。 */
const sandboxedHtml = computed(() => withPreviewCsp(html.value))
const loading = ref(false)
const error = ref(false)
const viewMode = ref<'preview' | 'source'>('preview')

/**
 * 请求世代号：切换成果或关闭再打开时，晚到的旧响应不得写进当前预览
 * （与文件版本对话框同一防竞态口径）。
 */
let requestSeq = 0

async function loadContent() {
  const artifact = props.artifact
  if (!artifact) return
  const seq = ++requestSeq
  loading.value = true
  try {
    const blob = await workbenchApi.downloadArtifact(artifact.id, artifact.version)
    const text = await blob.text()
    if (seq !== requestSeq) return
    html.value = text
    error.value = false
  } catch (cause) {
    if (seq !== requestSeq) return
    html.value = ''
    error.value = true
    notifyActionFailure('加载成果预览', `成果“${artifact.name}”V${artifact.version}`, cause, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** 打开/切换/关闭都先作废在途请求并清空上一份内容，避免 A 的页面渲染在 B 的名下。 */
watch(
  () => [props.open, props.artifact?.id, props.artifact?.version] as const,
  ([open]) => {
    requestSeq += 1
    html.value = ''
    error.value = false
    loading.value = false
    viewMode.value = 'preview'
    if (!open) return
    void loadContent()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  requestSeq += 1
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

      <el-skeleton
        v-if="loading && !html"
        data-testid="artifact-preview-skeleton"
        :rows="6"
        animated
      />

      <div v-else-if="error" data-testid="artifact-preview-error" class="artifact-preview__error">
        <p>成果内容加载失败</p>
        <el-button data-testid="artifact-preview-retry" @click="loadContent()">重试</el-button>
      </div>

      <iframe
        v-else-if="viewMode === 'preview'"
        data-testid="artifact-preview-frame"
        class="artifact-preview__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        :srcdoc="sandboxedHtml"
        :title="`成果预览：${artifact?.name ?? ''}`"
      />
      <pre v-else data-testid="artifact-preview-source" class="artifact-preview__source"><code>{{ html }}</code></pre>
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

.artifact-preview__error {
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
  border-radius: 8px;
  background: #fff;
}

.artifact-preview__source {
  overflow: auto;
  max-height: min(62vh, 560px);
  margin: 0;
  padding: 12px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 8px;
  background: #f7f8fa;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
