<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ChatDotRound, Check, Document, FolderOpened, Right, UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile, UploadInstance } from 'element-plus'
import { adminApi } from '@/api/client'
import type { SkillInstallation } from '@/types/assistant'
import SkillPackagePreview from './SkillPackagePreview.vue'

const emit = defineEmits<{ back: []; assistant: []; installed: [skillId: string] }>()

type Stage = 'source' | 'preview' | 'complete'
const stage = ref<Stage>('source')
const upload = ref<UploadInstance>()
const selectedFile = ref<File>()
const fileError = ref('')
const acknowledged = ref(false)
const preparing = ref(false)
const confirming = ref(false)
const installation = ref<SkillInstallation>()
const stageHeading = ref<HTMLElement>()
const source = computed(() => selectedFile.value?.name ?? '')
const activeStep = computed(() => ({ source: 0, preview: 1, complete: 3 })[stage.value])
const canConfirm = computed(() => installation.value?.plan?.compatibility.status !== 'incompatible')
const completeTitle = computed(() => installation.value?.resultType === 'duplicate' ? 'Skill 已存在，无需重复安装' : installation.value?.resultType === 'updated' ? 'Skill 新版本已保存' : 'Skill 已安装为草稿')
const completeDescription = computed(() => installation.value?.resultType === 'duplicate'
  ? '平台已找到内容一致的现有版本，本次没有创建重复 Skill 或版本。'
  : '平台已保存确认的 Skill 包和安装计划。请返回 Skill 中心执行严格试运行，确认结果后发布。')
const completeTag = computed(() => installation.value?.resultType === 'duplicate'
  ? `已存在 · v${installation.value.installedVersion ?? ''}`
  : `待验证 · v${installation.value?.installedVersion ?? '0.1.0'}`)

function reset() {
  stage.value = 'source'
  selectedFile.value = undefined
  fileError.value = ''
  acknowledged.value = false
  preparing.value = false
  confirming.value = false
  installation.value = undefined
  upload.value?.clearFiles()
}

function selectFile(file: UploadFile) {
  upload.value?.clearFiles()
  selectedFile.value = undefined
  fileError.value = ''
  if (!file.name.toLowerCase().endsWith('.zip')) {
    fileError.value = '请选择 ZIP 格式的 Skill 包。'
    return
  }
  if (!file.size) {
    fileError.value = '文件为空，请重新选择 Skill 包。'
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    fileError.value = 'Skill 包超过 20 MB 限制。'
    return
  }
  if (!file.raw) {
    fileError.value = '无法读取所选文件，请重新选择。'
    return
  }
  selectedFile.value = file.raw
}

function formatSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function changeStage(value: Stage) {
  stage.value = value
  acknowledged.value = false
  await nextTick()
  stageHeading.value?.focus()
}

async function preview() {
  if (!selectedFile.value || preparing.value) return
  preparing.value = true
  fileError.value = ''
  try {
    installation.value = await adminApi.prepareZipSkillInstallation(selectedFile.value)
    await changeStage('preview')
  } catch (cause) {
    fileError.value = failureMessage(cause, 'Skill 包解析失败')
  } finally {
    preparing.value = false
  }
}

async function confirm() {
  const current = installation.value
  if (stage.value !== 'preview' || !acknowledged.value || !canConfirm.value || !current?.planSha256 || confirming.value) return
  confirming.value = true
  fileError.value = ''
  try {
    installation.value = await adminApi.confirmZipSkillInstallation(current.id, current.planSha256)
    await changeStage('complete')
    if (installation.value.skillId) emit('installed', installation.value.skillId)
  } catch (cause) {
    fileError.value = failureMessage(cause, 'Skill 安装失败')
  } finally {
    confirming.value = false
  }
}

function removeFile() {
  selectedFile.value = undefined
  installation.value = undefined
  fileError.value = ''
  upload.value?.clearFiles()
}

function failureMessage(cause: unknown, fallback: string) {
  const error = cause as Error & { suggestion?: string; traceId?: string }
  const reason = error?.message || fallback
  const suggestion = error?.suggestion ? ` 下一步：${error.suggestion}` : ''
  const trace = error?.traceId && error.traceId !== '—' ? ` 链路编号：${error.traceId}` : ''
  return `${reason}${suggestion}${trace}`
}
</script>

<template>
  <section class="content-panel skill-installation" aria-label="新增 Skill">
    <header class="installation-heading">
      <div><h2 class="panel-title">上传 Skill 包</h2><p class="panel-subtitle">选择本地 ZIP 文件，查看内容与依赖后确认安装。</p></div>
      <el-tag type="info" effect="plain">ZIP 文件</el-tag>
    </header>
    <p class="preview-note"><el-icon><Document /></el-icon>上传后先解析包内容并生成安装计划；确认后保存为待验证草稿，发布前不会被 Agent 使用。</p>

    <el-steps :active="activeStep" finish-status="success" simple class="installation-steps">
      <el-step title="提供来源" /><el-step title="确认内容" /><el-step title="安装结果" />
    </el-steps>

    <div v-if="stage === 'source'" class="installation-layout">
      <section class="source-panel">
        <div class="zip-source">
          <el-upload ref="upload" drag accept=".zip" :auto-upload="false" :show-file-list="false" :on-change="selectFile" aria-label="选择 ZIP 格式的 Skill 包">
            <el-icon class="upload-symbol"><UploadFilled /></el-icon>
            <strong>拖拽 ZIP 文件到这里，或<span>点击选择文件</span></strong>
            <p>选择包含 Skill 说明与资源的压缩包</p>
          </el-upload>
          <p v-if="fileError" class="input-error" role="alert">{{ fileError }}</p>
          <div v-if="selectedFile" class="selected-file" role="status">
            <el-icon><Document /></el-icon><div><strong>{{ selectedFile.name }}</strong><small>{{ formatSize(selectedFile.size) }} · 已选择，等待解析</small></div>
            <el-button link type="danger" :disabled="preparing" @click="removeFile">移除</el-button>
          </div>
          <div class="source-actions">
            <span class="source-limit">单个 ZIP 最大 20 MB</span>
            <el-button type="primary" :icon="Right" :loading="preparing" :disabled="!selectedFile" @click="preview">解析安装包</el-button>
          </div>
        </div>

      </section>

      <aside class="installation-guide">
        <h3>安装前，你会看到什么？</h3>
        <ol><li><strong>能力与来源</strong><p>确认 Skill 的用途、来源及版本。</p></li><li><strong>内容与依赖</strong><p>查看包内文件，以及所需工具和权限。</p></li><li><strong>安装与验证</strong><p>确认后保存待验证版本，验证并发布后才可使用。</p></li></ol>
        <div class="assistant-entry"><strong>有链接或安装命令？</strong><p>交给统一的管理助手，协助安装已有 Skill。</p><el-button :icon="ChatDotRound" plain @click="emit('assistant')">前往管理助手</el-button></div>
        <div class="guide-note"><el-icon><FolderOpened /></el-icon><p>升级通过新包完成，已发布版本与已有引用保留。</p></div>
      </aside>
    </div>

    <section v-else-if="stage === 'preview'" class="installation-preview">
      <header class="preview-heading"><div><h3 ref="stageHeading" tabindex="-1">确认安装内容</h3><p>以下内容由平台从所选 ZIP 中解析，并已完成依赖与运行能力检查。</p></div><el-tag effect="plain">真实安装计划</el-tag></header>
      <p v-if="fileError" class="input-error" role="alert">{{ fileError }}</p>
      <SkillPackagePreview v-if="installation?.package" :source="source" :package="installation.package" :plan="installation.plan" />
      <footer class="preview-footer"><el-checkbox v-model="acknowledged" :disabled="!canConfirm">已确认来源、内容及权限范围</el-checkbox><div><el-button :disabled="confirming" @click="changeStage('source')">返回修改来源</el-button><el-button type="primary" :loading="confirming" :disabled="!acknowledged || !canConfirm" @click="confirm">确认安装</el-button></div></footer>
    </section>

    <section v-else class="installation-complete" role="status">
      <span class="complete-icon"><el-icon><Check /></el-icon></span><h3 ref="stageHeading" tabindex="-1">{{ completeTitle }}</h3><p>{{ completeDescription }}</p><el-tag type="success" effect="plain">{{ completeTag }}</el-tag><div class="complete-actions"><el-button @click="reset">继续安装</el-button><el-button type="primary" @click="emit('back')">返回 Skill 中心</el-button></div>
    </section>
  </section>
</template>

<style scoped>
.skill-installation { display: flex; flex-direction: column; gap: var(--spacing-section); padding: var(--spacing-section); }
.installation-heading, .preview-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-card); }
.panel-subtitle { color: var(--color-text-secondary); }
.preview-note { display: flex; align-items: center; gap: calc(var(--spacing-card) / 2); margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.installation-steps { background: var(--color-bg-page); }
.installation-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(250px, .38fr); gap: calc(var(--spacing-section) * 1.5); }
.source-panel { min-width: 0; }
.zip-source :deep(.el-upload), .zip-source :deep(.el-upload-dragger) { width: 100%; }
.zip-source :deep(.el-upload-dragger) { padding: calc(var(--spacing-section) * 2) var(--spacing-section); background: var(--color-bg-page); }
.upload-symbol { display: block; margin: 0 auto var(--spacing-card); color: var(--color-primary); font-size: calc(var(--font-size-heading) * 2); }
.zip-source strong { font-weight: var(--font-weight-title); }
.zip-source strong span { color: var(--color-primary); }
.zip-source p { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.zip-source .input-error { color: var(--color-danger-strong); }
.installation-preview > .input-error { margin: 0; color: var(--color-danger-strong); }
.source-limit { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.selected-file { display: flex; align-items: center; gap: var(--spacing-card); padding: var(--spacing-card); margin-top: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-button); }
.selected-file > .el-icon { color: var(--color-primary); font-size: var(--font-size-heading); }
.selected-file > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.selected-file small { display: block; color: var(--color-text-secondary); margin-top: calc(var(--spacing-card) / 4); }
.source-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-card); margin-top: var(--spacing-section); }
.installation-guide { padding-left: var(--spacing-section); border-left: 1px solid var(--color-border); }
h3, h4 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); font-weight: var(--font-weight-title); }
.installation-guide ol { display: flex; flex-direction: column; gap: var(--spacing-section); padding-left: var(--spacing-section); margin: var(--spacing-section) 0; }
.installation-guide li::marker { color: var(--color-primary); }
.installation-guide p { margin: calc(var(--spacing-card) / 4) 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.7; }
.guide-note { display: flex; gap: calc(var(--spacing-card) / 2); padding: var(--spacing-card); border-radius: var(--radius-button); background: var(--color-bg-page); }
.guide-note .el-icon { color: var(--color-text-secondary); margin-top: calc(var(--spacing-card) / 4); }
.guide-note p { margin: 0; }
.installation-preview { display: flex; flex-direction: column; gap: var(--spacing-section); }
.preview-heading p { margin: calc(var(--spacing-card) / 4) 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.preview-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--spacing-card); padding-top: var(--spacing-card); border-top: 1px solid var(--color-border); }
.installation-complete { display: flex; align-items: center; flex-direction: column; gap: var(--spacing-card); padding: calc(var(--spacing-section) * 2); text-align: center; }
.complete-icon { display: grid; place-items: center; width: calc(var(--spacing-section) * 3); height: calc(var(--spacing-section) * 3); border-radius: 50%; color: var(--color-success-strong); background: var(--color-success-light); font-size: var(--font-size-metric); }
.installation-complete p { margin: 0; color: var(--color-text-secondary); }
.complete-actions { margin-top: var(--spacing-card); }
@media (max-width: 1180px) { .installation-layout { grid-template-columns: minmax(0, 1fr); } .installation-guide { padding: var(--spacing-card); border: 0; background: var(--color-bg-page); border-radius: var(--radius-card); } .installation-guide ol { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); } .guide-note { padding: 0; } }
@media (max-width: 680px) { .installation-guide ol { grid-template-columns: minmax(0, 1fr); } .installation-heading, .source-actions { align-items: flex-start; flex-direction: column; } .preview-note { align-items: flex-start; } }
.assistant-entry { display: flex; flex-direction: column; align-items: flex-start; gap: calc(var(--spacing-card) / 2); padding: var(--spacing-card) 0; border-top: 1px solid var(--color-border); }
</style>
