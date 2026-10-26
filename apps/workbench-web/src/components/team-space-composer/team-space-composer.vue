<template>
  <TaskComposer
    ref="composerRef"
    class="workbench-composer"
    :data-testid="placement === 'stage' ? 'team-space-composer-stage' : placement === 'dock' ? 'team-space-composer-dock' : undefined"
    :compact="placement === 'dock'"
    :initial-prompt="initialPrompt"
    :initial-workspace-id="workspaceId"
    :initial-workspace-name="workspaceName"
    :workspaces="[]"
    workspace-locked
    show-workspace-context
    :blocked-reason="blockedReason"
    :submitting="submitting"
    :mention-options="mentionOptions"
    :files-require-mention="filesRequireMention"
    :running="running"
    :stopping="stopping"
    @submit="onSubmit"
    @stop="emit('stop')"
    @open-workspace-files="workspaceFilePickerOpen = true"
  />

  <WorkspaceFilePickerDialog
    v-model="workspaceFilePickerOpen"
    :workspace-id="workspaceId"
    @select="onWorkspaceFileSelected"
  />
  
  <footer class="workbench-trust workbench-trust--compact">
    <span>{{ TEAM_COMPOSER_SHORTCUT_HINT }}</span>
  </footer>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

import { emptyComposerDraft, TaskComposer, type ComposerDraft } from '@dsh-work/workbench-components'

import WorkspaceFilePickerDialog from '@/components/WorkspaceFilePickerDialog.vue'
import { TEAM_COMPOSER_SHORTCUT_HINT } from '@/utils/team-composer-hints'
import type { WorkspaceFileProjection } from '@/types/domain'

const props = withDefaults(
  defineProps<{
    placement: 'stage' | 'dock'
    contextKey: string
    workspaceId: string
    workspaceName: string
    mentionOptions: Array<{ id: string; name: string }>
    drafts: Record<string, ComposerDraft>
    blockedReason?: string
    submitting?: boolean
    running?: boolean
    stopping?: boolean
    filesRequireMention?: boolean
    initialPrompt?: string
  }>(),
  {
    blockedReason: '',
    submitting: false,
    running: false,
    stopping: false,
    filesRequireMention: true,
    initialPrompt: '',
  },
)

const emit = defineEmits<{
  submit: [payload: {
    prompt: string
    files: File[]
    workspaceId: string
    mentions: string[]
    contextKey: string
    confirm?: () => void
    release?: () => void
  }]
  stop: []
  'draft-change': [fromKey: string, draft: ComposerDraft]
  'workspace-file-selected': [file: WorkspaceFileProjection]
}>()

type TaskComposerHandle = {
  getDraft: () => ComposerDraft
  setDraft: (draft: ComposerDraft) => void
}

const composerRef = ref<TaskComposerHandle>()
const workspaceFilePickerOpen = ref(false)
const appliedContextKey = ref(props.contextKey)

onMounted(() => {
  void nextTick(() => restoreDraftForKey(props.contextKey))
})

/**
 * 从父级草稿表恢复输入。首次挂载时若该 key 无已存草稿，不要 setDraft(空)，
 * 否则会冲掉用户在上传/输入与 nextTick 恢复之间的本地附件。
 * 切换 contextKey 时则强制恢复（含空草稿），以清空上一上下文的残留。
 */
function restoreDraftForKey(key: string, force = false) {
  const draft = props.drafts[key] ?? emptyComposerDraft()
  const hasStoredDraft = Boolean(
    draft.prompt.trim()
    || draft.files.length
    || draft.mentions.length,
  )
  if (!force && !hasStoredDraft) return
  composerRef.value?.setDraft(draft)
}

watch(
  () => props.contextKey,
  async (newKey, oldKey) => {
    if (oldKey && oldKey !== newKey && composerRef.value) {
      emit('draft-change', oldKey, composerRef.value.getDraft())
      await nextTick()
    }
    appliedContextKey.value = newKey
    await nextTick()
    restoreDraftForKey(newKey, true)
  },
)

function focusComposer() {
  void nextTick(() => {
    const root = composerRef.value as unknown as { $el?: HTMLElement } | undefined
    root?.$el?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  })
}

function setDraft(draft: ComposerDraft) {
  composerRef.value?.setDraft(draft)
}

defineExpose({ focusComposer, setDraft })

function onWorkspaceFileSelected(file: WorkspaceFileProjection) {
  emit('workspace-file-selected', file)
}

function onSubmit(payload: {
  prompt: string
  files: File[]
  workspaceId: string
  mentions: string[]
  confirm?: () => void
  release?: () => void
}) {
  emit('submit', { ...payload, contextKey: props.contextKey })
}
</script>

<style scoped>
.workbench-composer {
  width: 100%;
}

.workbench-trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 10px;
  color: #999d99;
  font-size: var(--dsh-font-size-micro);
}

.workbench-trust span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.workbench-trust--compact {
  justify-content: center;
  margin-top: 6px;
}
</style>
