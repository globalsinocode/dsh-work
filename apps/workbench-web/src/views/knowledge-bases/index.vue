<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'

import KnowledgeBindPanel from '@/components/knowledge-bind-panel/knowledge-bind-panel.vue'
import { workbenchApi } from '@/api/client'
import type { WeknoraIntegrationStatus, WeknoraKnowledgeBaseSummary } from '@/types/domain'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const errorMessage = ref('')
const status = ref<WeknoraIntegrationStatus | null>(null)
const list = ref<WeknoraKnowledgeBaseSummary[]>([])

const bindFailed = computed(() => route.query.bind === 'failed')
const showUnconfigured = computed(() => status.value && !status.value.configured)
const showBind = computed(() => status.value?.configured && !status.value.linked)
const showList = computed(() => status.value?.configured && status.value.linked)

async function loadPage() {
  loading.value = true
  errorMessage.value = ''
  try {
    status.value = await workbenchApi.getWeknoraStatus()
    if (status.value.configured && status.value.linked) {
      const response = await workbenchApi.listWeknoraKnowledgeBases()
      list.value = response.list
    } else {
      list.value = []
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '知识库暂时无法加载'
  } finally {
    loading.value = false
  }
}

async function startBind() {
  const { url } = await workbenchApi.startWeknoraBind()
  window.location.assign(url)
}

function openKnowledgeBase(kbId: string) {
  void router.push(`/knowledge/${encodeURIComponent(kbId)}`)
}

onMounted(loadPage)
watch(() => route.query.bind, () => { if (route.path === '/knowledge') void loadPage() })
</script>

<template>
  <div class="knowledge-page">
    <header class="knowledge-page__header">
      <h1>知识库</h1>
    </header>

    <div v-if="loading" class="knowledge-page__loading" aria-busy="true">
      <el-skeleton :rows="4" animated />
    </div>

    <el-result
      v-else-if="errorMessage"
      icon="warning"
      title="知识库暂时无法加载"
      :sub-title="errorMessage"
    >
      <template #extra>
        <el-button :icon="Refresh" @click="loadPage">重试</el-button>
      </template>
    </el-result>

    <el-result
      v-else-if="showUnconfigured"
      icon="info"
      title="知识库尚未配置"
      sub-title="管理员配置 WeKnora 后即可在此查阅企业知识库。"
    />

    <KnowledgeBindPanel
      v-else-if="showBind"
      :directory-account="status!.directoryAccount === 'missing' ? 'missing' : 'none'"
      :bind-failed="bindFailed"
      @bind="startBind"
    />

    <div v-else-if="showList">
      <el-empty v-if="list.length === 0" description="还没有知识库" />
      <el-row v-else :gutter="16">
        <el-col v-for="item in list" :key="item.id" :xs="24" :sm="12" :md="8">
          <el-card shadow="hover" class="knowledge-card" @click="openKnowledgeBase(item.id)">
            <h2>{{ item.name }}</h2>
            <p v-if="item.description">{{ item.description }}</p>
          </el-card>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<style scoped>
.knowledge-page {
  padding: 24px;
}

.knowledge-page__header h1 {
  margin: 0 0 16px;
  font-size: var(--dsh-font-size-page-title);
}

.knowledge-card {
  cursor: pointer;
  margin-bottom: 16px;
}

.knowledge-card h2 {
  margin: 0 0 8px;
  font-size: var(--dsh-font-size-section);
}
</style>
