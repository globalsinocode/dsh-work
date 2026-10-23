<script setup lang="ts">
import { computed } from 'vue'

/**
 * 协作模式头像（原型：AI 同事为浅蓝底机器人图标；群组为最多 4 位成员的圆形拼图）。
 * 目录行、详情与对话列表共用，尺寸由 `size` 决定。
 */
const props = withDefaults(defineProps<{
  kind: 'agent' | 'group'
  /** 群组：参与拼图的成员名称（取前 4 位）。 */
  names?: string[]
  size?: number
}>(), { names: () => [], size: 44 })

const palette = ['var(--dsh-color-success)', 'var(--dsh-color-brand)', 'var(--dsh-color-warning)', 'var(--dsh-color-info)', 'var(--dsh-color-brand-dark)']

/** 同一名称总是同一颜色。 */
function colorOf(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return palette[hash % palette.length]!
}

const pieces = computed(() => props.names.slice(0, 4).map(name => ({ char: name.slice(0, 1), color: colorOf(name) })))
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <span v-if="kind === 'agent'" class="collab-avatar collab-avatar--agent" :style="style" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9.5 13h.01M14.5 13h.01" />
    </svg>
  </span>
  <span v-else class="collab-avatar collab-avatar--group" :class="{ 'collab-avatar--large': size >= 64 }" :style="style" aria-hidden="true">
    <span v-for="(piece, index) in pieces" :key="index" class="collab-avatar__piece" :style="{ background: piece.color }">{{ piece.char }}</span>
  </span>
</template>

<style scoped>
.collab-avatar { display: inline-flex; flex: 0 0 auto; box-sizing: border-box; align-items: center; justify-content: center; border-radius: 50%; }
.collab-avatar--agent { color: var(--dsh-color-brand); background: var(--dsh-color-brand-soft); }
.collab-avatar--agent svg { width: 50%; height: 50%; }
.collab-avatar--group {
  display: inline-grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 2px; padding: 5px; background: #eef1f5;
}
.collab-avatar--large { gap: 4px; padding: 10px; }
.collab-avatar__piece {
  display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; align-items: center; justify-content: center;
  border-radius: 50%; color: #fff; font-size: 10px; font-weight: 600; line-height: 1;
}
.collab-avatar--large .collab-avatar__piece { font-size: var(--dsh-font-size-title); }
</style>
