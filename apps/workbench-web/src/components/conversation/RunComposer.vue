<script setup lang="ts">
import { TaskComposer } from '@dsh-work/workbench-components'

import type { ReferencedArtifact } from '@/composables/useRunActions'
import '@/styles/conversation-thread.css'

/**
 * 续写一次执行的输入区（S5b 从 ConversationView 拆出）：引用成果标签 + 输入框（执行中可停止）。
 * 提示文案由调用方放在 `notices` 插槽，位于引用标签与输入框之间。
 */
withDefaults(defineProps<{
  referencedArtifacts?: ReferencedArtifact[]
  running?: boolean
  stopping?: boolean
  mentionOptions?: Array<{ id: string; name: string; kind?: 'agent' | 'member' }>
  filesRequireMention?: boolean
  showWorkspaceContext?: boolean
  placeholder?: string
  /** 输入框初始内容（推荐卡片跳转时预填的问题）；只在挂载时读取。 */
  initialPrompt?: string
}>(), {
  referencedArtifacts: () => [],
  running: false,
  stopping: false,
  mentionOptions: () => [],
  filesRequireMention: false,
  showWorkspaceContext: false,
  placeholder: undefined,
  initialPrompt: '',
})

const emit = defineEmits<{
  submit: [payload: { prompt: string; files: File[]; workspaceId: string; mentions: string[]; confirm: () => void }]
  stop: []
  'remove-reference': [fileId: string]
  'open-files': []
}>()
</script>

<template>
  <div
    v-if="referencedArtifacts.length"
    class="referenced-artifacts"
    data-testid="referenced-artifacts"
  >
    <span>引用成果</span>
    <el-tag
      v-for="item in referencedArtifacts"
      :key="item.fileId"
      closable
      effect="plain"
      @close="emit('remove-reference', item.fileId)"
    >
      {{ item.name }} · V{{ item.version }}
    </el-tag>
  </div>
  <slot name="notices" />
  <TaskComposer
    compact
    :show-workspace-context="showWorkspaceContext"
    :running="running"
    :stopping="stopping"
    :mention-options="mentionOptions"
    :files-require-mention="filesRequireMention"
    :placeholder="placeholder"
    :initial-prompt="initialPrompt"
    @open-files="emit('open-files')"
    @submit="emit('submit', $event)"
    @stop="emit('stop')"
  />
</template>
