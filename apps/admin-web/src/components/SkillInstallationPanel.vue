<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChatDotRound, Check, Document, FolderOpened, Right, UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile, UploadInstance } from 'element-plus'
import SkillPackagePreview from './SkillPackagePreview.vue'

const props = defineProps<{ target?: { id: string; name: string } }>()
const emit = defineEmits<{ back: []; clearTarget: []; assistant: [] }>()

type Stage = 'source' | 'preview' | 'complete'
const stage = ref<Stage>('source')
const upload = ref<UploadInstance>()
const selectedFile = ref<{ name: string; size: number }>()
const fileError = ref('')
const acknowledged = ref(false)
const stageHeading = ref<HTMLElement>()
const source = computed(() => selectedFile.value?.name ?? '')
const activeStep = computed(() => ({ source: 0, preview: 1, complete: 3 })[stage.value])
watch(() => props.target?.id, reset)

function reset() {
  stage.value = 'source'
  selectedFile.value = undefined
  fileError.value = ''
  acknowledged.value = false
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
  // Frontend review only: keep metadata, never upload or interpret user files.
  selectedFile.value = { name: file.name, size: file.size }
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

function preview() {
  if (!source.value) return
  void changeStage('preview')
}

function useSample() {
  selectedFile.value = { name: 'document-summary.zip', size: 12288 }
  fileError.value = ''
  preview()
}

function confirm() {
  if (stage.value !== 'preview' || !acknowledged.value) return
  void changeStage('complete')
}
</script>

<template>
  <section class="content-panel skill-installation" aria-label="新增 Skill">
    <header class="installation-heading">
      <div><h2 class="panel-title">上传 Skill 包</h2><p class="panel-subtitle">选择本地 ZIP 文件，查看内容与依赖后确认安装。</p></div>
      <el-tag type="info" effect="plain">交互预览</el-tag>
    </header>
    <p class="preview-note"><el-icon><Document /></el-icon>当前仅演示交互：文件不会上传或解析，包信息与安装结果均为示例。</p>

    <div v-if="target" class="target-banner">
      <span>安装目标：<strong>{{ target.name }}</strong> 的新版本</span>
      <el-button link type="primary" @click="emit('clearTarget')">改为新增 Skill</el-button>
    </div>

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
            <el-icon><Document /></el-icon><div><strong>{{ selectedFile.name }}</strong><small>{{ formatSize(selectedFile.size) }} · 已选择，尚未上传或解析</small></div>
            <el-button link type="danger" @click="selectedFile = undefined">移除</el-button>
          </div>
          <div class="source-actions">
            <el-button link type="primary" @click="useSample">使用示例包体验流程</el-button>
            <el-button type="primary" :icon="Right" :disabled="!selectedFile" @click="preview">预览安装流程</el-button>
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
      <header class="preview-heading"><div><h3 ref="stageHeading" tabindex="-1">确认安装内容</h3><p>以下为固定示例内容，并非从所选文件或链接中解析。</p></div><el-tag effect="plain">示例包</el-tag></header>
      <SkillPackagePreview :source="source" :target-name="target?.name" />
      <footer class="preview-footer"><el-checkbox v-model="acknowledged">已确认来源、内容及权限范围</el-checkbox><div><el-button @click="changeStage('source')">返回修改来源</el-button><el-button type="primary" :disabled="!acknowledged" @click="confirm">确认安装（演示）</el-button></div></footer>
    </section>

    <section v-else class="installation-complete" role="status">
      <span class="complete-icon"><el-icon><Check /></el-icon></span><h3 ref="stageHeading" tabindex="-1">安装流程演示完成</h3><p>正式安装后，Skill 会保存为待验证版本。完成试运行并发布后，即可使用。</p><el-tag type="info" effect="plain">本次未创建 Skill 或版本记录</el-tag><div class="complete-actions"><el-button @click="reset">继续体验安装</el-button><el-button type="primary" @click="emit('back')">返回 Skill 中心</el-button></div>
    </section>
  </section>
</template>

<style scoped>
.skill-installation { display: flex; flex-direction: column; gap: var(--spacing-section); padding: var(--spacing-section); }
.installation-heading, .preview-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-card); }
.panel-subtitle { color: var(--color-text-secondary); }
.preview-note { display: flex; align-items: center; gap: calc(var(--spacing-card) / 2); margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.target-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-card); padding: calc(var(--spacing-card) / 2) var(--spacing-card); border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); }
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
@media (max-width: 680px) { .installation-guide ol { grid-template-columns: minmax(0, 1fr); } .installation-heading, .source-actions, .target-banner { align-items: flex-start; flex-direction: column; } .preview-note { align-items: flex-start; } }
.assistant-entry { display: flex; flex-direction: column; align-items: flex-start; gap: calc(var(--spacing-card) / 2); padding: var(--spacing-card) 0; border-top: 1px solid var(--color-border); }
</style>
