<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { usePagedQuery } from '@/composables/usePagedQuery'
import type { PersonalFile } from '@/types/domain'
import { fileRemovalNotice } from '@/utils/content-lifecycle'
import { notifyActionFailure } from '@/utils/feedback'
let mounted = true
onBeforeUnmount(() => { mounted = false })
const route = useRoute(), router = useRouter(), auth = useAuthStore()
const query = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const source = computed(() => ['material','attachment','artifact'].includes(String(route.query.source)) ? route.query.source as PersonalFile['source'] : 'all')
const keyword = ref(query.value), fileInput = ref<HTMLInputElement>(), uploading = ref(false), busy = ref('')
const sourceNames = { material: '个人材料', attachment: '会话附件', artifact: '生成成果' }
const { items, nextCursor, loading, error, reload, loadMore } = usePagedQuery(
  () => [query.value, source.value, auth.user.id],
  cursor => workbenchApi.listPersonalFiles({ query: query.value, source: source.value, cursor, limit: 20 }),
)
watch(query, value => { keyword.value = value })
function search() { void router.replace({ query: { ...route.query, q: keyword.value || undefined } }) }
function filter(event: Event) { void router.replace({ query: { ...route.query, source: (event.target as HTMLSelectElement).value } }) }
async function upload(event: Event) {
  const target = event.target as HTMLInputElement, file = target.files?.[0]
  if (!file || uploading.value) return
  uploading.value = true
  try { await workbenchApi.uploadPersonalFile(file) }
  catch(cause) { notifyActionFailure('上传文件', file.name, cause) }
  finally { uploading.value = false; target.value = ''; await reload() }
}
async function download(file: PersonalFile) {
  busy.value = file.id
  try {
    const actor = auth.user.id
    const blob = await workbenchApi.downloadPersonalFile(file.id)
    if (!mounted || actor !== auth.user.id) return
    const url = URL.createObjectURL(blob), anchor = document.createElement('a')
    anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url)
  } catch(cause) { notifyActionFailure('下载文件', file.name, cause) }
  finally { busy.value = '' }
}
async function remove(file: PersonalFile) {
  try { await ElMessageBox.confirm(fileRemovalNotice, '移除文件？', { confirmButtonText: '移除文件', cancelButtonText: '取消' }) }
  catch { return }
  busy.value = file.id
  try { await workbenchApi.removePersonalFile(file.id); await reload() }
  catch(cause) { notifyActionFailure('移除文件', file.name, cause) }
  finally { busy.value = '' }
}
</script>
<template>
  <section class="my-files-page panel">
    <header><div><h1>我的文件</h1><p>个人材料、对话附件和生成成果集中查找；团队资料请进入相应团队。</p></div><el-button type="primary" :loading="uploading" @click="fileInput?.click()">上传材料</el-button></header>
    <input ref="fileInput" class="visually-hidden" type="file" aria-label="上传个人材料" accept=".pdf,.docx,.xlsx,.csv,.txt,.md" @change="upload" />
    <form class="file-filters" @submit.prevent="search">
      <label>搜索文件名称<input v-model="keyword" type="search" maxlength="200" placeholder="输入文件名" /></label>
      <label>文件来源<select :value="source" @change="filter"><option value="all">全部文件</option><option value="material">个人材料</option><option value="attachment">会话附件</option><option value="artifact">生成成果</option></select></label>
      <el-button native-type="submit">搜索</el-button>
    </form>
    <p v-if="error" role="alert">{{ error }} <el-button @click="reload">重试</el-button></p>
    <el-skeleton v-if="loading && !items.length" :rows="5" animated />
    <el-empty v-else-if="!items.length && !error" :description="query || source !== 'all' ? '没有匹配的文件' : '暂无个人文件'" />
    <ul aria-label="我的文件列表">
      <li v-for="file in items" :key="file.id">
        <div class="file-copy"><strong>{{ file.name }}</strong><small>{{ sourceNames[file.source] }} · {{ file.type }} · {{ file.size }}<span v-if="file.version"> · V{{ file.version }}</span></small>
          <span v-if="file.scanStatus !== 'clean'">文件安全检查未通过</span><span v-else-if="file.parseStatus === 'failed'">解析失败，原文件仍可下载</span><span v-else-if="file.parseStatus !== 'succeeded'">当前未提供可引用解析结果</span>
          <router-link v-if="file.sessionId && file.sourceSessionState === 'active'" :to="`/sessions/${file.sessionId}`">来源对话</router-link><span v-else-if="file.sourceSessionState === 'removed'">原对话已移除，文件独立保留</span>
        </div>
        <div class="file-actions"><el-button v-if="file.canReference" @click="router.push({path:'/workbench',query:{file:file.id}})">引用到新对话</el-button><el-button v-if="file.canDownload" :disabled="busy === file.id" @click="download(file)">下载</el-button><el-button v-if="file.removable" :disabled="busy === file.id" @click="remove(file)">移除</el-button></div>
      </li>
    </ul>
    <el-button v-if="nextCursor" :loading="loading" @click="loadMore">加载更多</el-button>
  </section>
</template>
<style scoped>
.my-files-page { padding: 24px; min-width: 0; }
header, .file-filters, li { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 { margin: 0; font-size: var(--dsh-font-size-page-title); }
header p, small, .file-copy>span { color: var(--dsh-color-muted); }
.file-filters { justify-content: flex-start; flex-wrap: wrap; margin: 24px 0; }
label, .file-copy { display: flex; flex-direction: column; gap: 4px; }
input, select { max-width: 100%; padding: 8px; border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-sm); background: var(--dsh-color-panel); color: inherit; }
ul { padding: 0; list-style: none; }
li { padding: 16px 0; border-bottom: 1px solid var(--dsh-color-border); }
.file-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.file-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media(max-width: 700px) { li { align-items: flex-start; flex-direction: column; } }
@media(max-width: 700px) { header { align-items: flex-start; flex-wrap: wrap; } .history-filters, .file-filters { gap: 12px; } }
</style>
