<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Search } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { WeknoraDocumentSummary, WeknoraKnowledgeBaseSummary, WeknoraSearchHit } from '@/types/domain'

const route = useRoute()
const router = useRouter()
const kbId = computed(() => String(route.params.kbId ?? ''))
const loading = ref(true)
const errorMessage = ref('')
const kb = ref<WeknoraKnowledgeBaseSummary | null>(null)
const documents = ref<WeknoraDocumentSummary[]>([])
const searchQuery = ref('')
const searchResults = ref<WeknoraSearchHit[]>([])
const previewDocumentId = ref<string | null>(null)

const previewUrl = computed(() =>
  previewDocumentId.value ? workbenchApi.weknoraDocumentContentUrl(previewDocumentId.value, true) : '',
)

async function loadPage() {
  loading.value = true
  errorMessage.value = ''
  searchResults.value = []
  try {
    kb.value = await workbenchApi.getWeknoraKnowledgeBase(kbId.value)
    const response = await workbenchApi.listWeknoraDocuments(kbId.value)
    documents.value = response.list
  } catch (error) {
    kb.value = null
    documents.value = []
    errorMessage.value = error instanceof Error ? error.message : '无法打开该知识库'
  } finally {
    loading.value = false
  }
}

async function runSearch() {
  const query = searchQuery.value.trim()
  if (!query) {
    searchResults.value = []
    return
  }
  const response = await workbenchApi.searchWeknoraKnowledgeBase(kbId.value, query)
  searchResults.value = response.list
}

function openPreview(documentId: string) {
  previewDocumentId.value = documentId
}

function downloadDocument(documentId: string) {
  window.location.assign(workbenchApi.weknoraDocumentContentUrl(documentId))
}

onMounted(loadPage)
</script>

<template>
  <div class="knowledge-detail-page">
    <el-button text :icon="ArrowLeft" @click="router.push('/knowledge')">返回列表</el-button>

    <div v-if="loading" aria-busy="true">
      <el-skeleton :rows="6" animated />
    </div>

    <el-result
      v-else-if="errorMessage"
      icon="warning"
      title="无法打开该知识库"
      :sub-title="errorMessage"
    >
      <template #extra>
        <el-button @click="router.push('/knowledge')">回到列表</el-button>
      </template>
    </el-result>

    <template v-else-if="kb">
      <header class="knowledge-detail-page__header">
        <h1>{{ kb.name }}</h1>
        <p v-if="kb.description">{{ kb.description }}</p>
      </header>

      <div class="knowledge-detail-page__search">
        <el-input v-model="searchQuery" placeholder="在当前知识库内检索" @keyup.enter="runSearch">
          <template #append>
            <el-button :icon="Search" aria-label="检索" @click="runSearch" />
          </template>
        </el-input>
      </div>

      <section v-if="searchResults.length > 0" aria-label="检索结果">
        <h2>检索结果</h2>
        <el-card v-for="hit in searchResults" :key="hit.documentId" class="doc-row" @click="openPreview(hit.documentId)">
          <strong>{{ hit.title }}</strong>
          <p>{{ hit.snippet }}</p>
        </el-card>
      </section>

      <section aria-label="文档列表">
        <h2>文档</h2>
        <el-empty v-if="documents.length === 0" description="暂无文档" />
        <el-card v-for="doc in documents" :key="doc.id" class="doc-row">
          <div class="doc-row__actions">
            <button type="button" class="doc-row__title" @click="openPreview(doc.id)">{{ doc.title }}</button>
            <el-button link type="primary" @click="downloadDocument(doc.id)">下载</el-button>
          </div>
        </el-card>
      </section>

      <section v-if="previewDocumentId" class="knowledge-detail-page__preview" aria-label="文档预览">
        <div class="knowledge-detail-page__preview-toolbar">
          <span>预览</span>
          <el-button link @click="previewDocumentId = null">关闭</el-button>
        </div>
        <iframe :src="previewUrl" title="文档预览" class="knowledge-detail-page__preview-frame" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.knowledge-detail-page {
  padding: 24px;
}

.knowledge-detail-page__header h1 {
  margin: 8px 0;
}

.knowledge-detail-page__search {
  margin: 16px 0 24px;
  max-width: 520px;
}

.doc-row {
  margin-bottom: 12px;
}

.doc-row__actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.doc-row__title {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--el-color-primary);
  cursor: pointer;
  text-align: left;
}

.knowledge-detail-page__preview {
  margin-top: 24px;
}

.knowledge-detail-page__preview-frame {
  width: 100%;
  min-height: 480px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
}
</style>
