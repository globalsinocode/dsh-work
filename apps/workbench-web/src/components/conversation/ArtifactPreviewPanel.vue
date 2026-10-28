<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ArtifactPreviewPane from './ArtifactPreviewPane.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import type { Artifact } from '@/types/domain'

/**
 * 对话中点击成果后的预览右栏（EX-ARTIFACT-08）。`docked` 时作为与对话并排的一栏，由宿主留出宽度；
 * 否则（窄屏、项目空间内嵌）覆盖在对话上的抽屉，手机宽度全屏。是否并排由宿主按自身布局判定。
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
/** 抽屉收起动画期间仍显示刚关闭的成果，不闪成空白。 */
const drawerArtifact = ref<Artifact | null>(props.artifact)
watch(() => props.artifact, (artifact) => { if (artifact) drawerArtifact.value = artifact })
</script>

<template>
  <aside
    v-if="docked && artifact"
    class="artifact-panel"
    :aria-label="label"
    @keydown.esc="emit('close')"
  >
    <ArtifactPreviewPane :key="`${artifact.id}@${artifact.version}`" :artifact="artifact" @close="emit('close')" />
  </aside>
  <el-drawer
    v-else-if="!docked"
    :model-value="Boolean(artifact)"
    class="artifact-panel-drawer"
    direction="rtl"
    :size="fullscreen ? '100%' : 'min(520px, 100%)'"
    :with-header="false"
    :aria-label="label"
    @close="emit('close')"
  >
    <ArtifactPreviewPane
      v-if="drawerArtifact"
      :key="`${drawerArtifact.id}@${drawerArtifact.version}`"
      :artifact="drawerArtifact"
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
</style>

<style>
.artifact-panel-drawer .el-drawer__body {
  padding: 0;
}
</style>
