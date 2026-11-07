<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Notebook, Plus, Search } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import CreateKnowledgeBaseDialog from '@/components/knowledge/CreateKnowledgeBaseDialog.vue'
import PageHeader from '@/components/PageHeader.vue'
import { useKnowledgeStore } from '@/stores/knowledge'
import type { KnowledgeBase } from '@/types/knowledge'
import { formatKnowledgeDate } from '@/utils/knowledge'

/** 员工端“知识库”列表（weknora-knowledge-plan 第 8 节）：页头、工具栏与卡片和项目空间列表一致。 */
const router = useRouter()
const knowledge = useKnowledgeStore()
const bases = ref<KnowledgeBase[]>([])
const loading = ref(true)
const error = ref('')
const query = ref('')
const filter = ref<'all' | 'mine'>('all')
const createOpen = ref(false)

const filterOptions = [
  { id: 'all' as const, label: '全部' },
  { id: 'mine' as const, label: '可管理' },
]

const visibleBases = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return bases.value
    .filter(base => filter.value === 'all' || base.canManageDocuments)
    .filter(base => !keyword || `${base.name} ${base.ownerDepartmentName}`.toLowerCase().includes(keyword))
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    bases.value = await workbenchApi.listKnowledgeBases()
  } catch (cause) {
    bases.value = []
    error.value = cause instanceof Error ? cause.message : '知识库服务暂不可用，请稍后重试'
  } finally {
    loading.value = false
  }
}

function open(base: KnowledgeBase) {
  void router.push(`/knowledge/${base.id}`)
}

function onCreated(base: KnowledgeBase) {
  void router.push(`/knowledge/${base.id}`)
}

onMounted(() => {
  void knowledge.ensureLoaded()
  void load()
})
</script>

<template>
  <PageHeader title="知识库">
    <template #actions>
      <el-button v-if="knowledge.canCreate" type="primary" :icon="Plus" @click="createOpen = true">新建知识库</el-button>
    </template>
  </PageHeader>
  <div class="page-container page-container--wide knowledge-page">
    <div class="knowledge-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索知识库名称或归属部门" aria-label="搜索知识库名称或归属部门" />
      <div class="knowledge-filter" role="group" aria-label="知识库筛选">
        <button
          v-for="option in filterOptions"
          :key="option.id"
          class="knowledge-filter__item"
          :class="{ 'is-active': filter === option.id }"
          type="button"
          :aria-pressed="filter === option.id"
          @click="filter = option.id"
        >
          {{ option.label }}
        </button>
      </div>
      <span>{{ visibleBases.length }} 个可查看的知识库</span>
    </div>

    <div v-if="loading" class="knowledge-grid">
      <div v-for="index in 3" :key="index" class="knowledge-card panel knowledge-card--skeleton">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <el-empty v-else-if="error" :description="error">
      <el-button @click="load">重试</el-button>
    </el-empty>

    <div v-else-if="visibleBases.length" class="knowledge-grid">
      <button
        v-for="base in visibleBases"
        :key="base.id"
        class="knowledge-card panel"
        type="button"
        :aria-label="`打开知识库 ${base.name}`"
        @click="open(base)"
      >
        <div class="knowledge-card__top">
          <span class="knowledge-card__icon"><el-icon><Notebook /></el-icon></span>
          <span class="knowledge-card__tags">
            <StatusTag status="pending" label="知识库" />
            <StatusTag v-if="base.canManageDocuments" status="success" label="可管理" />
          </span>
        </div>
        <h2>{{ base.name }}</h2>
        <p>{{ base.description || '暂无说明' }}</p>
        <div class="knowledge-card__metrics">
          <div><strong>{{ base.documentCount }}</strong><span>文档</span></div>
          <div><strong>{{ base.processingCount }}</strong><span>解析中</span></div>
          <div><strong>{{ base.grants.length }}</strong><span>可见部门</span></div>
        </div>
        <div class="knowledge-card__footer">
          <span>归属 {{ base.ownerDepartmentName }}<template v-if="base.updatedAt"> · {{ formatKnowledgeDate(base.updatedAt) }}更新</template></span>
          <el-icon><ArrowRight /></el-icon>
        </div>
      </button>
    </div>

    <el-empty v-else-if="bases.length" description="没有匹配的知识库">
      <el-button @click="query = ''; filter = 'all'">清除筛选</el-button>
    </el-empty>

    <el-empty v-else description="还没有你可以查看的知识库">
      <p class="knowledge-empty-hint">知识库按部门授权。你还没有分配部门，或所属部门尚未被授予任何知识库，请联系平台管理员。</p>
    </el-empty>

    <CreateKnowledgeBaseDialog v-model="createOpen" @created="onCreated" />
  </div>
</template>

<style scoped>
.knowledge-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 17px;
}

.knowledge-toolbar .el-input {
  width: 290px;
}

.knowledge-filter {
  display: inline-flex;
  flex: 0 0 auto;
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

.knowledge-toolbar > span {
  margin-left: auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.knowledge-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
}

.knowledge-card {
  display: flex;
  min-height: 280px;
  flex-direction: column;
  padding: 20px;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}

.knowledge-card:hover {
  transform: translateY(-2px);
  border-color: #bdcae6;
  box-shadow: 0 12px 32px rgb(30 50 90 / 8%);
}

.knowledge-card--skeleton {
  cursor: default;
}

.knowledge-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.knowledge-card__tags {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.knowledge-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 11px;
  color: #315dc4;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.knowledge-card h2 {
  margin: 18px 0 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
}

.knowledge-card > p {
  min-height: 46px;
  margin: 8px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.65;
}

.knowledge-card__metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 20px;
  padding: 13px 0;
  border-top: 1px solid #eef0f4;
  border-bottom: 1px solid #eef0f4;
}

.knowledge-card__metrics div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-right: 1px solid #edf0f4;
  text-align: center;
}

.knowledge-card__metrics div:last-child {
  border-right: 0;
}

.knowledge-card__metrics strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-subheading);
}

.knowledge-card__metrics span {
  margin-top: 3px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-micro);
}

.knowledge-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 17px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.knowledge-empty-hint {
  max-width: 420px;
  margin: 0 auto 8px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

@media (max-width: 1120px) {
  .knowledge-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .knowledge-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .knowledge-toolbar .el-input {
    width: 100%;
  }

  .knowledge-toolbar > span {
    margin-left: 0;
  }

  .knowledge-grid {
    grid-template-columns: 1fr;
  }
}
</style>
