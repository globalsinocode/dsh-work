<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TaskComposer } from '@dsh-work/workbench-components'
import { workbenchApi } from '@/api/client'
import type { UserSessionSummary } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
const route = useRoute()
const router = useRouter()
const session = ref<UserSessionSummary>()
const loading = ref(false)
const error = ref('')
let generation = 0
watch(() => route.params.id, async value => {
  const current = ++generation
  loading.value = true; session.value = undefined; error.value = ''
  try {
    const loaded = await workbenchApi.getConversationSession(String(value))
    if (current !== generation) return
    session.value = loaded
    if (loaded.latestRun) await router.replace(`/conversations/${loaded.latestRun.id}`)
  } catch(cause) { if (current === generation) error.value = cause instanceof Error ? cause.message : '无法读取对话' }
  finally { if (current === generation) loading.value = false }
}, { immediate: true })
onBeforeUnmount(() => { generation++ })
async function submit(payload: { prompt: string; files: File[] }) {
  const target = session.value, current = generation
  if (!target?.canContinue) return
  try {
    const fileIds: string[] = []
    for (const file of payload.files) {
      if (current !== generation) return
      fileIds.push((await workbenchApi.uploadSessionFile(target.sessionId, file)).id)
    }
    if (current !== generation) return
    const task = await workbenchApi.startRun(target.sessionId, { prompt: payload.prompt, fileIds, idempotencyKey: crypto.randomUUID() })
    if (current === generation) await router.replace(`/conversations/${task.id}`)
  } catch(cause) { if (current === generation) notifyActionFailure('继续对话', target.title, cause) }
}
</script>
<template>
  <section class="panel session-resume">
    <el-skeleton v-if="loading" :rows="5" animated />
    <p v-else-if="error" role="alert">{{ error }} <el-button @click="router.push('/history')">返回历史对话</el-button></p>
    <template v-else-if="session">
      <h1>{{ session.title }}</h1><p v-if="session.workspaceType === 'team'">团队：{{ session.workspaceName }}</p>
      <p>这段对话尚未开始任务。继续发送会沿用原对话，不创建另一个会话。</p>
      <TaskComposer v-if="session.canContinue" :key="session.sessionId" :initial-workspace-id="session.workspaceId" :initial-workspace-name="session.workspaceName" :show-workspace-context="session.workspaceType === 'team'" workspace-locked @submit="submit" />
      <p v-else>当前对话只读。</p>
    </template>
  </section>
</template>
<style scoped>.session-resume { padding: 24px; }</style>
