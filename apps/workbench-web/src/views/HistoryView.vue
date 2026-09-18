<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useTaskStore } from '@/stores/tasks'
import { usePagedQuery } from '@/composables/usePagedQuery'
import type { UserSessionSummary } from '@/types/domain'
import { conversationRemovalNotice } from '@/utils/content-lifecycle'
import { notifyActionFailure } from '@/utils/feedback'
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const tasks = useTaskStore()
const query = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const scope = computed(() => route.query.scope === 'personal' || route.query.scope === 'team' ? route.query.scope : 'all')
const keyword = ref(query.value)
const { items, nextCursor, loading, error, reload, loadMore } = usePagedQuery(
  () => [query.value, scope.value, auth.user.id],
  cursor => workbenchApi.listSessions({ query: query.value, scope: scope.value, cursor, limit: 20 }),
)
watch(query, value => { keyword.value = value })
function search() { void router.replace({ query: { ...route.query, q: keyword.value || undefined } }) }
function changeScope(event: Event) { void router.replace({ query: { ...route.query, scope: (event.target as HTMLSelectElement).value } }) }
async function remove(item: UserSessionSummary) {
  try { await ElMessageBox.confirm(conversationRemovalNotice, '移除对话？', { confirmButtonText: '移除对话', cancelButtonText: '取消' }) }
  catch { return }
  try { await tasks.deleteConversation(item.sessionId); await reload() }
  catch(cause) { notifyActionFailure('移除对话', item.title, cause) }
}
</script>
<template>
  <section class="history-page panel">
    <header><div><h1>历史对话</h1><p>查找和继续自己的工作；团队对话按当前访问权限显示。</p></div><el-button type="primary" @click="router.push('/workbench')">新对话</el-button></header>
    <form class="history-filters" @submit.prevent="search">
      <label>搜索对话标题<input v-model="keyword" type="search" maxlength="200" placeholder="输入标题关键词" /></label>
      <label>对话范围<select :value="scope" @change="changeScope"><option value="all">全部对话</option><option value="personal">我的对话</option><option value="team">团队对话</option></select></label>
      <el-button native-type="submit">搜索</el-button>
    </form>
    <p v-if="error" role="alert">{{ error }} <el-button @click="reload">重试</el-button></p>
    <el-skeleton v-if="loading && !items.length" :rows="5" animated />
    <el-empty v-else-if="!items.length && !error" :description="query ? '没有匹配的对话' : '暂无历史对话'" />
    <ul aria-label="历史对话列表">
      <li v-for="item in items" :key="item.sessionId">
        <button class="history-open" type="button" @click="router.push(`/sessions/${item.sessionId}`)"><strong>{{ item.title }}</strong><small>{{ new Date(item.lastActiveAt).toLocaleString() }} · {{ item.runCount }} 轮任务<span v-if="item.workspaceType === 'team'"> · {{ item.workspaceName }}{{ item.workspaceStatus === 'archived' ? '（只读）' : '' }}</span></small></button>
        <el-button v-if="item.canRemove" :aria-label="`移除对话：${item.title}`" @click="remove(item)">移除</el-button>
      </li>
    </ul>
    <el-button v-if="nextCursor" :loading="loading" @click="loadMore">加载更多</el-button>
  </section>
</template>
<style scoped>
.history-page { padding: 24px; min-width: 0; }
header, .history-filters, li { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 { margin: 0; font-size: var(--dsh-font-size-page-title); }
header p, small { color: var(--dsh-color-muted); }
.history-filters { justify-content: flex-start; flex-wrap: wrap; margin: 24px 0; }
label { display: flex; flex-direction: column; gap: 4px; }
input, select { max-width: 100%; padding: 8px; border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-sm); background: var(--dsh-color-panel); color: inherit; }
ul { padding: 0; list-style: none; }
li { padding: 16px 0; border-bottom: 1px solid var(--dsh-color-border); }
.history-open { text-align: left; display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; background: none; border: 0; cursor: pointer; color: inherit; }
strong { overflow-wrap: anywhere; }
@media(max-width: 700px) { header { align-items: flex-start; flex-wrap: wrap; } .history-filters, .file-filters { gap: 12px; } }
</style>
