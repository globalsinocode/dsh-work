<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AssistantMessageContent } from '@dsh-work/ui-core'

import { workbenchApi } from '@/api/client'
import ArtifactTextView from '@/components/ArtifactTextView.vue'
import { useArtifactImage } from '@/composables/useArtifactImage'
import type { Artifact, ArtifactTextPreview } from '@/types/domain'
import { artifactBodyKind, isOfficeArtifact } from '@/utils/artifact-preview'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 成果预览的正文，供 HTML 预览对话框、成果预览对话框与对话右栏共用：
 * - HTML：鉴权下载取回后交给 `sandbox="allow-scripts"` 的 iframe。沙箱不给 `allow-same-origin`，
 *   渲染文档处于 opaque origin——内联脚本可以执行（交互式看板/图表需要），但无法访问工作台 DOM、
 *   Cookie、Storage，也不能顶层跳转或弹窗。再注入 `<meta>` CSP（srcdoc 文档拿不到 HTTP 头）：
 *   只允许内联脚本/样式与 data: 图片，`connect-src` 随 `default-src 'none'` 关闭，脚本无法外发数据。
 * - Office/PDF：只显示解析文本（执行隔离 2b-5），不在工作台中渲染原文件。
 * - Markdown/文本/CSV：读该版本原文；图片：鉴权下载后以本地 object URL 显示。
 *
 * `active` 为假时不发请求；切换成果、关闭或卸载都作废在途请求，晚到的旧响应不写进当前预览。
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

const props = withDefaults(defineProps<{
  artifact: Pick<Artifact, 'id' | 'version' | 'name' | 'type'> | null
  active: boolean
  /** 解析文本中表格的排法：对话框依次列出全部工作表，右栏用标签切换。 */
  textLayout?: 'tabs' | 'stacked'
}>(), { textLayout: 'stacked' })

/** HTML 成果看渲染结果还是源代码；切换器由宿主放在标题栏或工具栏。 */
const htmlView = defineModel<'preview' | 'source'>('htmlView', { default: 'preview' })

const kind = computed(() => props.artifact ? artifactBodyKind(props.artifact.type) : null)
const officeType = computed(() => props.artifact && isOfficeArtifact(props.artifact.type) ? props.artifact.type : null)

/** html/raw 的原文与 Office/PDF 的解析结果；图片由 useArtifactImage 管。 */
const content = ref('')
const textPreview = ref<ArtifactTextPreview | null>(null)
const loading = ref(false)
const error = ref(false)
let requestSeq = 0

const sandboxedHtml = computed(() => withPreviewCsp(content.value))

async function load() {
  const artifact = props.artifact
  if (!artifact || !props.active || kind.value === 'image') return
  const seq = ++requestSeq
  loading.value = true
  error.value = false
  try {
    if (kind.value === 'text') {
      const result = await workbenchApi.getArtifactText(artifact.id, artifact.version)
      if (seq !== requestSeq) return
      textPreview.value = result
    } else {
      const text = await (await workbenchApi.downloadArtifact(artifact.id, artifact.version)).text()
      if (seq !== requestSeq) return
      content.value = text
    }
  } catch (cause) {
    if (seq !== requestSeq) return
    content.value = ''
    textPreview.value = null
    error.value = true
    notifyActionFailure('加载成果预览', `成果“${artifact.name}”V${artifact.version}`, cause, '稍后点击「重试」；也可下载后本地打开。')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** 打开/切换/关闭都先作废在途请求并清空上一份内容，避免 A 的内容显示在 B 的名下。 */
watch(
  () => [props.active, props.artifact?.id, props.artifact?.version] as const,
  ([active]) => {
    requestSeq += 1
    content.value = ''
    textPreview.value = null
    error.value = false
    loading.value = false
    htmlView.value = 'preview'
    if (active) void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => { requestSeq += 1 })

const image = useArtifactImage(() => props.active && kind.value === 'image' ? props.artifact : null)

function retry() {
  if (kind.value === 'image') void image.reload()
  else void load()
}

const showLoading = computed(() => kind.value === 'image' ? image.loading.value : loading.value)
const showError = computed(() => kind.value === 'image' ? image.error.value : error.value)
</script>

<template>
  <div class="artifact-preview-body">
    <el-skeleton
      v-if="showLoading"
      data-testid="artifact-preview-skeleton"
      :rows="6"
      animated
    />

    <div v-else-if="showError" data-testid="artifact-preview-error" class="artifact-preview-body__status" role="alert">
      <p>成果内容加载失败</p>
      <el-button data-testid="artifact-preview-retry" @click="retry">重试</el-button>
    </div>

    <template v-else-if="kind === 'html' && content">
      <iframe
        v-if="htmlView === 'preview'"
        data-testid="artifact-preview-frame"
        class="artifact-preview-body__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        :srcdoc="sandboxedHtml"
        :title="`成果预览：${artifact?.name ?? ''}`"
      />
      <pre v-else data-testid="artifact-preview-source" class="artifact-preview-body__source"><code>{{ content }}</code></pre>
    </template>

    <template v-else-if="kind === 'text' && officeType && textPreview">
      <p v-if="textPreview.status === 'failed'" class="artifact-preview-body__status">无法生成正文：{{ textPreview.message }}，请下载查看</p>
      <p v-else-if="textPreview.status === 'pending'" class="artifact-preview-body__status">正文暂未生成，请稍后再看或下载查看</p>
      <ArtifactTextView v-else :type="officeType" :text="textPreview.text" :layout="textLayout" />
    </template>

    <template v-else-if="kind === 'raw' && active">
      <p v-if="!content.trim()" class="artifact-preview-body__status" data-testid="artifact-preview-empty">这个文件没有可显示的内容，可下载原文件核对</p>
      <pre v-else-if="artifact?.type === 'csv'" class="artifact-preview-body__plain">{{ content }}</pre>
      <AssistantMessageContent v-else :text="content" />
    </template>

    <img
      v-else-if="kind === 'image' && image.url.value"
      class="artifact-preview-body__image"
      :src="image.url.value"
      :alt="artifact?.name ?? '成果图片'"
    >
  </div>
</template>

<style scoped>
.artifact-preview-body__status {
  margin: 0;
  padding: 18px 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.artifact-preview-body__status p {
  margin: 0 0 10px;
}

.artifact-preview-body__frame {
  display: block;
  width: 100%;
  height: var(--artifact-preview-frame-height, min(62vh, 560px));
  border: 1px solid var(--dsh-color-border);
  border-radius: 8px;
  background: #fff;
}

.artifact-preview-body__source,
.artifact-preview-body__plain {
  overflow: auto;
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

.artifact-preview-body__source {
  max-height: var(--artifact-preview-frame-height, min(62vh, 560px));
}

.artifact-preview-body__image {
  display: block;
  max-width: 100%;
  max-height: var(--artifact-preview-image-height, min(64vh, 600px));
  margin: 0 auto;
  border-radius: 8px;
}
</style>
