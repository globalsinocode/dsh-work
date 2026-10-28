<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ArtifactPreviewPane from './ArtifactPreviewPane.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import type { Artifact } from '@/types/domain'

/**
 * 对话中点击成果后的预览右栏（EX-ARTIFACT-08）。`docked` 时作为与对话并排的一栏，由宿主留出宽度；
 * 否则（窄屏、项目空间内嵌）覆盖在对话上的抽屉，手机宽度全屏。是否并排由宿主按自身布局判定。
 * 右栏与抽屉都可全屏展开，Esc 先退出全屏；关闭预览后复原。
 */
const props = withDefaults(defineProps<{
  artifact: Artifact | null
  docked: boolean
  /** 不超过此宽度时抽屉全屏；跟随宿主页面已有的手机断点。 */
  fullscreenMaxWidth?: number
}>(), { fullscreenMaxWidth: 720 })
const emit = defineEmits<{ close: [] }>()

const fullscreen = useMediaQuery(`(max-width: ${props.fullscreenMaxWidth}px)`)
const label = computed(() => props.artifact ? `成果预览：${props.artifact.name}` : '成果预览')
const expanded = ref(false)
/** 抽屉收起动画期间仍显示刚关闭的成果，不闪成空白。 */
const drawerArtifact = ref<Artifact | null>(props.artifact)
watch(() => props.artifact, (artifact) => {
  if (artifact) drawerArtifact.value = artifact
  else expanded.value = false
})

function onEscape() {
  if (expanded.value) expanded.value = false
  else emit('close')
}
</script>

<template>
  <aside
    v-if="docked && artifact"
    class="artifact-panel"
    :class="{ 'artifact-panel--expanded': expanded }"
    :aria-label="label"
    @keydown.esc="onEscape"
  >
    <ArtifactPreviewPane
      :key="`${artifact.id}@${artifact.version}`"
      :artifact="artifact"
      can-expand
      :expanded="expanded"
      @toggle-expand="expanded = !expanded"
      @close="emit('close')"
    />
  </aside>
  <el-drawer
    v-else-if="!docked"
    :model-value="Boolean(artifact)"
    class="artifact-panel-drawer"
    direction="rtl"
    :size="fullscreen || expanded ? '100%' : 'min(520px, 100%)'"
    :with-header="false"
    :close-on-press-escape="!expanded"
    :aria-label="label"
    @keydown.esc="expanded = false"
    @close="emit('close')"
  >
    <ArtifactPreviewPane
      v-if="drawerArtifact"
      :key="`${drawerArtifact.id}@${drawerArtifact.version}`"
      :artifact="drawerArtifact"
      :can-expand="!fullscreen"
      :expanded="expanded"
      @toggle-expand="expanded = !expanded"
      @close="emit('close')"
    />
  </el-drawer>
</template>

<style scoped>
.artifact-panel {
  height: 100%;
  min-height: 0;
  border-left: 1px solid var(--dsh-color-border);
  background: #fff;
}

/* 全屏展开：盖住整个窗口。宿主按自己的布局给右栏定位与宽度（同等优先级、后加载），这里必须压过。 */
.artifact-panel.artifact-panel--expanded {
  position: fixed !important;
  z-index: 2000 !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  border-left: 0;
}
</style>

<style>
.artifact-panel-drawer .el-drawer__body {
  padding: 0;
}
</style>
