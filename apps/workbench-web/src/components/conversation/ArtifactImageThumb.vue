<script setup lang="ts">
import { useArtifactImage } from '@/composables/useArtifactImage'
import type { Artifact } from '@/types/domain'

/** 执行隔离 2b-5：图片成果在回复下直接显示缩略图，点击放大；加载失败时说明并保留下载入口。 */
const props = defineProps<{ artifact: Artifact }>()
const emit = defineEmits<{ open: [] }>()

const { url, loading, error } = useArtifactImage(() => props.artifact)
</script>

<template>
  <button
    v-if="url"
    type="button"
    class="artifact-thumb"
    :aria-label="`放大查看 ${artifact.name}`"
    :data-testid="`artifact-thumb-${artifact.id}`"
    @click="emit('open')"
  >
    <img :src="url" :alt="artifact.name">
  </button>
  <p v-else-if="loading" class="artifact-thumb__status">正在加载图片…</p>
  <p v-else-if="error" class="artifact-thumb__status">图片加载失败，可下载后查看</p>
</template>

<style scoped>
.artifact-thumb {
  display: block;
  width: fit-content;
  max-width: min(100%, 320px);
  padding: 0;
  overflow: hidden;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  background: #ffffff;
  cursor: zoom-in;
}

.artifact-thumb img {
  display: block;
  max-width: 100%;
  max-height: 200px;
}

.artifact-thumb__status {
  margin: 0;
  color: #6b716b;
  font-size: var(--dsh-font-size-badge);
}
</style>
