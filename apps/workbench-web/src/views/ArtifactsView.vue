<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Files, Search } from '@element-plus/icons-vue'

import { ArtifactCard } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import ArtifactPreviewDialog from '@/components/ArtifactPreviewDialog.vue'
import type { Artifact } from '@/types/domain'
import { downloadArtifactFile } from '@/utils/feedback'

const contentStore = useContentStore()
const query = ref('')
const typeFilter = ref('all')
const previewOpen = ref(false)
const previewArtifact = ref<Artifact | null>(null)

const filteredArtifacts = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.artifacts.filter((artifact) => {
    const matchesType = typeFilter.value === 'all' || artifact.type === typeFilter.value
    const matchesQuery = !keyword || `${artifact.name} ${artifact.summary}`.toLowerCase().includes(keyword)
    return matchesType && matchesQuery
  })
})

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

function preview(item: Artifact) {
  previewArtifact.value = item
  previewOpen.value = true
}

onMounted(() => contentStore.refresh())
</script>

<template>
  <div class="page-container artifacts-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">我的成果</h1>
        <p class="page-description">集中查看对话生成的报告、表格与分析文件。每次更新形成新版本，并保留来源运行的追溯关系。</p>
      </div>
    </header>

    <section class="artifact-overview panel">
      <div class="artifact-overview__icon"><el-icon><Files /></el-icon></div>
      <div><strong>{{ contentStore.artifacts.length }}</strong><span>成果文件</span></div>
      <div><strong>{{ contentStore.artifacts.length }}</strong><span>当前已发布</span></div>
    </section>

    <div class="artifact-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索成果名称或内容摘要" />
      <el-select v-model="typeFilter" aria-label="成果类型">
        <el-option label="全部类型" value="all" />
        <el-option label="Excel" value="xlsx" />
        <el-option label="PDF" value="pdf" />
        <el-option label="Word" value="docx" />
        <el-option label="Markdown" value="markdown" />
        <el-option label="HTML" value="html" />
        <el-option label="CSV" value="csv" />
        <el-option label="纯文本" value="text" />
      </el-select>
      <span>{{ filteredArtifacts.length }} 个文件</span>
    </div>

    <div v-if="contentStore.loading" class="artifact-grid">
      <div v-for="index in 4" :key="index" class="artifact-skeleton panel"><el-skeleton :rows="3" animated /></div>
    </div>
    <div v-else-if="filteredArtifacts.length" class="artifact-grid">
      <ArtifactCard
        v-for="artifact in filteredArtifacts"
        :key="artifact.id"
        :artifact="artifact"
        @download="download(artifact)"
        @preview="preview(artifact)"
      />
    </div>
    <el-empty v-else description="没有匹配的成果文件">
      <el-button @click="query = ''; typeFilter = 'all'">清除筛选</el-button>
    </el-empty>

    <ArtifactPreviewDialog
      v-if="previewArtifact"
      v-model:open="previewOpen"
      :artifact="previewArtifact"
    />
  </div>
</template>

<style scoped>
.artifact-overview {
  display: grid;
  grid-template-columns: 50px repeat(2, minmax(100px, 150px));
  align-items: center;
  gap: 18px;
  padding: 17px 20px;
}

.artifact-overview__icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 11px;
  color: #315dc4;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.artifact-overview > div:not(:first-child) {
  display: flex;
  flex-direction: column;
  padding-right: 18px;
  border-right: 1px solid var(--dsh-color-border);
}

.artifact-overview strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
}

.artifact-overview span {
  margin-top: 3px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.artifact-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 19px 0 13px;
}

.artifact-toolbar .el-input {
  width: 310px;
}

.artifact-toolbar .el-select {
  width: 150px;
}

.artifact-toolbar > span {
  margin-left: auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.artifact-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px;
}

.artifact-skeleton {
  padding: 16px;
}

@media (max-width: 900px) {
  .artifact-overview {
    grid-template-columns: 46px repeat(2, 1fr);
  }

  .artifact-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .artifact-overview {
    grid-template-columns: 42px 1fr;
  }

  .artifact-overview > div:not(:first-child) {
    border-right: 0;
  }

  .artifact-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .artifact-toolbar .el-input,
  .artifact-toolbar .el-select {
    width: 100%;
  }

  .artifact-toolbar > span {
    margin-left: 0;
  }
}
</style>
