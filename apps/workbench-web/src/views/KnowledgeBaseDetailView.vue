<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ChatDotRound, Notebook, Search, Upload } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import KnowledgeGrantDialog from '@/components/knowledge/KnowledgeGrantDialog.vue'
import type { KnowledgeBase, KnowledgeDocument, KnowledgeDocumentStatus } from '@/types/knowledge'
import { notifyActionFailure } from '@/utils/feedback'
import { useUiModeStore } from '@/stores/ui-mode'
import { describeKnowledgeGrants, formatKnowledgeDate, formatKnowledgeDateTime } from '@/utils/knowledge'

/**
 * 知识库详情（weknora-knowledge-plan 第 8 节）：面包屑、“文档”页签与右侧“知识库信息”，与项目空间
 * 详情一致。按钮只按服务端返回的 canManageDocuments / canManageBase 显示，最终权限由服务端校验。
 */
const route = useRoute()
const router = useRouter()
const knowledgeBaseId = computed(() => String(route.params.id ?? ''))
// B 协作模式没有不指定 AI 同事的新对话，“用这个知识库提问”只在 A 模式显示；B 在单聊输入框中添加。
const uiMode = useUiModeStore()

const base = ref<KnowledgeBase | null>(null)
const loadError = ref('')
const documents = ref<KnowledgeDocument[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const documentsLoading = ref(false)
const documentsError = ref('')
const keyword = ref('')
const status = ref<'all' | KnowledgeDocumentStatus>('all')
const grantOpen = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement>()
const preview = ref<{ title: string; text: string; truncated: boolean } | null>(null)

const statusOptions: Array<{ id: 'all' | KnowledgeDocumentStatus; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'completed', label: '已完成' },
  { id: 'parsing', label: '解析中' },
  { id: 'failed', label: '解析失败' },
]
// StatusTag 按状态键取色：success 绿、warning 橙、failed 红。
const statusLabels: Record<KnowledgeDocumentStatus, { label: string; tone: 'success' | 'warning' | 'failed' }> = {
  completed: { label: '已完成', tone: 'success' },
  parsing: { label: '解析中', tone: 'warning' },
  failed: { label: '解析失败', tone: 'failed' },
}
const myRight = computed(() => base.value?.canManageBase ? '知识库管理' : base.value?.canManageDocuments ? '文档管理' : '仅查看')
const visibleDepartments = computed(() => describeKnowledgeGrants(base.value?.grants ?? []))

async function loadBase() {
  loadError.value = ''
  try {
    base.value = await workbenchApi.getKnowledgeBase(knowledgeBaseId.value)
  } catch (cause) {
    base.value = null
    loadError.value = cause instanceof Error ? cause.message : '知识库服务暂不可用，请稍后重试'
  }
}

let documentToken = 0
async function loadDocuments() {
  const token = ++documentToken
  documentsLoading.value = true
  documentsError.value = ''
  try {
    const result = await workbenchApi.listKnowledgeDocuments(knowledgeBaseId.value, {
      keyword: keyword.value.trim(), status: status.value, page: page.value, pageSize,
    })
    if (token !== documentToken) return
    documents.value = result.items
    total.value = result.total
  } catch (cause) {
    if (token !== documentToken) return
    documents.value = []
    documentsError.value = cause instanceof Error ? cause.message : '知识库服务暂不可用，请稍后重试'
  } finally {
    if (token === documentToken) documentsLoading.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(keyword, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; void loadDocuments() }, 300)
})
watch(status, () => { page.value = 1; void loadDocuments() })
watch(knowledgeBaseId, () => { void reload() })

async function reload() {
  await loadBase()
  if (base.value) await loadDocuments()
}

function askWithBase() {
  if (!base.value) return
  void router.push({ path: '/workbench', query: { new: String(Date.now()), knowledgeBase: base.value.id } })
}

function chooseFile() {
  fileInput.value?.click()
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length || !base.value) return
  try {
    // WK13：上传前提示文档将对哪些部门可见。
    await ElMessageBox.confirm(
      `上传的文档将对以下部门可见：${visibleDepartments.value}。这些部门员工的 AI 同事在对话中添加此知识库后都能检索到它。`,
      `上传 ${files.length} 个文件到“${base.value.name}”`,
      { confirmButtonText: '上传', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  uploading.value = true
  let succeeded = 0
  for (const file of files) {
    try {
      await workbenchApi.uploadKnowledgeDocument(base.value.id, file)
      succeeded += 1
    } catch (cause) {
      notifyActionFailure('上传文件', file.name, cause, '检查文件大小与格式后重试。')
    }
  }
  uploading.value = false
  if (succeeded) ElMessage.success(`已上传 ${succeeded} 个文件，解析完成后即可检索`)
  await reload()
}

async function renameDocument(document: KnowledgeDocument) {
  if (!base.value) return
  try {
    const { value } = await ElMessageBox.prompt('新的标题', '修改标题', {
      inputValue: document.title,
      inputValidator: (text: string) => (text.trim() && text.trim().length <= 200) || '标题长度为 1～200 个字',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    await workbenchApi.updateKnowledgeDocument(base.value.id, document.id, value.trim())
    ElMessage.success('标题已修改')
    await loadDocuments()
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return
    notifyActionFailure('修改标题', document.fileName, cause, '请稍后重试。')
  }
}

async function reparse(document: KnowledgeDocument) {
  if (!base.value) return
  try {
    await workbenchApi.reparseKnowledgeDocument(base.value.id, document.id)
    ElMessage.success('已重新提交解析')
    await loadDocuments()
  } catch (cause) {
    notifyActionFailure('重新解析', document.fileName, cause, '请稍后重试。')
  }
}

async function removeDocument(document: KnowledgeDocument) {
  if (!base.value) return
  try {
    await ElMessageBox.confirm(`删除后对话中不再检索“${document.title}”。`, '删除文档', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
  } catch {
    return
  }
  try {
    await workbenchApi.deleteKnowledgeDocument(base.value.id, document.id)
    ElMessage.success(`已删除“${document.title}”`)
    await reload()
  } catch (cause) {
    notifyActionFailure('删除文档', document.fileName, cause, '请稍后重试。')
  }
}

async function download(document: KnowledgeDocument) {
  if (!base.value) return
  try {
    const blob = await workbenchApi.downloadKnowledgeDocument(base.value.id, document.id)
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = document.fileName || document.title
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (cause) {
    notifyActionFailure('下载', document.fileName, cause, '请稍后重试。')
  }
}

async function openPreview(document: KnowledgeDocument) {
  if (!base.value) return
  try {
    const result = await workbenchApi.previewKnowledgeDocument(base.value.id, document.id)
    preview.value = { title: document.title, ...result }
  } catch (cause) {
    notifyActionFailure('预览', document.fileName, cause, '可以下载原文件查看。')
  }
}

async function renameBase() {
  if (!base.value) return
  try {
    const { value } = await ElMessageBox.prompt('知识库名称', '修改名称', {
      inputValue: base.value.name,
      inputValidator: (text: string) => (text.trim() && text.trim().length <= 60) || '名称长度为 1～60 个字',
      confirmButtonText: '保存', cancelButtonText: '取消',
    })
    base.value = await workbenchApi.updateKnowledgeBase(base.value.id, { name: value.trim() })
    ElMessage.success('已保存')
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return
    notifyActionFailure('修改名称', base.value?.name ?? '知识库', cause, '请稍后重试。')
  }
}

async function editDescription() {
  if (!base.value) return
  try {
    const { value } = await ElMessageBox.prompt('知识库说明', '修改说明', {
      inputValue: base.value.description,
      inputValidator: (text: string) => text.trim().length <= 200 || '说明不能超过 200 个字',
      confirmButtonText: '保存', cancelButtonText: '取消',
    })
    base.value = await workbenchApi.updateKnowledgeBase(base.value.id, { description: value.trim() })
    ElMessage.success('已保存')
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return
    notifyActionFailure('修改说明', base.value?.name ?? '知识库', cause, '请稍后重试。')
  }
}

async function removeBase() {
  if (!base.value) return
  const name = base.value.name
  try {
    await ElMessageBox.prompt(
      `知识库中的 ${base.value.documentCount} 篇文档将一并删除，之后所有对话都不再检索它。已有回答中的引用记录保留。此操作不能撤销。请输入知识库名称确认。`,
      `删除“${name}”`,
      {
        confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
        inputPlaceholder: name,
        inputValidator: (text: string) => text.trim() === name || '请输入知识库名称确认',
      },
    )
  } catch {
    return
  }
  try {
    await workbenchApi.deleteKnowledgeBase(base.value.id)
    ElMessage.success(`已删除“${name}”`)
    void router.push('/knowledge')
  } catch (cause) {
    notifyActionFailure('删除知识库', name, cause, '请稍后重试。')
  }
}

function onDocumentCommand(command: string, document: KnowledgeDocument) {
  if (command === 'rename') void renameDocument(document)
  if (command === 'reparse') void reparse(document)
  if (command === 'delete') void removeDocument(document)
}

function onGrantsChanged(updated: KnowledgeBase) {
  base.value = updated
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="knowledge-detail">
    <section class="knowledge-detail__main">
      <div class="knowledge-detail__topbar">
        <nav class="knowledge-crumbs" aria-label="当前位置">
          <el-icon class="knowledge-crumbs__icon" aria-hidden="true"><Notebook /></el-icon>
          <RouterLink class="knowledge-crumbs__link" to="/knowledge">知识库</RouterLink>
          <span class="knowledge-crumbs__sep" aria-hidden="true">/</span>
          <strong class="knowledge-crumbs__current" aria-current="page">{{ base?.name ?? '知识库' }}</strong>
        </nav>
        <el-button v-if="base && uiMode.mode !== 'collab'" :icon="ChatDotRound" @click="askWithBase">用这个知识库提问</el-button>
      </div>

      <el-empty v-if="loadError" class="knowledge-detail__error" :description="loadError">
        <el-button @click="reload">重试</el-button>
        <el-button @click="router.push('/knowledge')">返回知识库</el-button>
      </el-empty>

      <template v-else-if="base">
        <header class="knowledge-detail__tabs">
          <span class="knowledge-detail__tab is-active">文档</span>
        </header>
        <div class="knowledge-detail__body">
          <div class="knowledge-docs-toolbar">
            <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="按标题或文件名搜索" aria-label="按标题或文件名搜索" />
            <div class="knowledge-filter" role="group" aria-label="解析状态">
              <button
                v-for="option in statusOptions"
                :key="option.id"
                class="knowledge-filter__item"
                :class="{ 'is-active': status === option.id }"
                type="button"
                :aria-pressed="status === option.id"
                @click="status = option.id"
              >
                {{ option.label }}
              </button>
            </div>
            <el-button v-if="base.canManageDocuments" class="knowledge-docs-toolbar__upload" type="primary" :icon="Upload" :loading="uploading" @click="chooseFile">上传文件</el-button>
            <input ref="fileInput" class="knowledge-file-input" type="file" multiple aria-label="选择要上传的文件" @change="onFileChosen">
          </div>

          <el-empty v-if="documentsError" :description="documentsError">
            <el-button @click="loadDocuments">重试</el-button>
          </el-empty>
          <el-table v-else-if="documents.length || documentsLoading" v-loading="documentsLoading" :data="documents" class="knowledge-docs-table">
            <el-table-column label="标题" min-width="150">
              <template #default="{ row }"><span class="knowledge-docs-table__title">{{ row.title }}</span></template>
            </el-table-column>
            <el-table-column prop="fileName" label="文件名" min-width="150" show-overflow-tooltip />
            <el-table-column label="上传人" width="90">
              <template #default="{ row }">{{ row.uploadedBy ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="更新时间" width="150" class-name="knowledge-docs-table__nowrap">
              <template #default="{ row }">{{ formatKnowledgeDateTime(row.updatedAt) || '—' }}</template>
            </el-table-column>
            <el-table-column label="解析状态" width="100">
              <template #default="{ row }">
                <el-tooltip v-if="row.errorMessage" :content="row.errorMessage" placement="top">
                  <StatusTag :status="statusLabels[row.status as KnowledgeDocumentStatus].tone" :label="statusLabels[row.status as KnowledgeDocumentStatus].label" />
                </el-tooltip>
                <StatusTag v-else :status="statusLabels[row.status as KnowledgeDocumentStatus].tone" :label="statusLabels[row.status as KnowledgeDocumentStatus].label" />
              </template>
            </el-table-column>
            <el-table-column label="操作" :width="base.canManageDocuments ? 170 : 120">
              <template #default="{ row }">
                <div class="knowledge-docs-table__actions">
                  <el-button link type="primary" @click="openPreview(row)">预览</el-button>
                  <el-button link type="primary" @click="download(row)">下载</el-button>
                  <el-dropdown v-if="base.canManageDocuments" trigger="click" @command="(command: string) => onDocumentCommand(command, row)">
                    <el-button link type="primary" :aria-label="`更多操作：${row.title}`">更多</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="rename">编辑标题</el-dropdown-item>
                        <el-dropdown-item v-if="row.status === 'failed'" command="reparse">重新解析</el-dropdown-item>
                        <el-dropdown-item command="delete" divided><span class="knowledge-docs-table__danger">删除</span></el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else-if="keyword || status !== 'all'" description="没有匹配的文档">
            <el-button @click="keyword = ''; status = 'all'">清除筛选</el-button>
          </el-empty>
          <el-empty v-else description="还没有文档">
            <p class="knowledge-empty-hint">上传制度、规范等文件后，对话中添加此知识库即可检索。</p>
            <el-button v-if="base.canManageDocuments" type="primary" :icon="Upload" @click="chooseFile">上传文件</el-button>
          </el-empty>
          <el-pagination
            v-if="total > pageSize"
            v-model:current-page="page"
            class="knowledge-pagination"
            layout="prev, pager, next"
            :page-size="pageSize"
            :total="total"
            @current-change="loadDocuments"
          />
        </div>
      </template>
      <div v-else class="knowledge-detail__body"><el-skeleton :rows="6" animated /></div>
    </section>

    <aside v-if="base" class="knowledge-detail__aside" aria-label="知识库信息">
      <div class="knowledge-aside__title">知识库信息</div>
      <section class="knowledge-aside__card">
        <div class="knowledge-aside__head">
          <span class="knowledge-aside__icon"><el-icon><Notebook /></el-icon></span>
          <StatusTag status="pending" label="知识库" />
        </div>
        <h2>{{ base.name }}</h2>
        <p>{{ base.description || '暂无说明' }}</p>
        <dl>
          <div><dt>归属部门</dt><dd>{{ base.ownerDepartmentName }}</dd></div>
          <div><dt>文档</dt><dd>{{ base.documentCount }} 篇<template v-if="base.updatedAt"> · {{ formatKnowledgeDate(base.updatedAt) }}更新</template></dd></div>
          <div><dt>我的权限</dt><dd>{{ myRight }}</dd></div>
        </dl>
        <div v-if="base.canManageBase" class="knowledge-aside__actions">
          <el-button size="small" @click="renameBase">修改名称</el-button>
          <el-button size="small" @click="editDescription">修改说明</el-button>
        </div>
      </section>
      <section class="knowledge-aside__card">
        <div class="knowledge-aside__section-head">
          <span>可见部门 <em>{{ base.grants.length }} 个</em></span>
          <button v-if="base.canManageBase" class="knowledge-aside__link" type="button" @click="grantOpen = true">管理可见部门</button>
        </div>
        <ul class="knowledge-aside__grants">
          <li v-for="grant in base.grants" :key="grant.id">
            <span>{{ grant.departmentName }}<em v-if="grant.includeDescendants && grant.departmentName !== '全公司'">（含下级）</em></span>
            <StatusTag :status="grant.grantedVia === 'admin' ? 'pending' : 'running'" :label="grant.grantedVia === 'admin' ? '管理员授予' : '员工授予'" />
          </li>
        </ul>
        <div class="knowledge-aside__note">这些部门的员工可以查看文档，并在对话中添加此知识库检索。</div>
      </section>
      <el-button v-if="base.canManageBase" class="knowledge-aside__delete" type="danger" plain @click="removeBase">删除知识库</el-button>
    </aside>

    <KnowledgeGrantDialog v-if="base" v-model="grantOpen" :base="base" @changed="onGrantsChanged" />

    <el-dialog :model-value="Boolean(preview)" :title="preview ? `预览：${preview.title}` : '预览'" width="720px" append-to-body @close="preview = null">
      <pre class="knowledge-preview">{{ preview?.text }}</pre>
      <p v-if="preview?.truncated" class="knowledge-empty-hint">预览只显示前 200 KB，完整内容请下载原文件。</p>
    </el-dialog>
  </div>
</template>

<style scoped>
.knowledge-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  min-height: 100vh;
  background: #fff;
}

.knowledge-detail__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.knowledge-detail__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 0 24px 0 28px;
  border-bottom: 1px solid #ececee;
}

.knowledge-crumbs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  font-size: var(--dsh-font-size-body);
}

.knowledge-crumbs__icon,
.knowledge-crumbs__link {
  flex: 0 0 auto;
  color: #6b6f6c;
  text-decoration: none;
}

.knowledge-crumbs__link:hover {
  color: #1d201e;
}

.knowledge-crumbs__link:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: 2px;
  border-radius: 4px;
}

.knowledge-crumbs__sep {
  color: #b4b8b5;
}

.knowledge-crumbs__current {
  min-width: 0;
  overflow: hidden;
  color: #1d201e;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.knowledge-detail__tabs {
  display: flex;
  gap: 4px;
  padding: 6px 16px 0;
  border-bottom: 1px solid #eef0ec;
}

.knowledge-detail__tab {
  position: relative;
  padding: 8px 12px 12px;
  color: #6b6f6c;
  font-size: var(--dsh-font-size-section);
}

.knowledge-detail__tab.is-active {
  color: #1d201e;
  font-weight: 650;
}

.knowledge-detail__tab.is-active::after {
  position: absolute;
  right: 12px;
  bottom: -1px;
  left: 12px;
  height: 2px;
  border-radius: 2px;
  background: #1d201e;
  content: '';
}

.knowledge-detail__body {
  padding: 16px 28px 32px;
}

.knowledge-detail__error {
  margin-top: 48px;
}

.knowledge-docs-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.knowledge-docs-toolbar .el-input {
  width: 290px;
}

.knowledge-docs-toolbar__upload {
  margin-left: auto;
}

.knowledge-file-input {
  display: none;
}

.knowledge-filter {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid #e3e5e2;
  border-radius: 9px;
  background: #fff;
}

.knowledge-filter__item {
  min-height: 26px;
  padding: 0 11px;
  border: 0;
  border-radius: 7px;
  color: #777c77;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
}

.knowledge-filter__item:hover {
  color: #244d40;
  background: #f4f7f5;
}

.knowledge-filter__item.is-active {
  color: #1f5a49;
  background: #eaf4f0;
  font-weight: 620;
}

.knowledge-filter__item:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -2px;
}

.knowledge-docs-table__title {
  color: var(--dsh-color-ink);
  font-weight: 500;
}

.knowledge-docs-table__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.knowledge-docs-table__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.knowledge-docs-table :deep(.knowledge-docs-table__nowrap .cell) {
  white-space: nowrap;
}

.knowledge-docs-table__danger {
  color: var(--dsh-color-danger);
}

.knowledge-pagination {
  justify-content: flex-end;
  margin-top: 12px;
}

.knowledge-empty-hint {
  max-width: 420px;
  margin: 0 auto 8px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.knowledge-detail__aside {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 24px;
  border-left: 1px solid #ececee;
  background: #fafaf9;
}

.knowledge-aside__title {
  padding: 0 4px 6px;
  color: #2c302d;
  font-size: var(--dsh-font-size-body);
}

.knowledge-aside__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid #e7e8e6;
  border-radius: 12px;
  background: #fff;
}

.knowledge-aside__head,
.knowledge-aside__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.knowledge-aside__section-head > span {
  color: #2c302d;
  font-size: var(--dsh-font-size-body);
  font-weight: 600;
}

.knowledge-aside__section-head em {
  color: #8a8f8b;
  font-size: var(--dsh-font-size-badge);
  font-style: normal;
  font-weight: 400;
}

.knowledge-aside__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  color: #1f7a5c;
  background: #eaf4f0;
}

.knowledge-aside__card h2 {
  margin: 0;
  color: #171817;
  font-size: var(--dsh-font-size-subheading);
}

.knowledge-aside__card p {
  margin: 0;
  color: #6b6f6c;
  font-size: var(--dsh-font-size-caption);
}

.knowledge-aside__card dl {
  margin: 0;
}

.knowledge-aside__card dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid #f0f1ef;
  font-size: var(--dsh-font-size-caption);
}

.knowledge-aside__card dt {
  color: #6b6f6c;
}

.knowledge-aside__card dd {
  margin: 0;
  color: #2c302d;
  text-align: right;
}

.knowledge-aside__actions {
  display: flex;
  gap: 8px;
}

.knowledge-aside__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.knowledge-aside__link {
  padding: 0;
  border: 0;
  background: transparent;
  color: #1f7a5c;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  font-weight: 600;
}

.knowledge-aside__grants {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.knowledge-aside__grants li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #2c302d;
  font-size: var(--dsh-font-size-caption);
}

.knowledge-aside__grants em {
  color: #8a8f8b;
  font-style: normal;
}

.knowledge-aside__note {
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef6f2;
  color: #1f5a49;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
}

.knowledge-aside__delete {
  align-self: flex-start;
}

.knowledge-preview {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  color: var(--dsh-color-text);
  font-family: inherit;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.7;
  white-space: pre-wrap;
}

@media (max-width: 960px) {
  .knowledge-detail {
    grid-template-columns: minmax(0, 1fr);
  }

  .knowledge-detail__aside {
    border-top: 1px solid #ececee;
    border-left: 0;
  }

  .knowledge-detail__body {
    padding: 14px 16px 24px;
  }

  .knowledge-detail__topbar {
    padding: 0 16px calc(0px) calc(16px + var(--dsh-page-topbar-inset-start, 0px));
  }
}

@media (max-width: 680px) {
  .knowledge-docs-toolbar .el-input {
    width: 100%;
  }

  .knowledge-docs-toolbar__upload {
    margin-left: 0;
  }
}
</style>
