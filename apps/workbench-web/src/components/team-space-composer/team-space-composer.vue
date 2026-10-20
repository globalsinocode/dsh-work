<template>
  <TaskComposer
    ref="composerRef"
    class="workbench-composer"
    :data-testid="placement === 'stage' ? 'team-space-composer-stage' : undefined"
    :compact="placement === 'dock'"
    :initial-prompt="initialPrompt"
    :initial-workspace-id="workspaceId"
    :initial-workspace-name="workspaceName"
    :workspaces="[]"
    workspace-locked
    show-workspace-context
    :blocked-reason="blockedReason"
    :mention-options="mentionOptions"
    :files-require-mention="filesRequireMention"
    :running="running"
    :stopping="stopping"
    @submit="onSubmit"
    @stop="emit('stop')"
    @open-files="router.push('/files')"
  />
  
  <footer class="workbench-trust workbench-trust--compact">
    <span>{{ TEAM_COMPOSER_SHORTCUT_HINT }}</span>
  </footer>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { emptyComposerDraft, TaskComposer, type ComposerDraft } from '@dsh-work/workbench-components'

import { TEAM_COMPOSER_SHORTCUT_HINT } from '@/utils/team-composer-hints'

const props = withDefaults(
  defineProps<{
    placement: 'stage' | 'dock'
    contextKey: string
    workspaceId: string
    workspaceName: string
    mentionOptions: Array<{ id: string; name: string }>
    drafts: Record<string, ComposerDraft>
    blockedReason?: string
    running?: boolean
    stopping?: boolean
    filesRequireMention?: boolean
    initialPrompt?: string
  }>(),
  {
    blockedReason: '',
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
}>()

type TaskComposerHandle = {
  getDraft: () => ComposerDraft
  setDraft: (draft: ComposerDraft) => void
}

const router = useRouter()
const composerRef = ref<TaskComposerHandle>()
const appliedContextKey = ref(props.contextKey)

onMounted(() => {
  void nextTick(() => restoreDraftForKey(props.contextKey))
})

function restoreDraftForKey(key: string) {
  const draft = props.drafts[key] ?? emptyComposerDraft()
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
    restoreDraftForKey(newKey)
  },
)

function focusComposer() {
  void nextTick(() => {
    const root = composerRef.value as unknown as { $el?: HTMLElement } | undefined
    root?.$el?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  })
}

defineExpose({ focusComposer })

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
