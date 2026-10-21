<script setup lang="ts">
import { computed } from 'vue'

import { renderMarkdownPreview } from '../markdown/render-markdown'

const props = defineProps<{ text: string }>()
const html = computed(() => renderMarkdownPreview(props.text))
</script>

<template>
  <div class="dsh-markdown-content assistant-message-content" v-html="html" />
</template>

<style>
@import '../markdown/markdown-content.css';
</style>
