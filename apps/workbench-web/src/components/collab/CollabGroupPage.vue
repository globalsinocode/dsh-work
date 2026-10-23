<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import CollabGroupHeader from './CollabGroupHeader.vue'
import CollabGroupTimeline from './CollabGroupTimeline.vue'
import { collabSpaceRoutes, provideSpaceRoutes } from '@/composables/space-routes'
import type { WorkspaceFile } from '@/types/domain'
import WorkspaceEntryView from '@/views/WorkspaceEntryView.vue'

/**
 * 协作模式群组（S5d，D20 / D30）：群组即项目空间。内容区就是 A 的项目空间详情（同一组件，
 * collab 布局）——任务、文件、成果、档案页签、任务详情、执行详情、信息栏与各弹窗没有第二份
 * 实现；本组件只提供 B 的头部与“对话”页签的群聊时间线。
 */
const props = defineProps<{ workspaceId: string }>()
const emit = defineEmits<{ back: [] }>()
const route = useRoute()
const router = useRouter()

// 任务详情、任务对话与执行详情中的链接都留在群组内（/c/chats/group/:id/...）。
provideSpaceRoutes(collabSpaceRoutes)

const infoOpen = computed(() => route.query.info === '1')
const memberDialogRequest = ref(0)
const pendingFile = ref<WorkspaceFile | null>(null)
const focusSessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : undefined)

function withQuery(patch: Record<string, string | undefined>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete query[key]
    else query[key] = value
  }
  return query
}

function setInfoOpen(open: boolean) {
  if (open === infoOpen.value) return
  void router.replace({ query: withQuery({ info: open ? '1' : undefined }) })
}

/** 切换页签回到群组首页（离开任务详情或执行详情），对话页签不写参数。 */
function selectTab(tab: string) {
  void router.replace({
    name: 'collab-group-chat',
    params: { id: props.workspaceId },
    query: withQuery({ tab: tab === 'chat' ? undefined : tab, session: undefined }),
  })
}

function useFile(file: WorkspaceFile) {
  pendingFile.value = file
  selectTab('chat')
}
</script>

<template>
  <div class="collab-group-page">
    <WorkspaceEntryView
      :key="workspaceId"
      layout="collab"
      :info-open="infoOpen"
      :member-dialog-request="memberDialogRequest"
      @update:info-open="setInfoOpen"
      @use-file="useFile"
    >
      <template #header="scope">
        <CollabGroupHeader
          v-bind="scope"
          :info-open="infoOpen"
          @select-tab="selectTab"
          @add-member="memberDialogRequest += 1"
          @toggle-info="setInfoOpen(!infoOpen)"
          @back="emit('back')"
        />
      </template>
      <template #chat="scope">
        <CollabGroupTimeline
          :workspace-id="workspaceId"
          :can-write="scope.canWrite"
          :archived="scope.archived"
          :role-known="scope.roleKnown"
          :mention-options="scope.mentionOptions"
          :has-agent-members="scope.hasAgentMembers"
          :focus-session-id="focusSessionId"
          :pending-file="pendingFile"
          @clear-file="pendingFile = null"
          @open-info="setInfoOpen(true)"
        />
      </template>
    </WorkspaceEntryView>
  </div>
</template>

<style scoped>
.collab-group-page {
  height: 100%;
  min-height: 0;
}
</style>
