<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useUiModeStore } from '@/stores/ui-mode'
import { notifyActionFailure } from '@/utils/feedback'

/** 协作模式页面占位：后续切片替换为真实的对话 / 群组 / AI 同事页。 */
const route = useRoute()
const uiMode = useUiModeStore()
const title = computed(() => String(route.meta.title ?? ''))

async function switchToWork() {
  try {
    await uiMode.setMode('work')
  } catch (cause) {
    notifyActionFailure('切换模式', '工作模式', cause)
  }
}
</script>

<template>
  <div class="page-container collab-placeholder">
    <header class="page-header">
      <h1 class="page-title">{{ title }}</h1>
    </header>
    <el-empty :description="`协作模式的${title}页即将上线，可先在工作模式中使用对应功能。`">
      <el-button type="primary" :loading="uiMode.switching" @click="switchToWork">切换到工作模式</el-button>
    </el-empty>
  </div>
</template>
