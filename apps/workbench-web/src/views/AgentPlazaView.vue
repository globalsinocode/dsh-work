<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChatDotRound, Refresh, UserFilled } from '@element-plus/icons-vue'

import AgentProfileDetail from '@/components/AgentProfileDetail.vue'
import { useContentStore } from '@/stores/content'
import type { WorkbenchAgent } from '@/types/domain'

const router = useRouter()
const contentStore = useContentStore()
const loading = ref(true)
const errorMessage = ref('')
const detailAgent = ref<WorkbenchAgent>()
const detailOpen = ref(false)

function startConversation(agent: WorkbenchAgent) {
  void router.push({ path: '/workbench', query: { agent: agent.id } })
}

function showDetails(agent: WorkbenchAgent) {
  detailAgent.value = agent
  detailOpen.value = true
}

async function loadAgents() {
  loading.value = true
  errorMessage.value = ''
  try {
    await contentStore.refreshAgents()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'AI 同事加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadAgents)
</script>

<template>
  <div class="agent-plaza-page">
    <nav class="agent-category-tabs" aria-label="AI 同事分类筛选">
      <button type="button" class="agent-category-tab is-active" aria-current="page">全部</button>
    </nav>

    <div v-if="loading" class="agent-card-grid" aria-label="正在加载 AI 同事">
      <div v-for="index in 6" :key="index" class="agent-card agent-card--skeleton">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <el-result
      v-else-if="errorMessage"
      class="agent-state"
      icon="warning"
      title="AI 同事暂时无法加载"
      :sub-title="errorMessage"
    >
      <template #extra>
        <el-button type="primary" :icon="Refresh" @click="loadAgents">重新加载</el-button>
      </template>
    </el-result>

    <el-empty v-else-if="!contentStore.agents.length" class="agent-state" description="当前没有可用的 AI 同事" />

    <div v-else class="agent-card-grid" aria-label="AI 同事列表">
      <article
        v-for="(agent, index) in contentStore.agents"
        :key="agent.id"
        class="agent-card"
      >
        <div class="agent-card__heading">
          <span class="agent-card__icon" :class="`agent-card__icon--${index % 4}`" aria-hidden="true">
            <el-icon><UserFilled /></el-icon>
          </span>
          <div class="agent-card__title">
            <h2>{{ agent.name }}</h2>
          </div>
          <button
            type="button"
            class="catalog-add-button"
            :aria-label="`与 AI 同事开始对话：${agent.name}`"
            @click="startConversation(agent)"
          >
            <el-icon><ChatDotRound /></el-icon>
            <span>去对话</span>
          </button>
        </div>
        <p class="agent-card__description">{{ agent.description }}</p>
        <div class="agent-card__footer">
          <span>AI 同事</span>
          <button type="button" class="agent-card__detail" @click="showDetails(agent)">查看详情</button>
        </div>
      </article>
    </div>

    <el-drawer v-model="detailOpen" title="AI 同事详情" size="min(440px, 92vw)">
      <AgentProfileDetail v-if="detailAgent" :agent="detailAgent">
        <template #actions>
          <el-button type="primary" @click="startConversation(detailAgent)">开始对话</el-button>
        </template>
      </AgentProfileDetail>
    </el-drawer>
  </div>
</template>

<style scoped>
.agent-plaza-page {
  min-height: 100vh;
  padding: 24px clamp(18px, 3vw, 44px) 48px;
  color: #282a29;
  background: #fff;
}

.agent-category-tabs {
  display: flex;
  gap: 4px;
  width: 100%;
  margin-bottom: 18px;
  overflow-x: auto;
}

.agent-category-tab {
  flex: 0 0 auto;
  padding: 8px 13px;
  border: 0;
  border-radius: 8px;
  color: #727672;
  background: transparent;
  font-size: var(--dsh-font-size-caption);
}

.agent-category-tab.is-active { color: #171817; background: #ededeb; font-weight: 650; }

.agent-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.agent-card {
  display: flex;
  min-height: 172px;
  flex-direction: column;
  padding: 20px;
  border: 1px solid #e8eae8;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 24px rgb(35 48 40 / 4%);
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}

.agent-card:hover { border-color: #c7e0d4; box-shadow: 0 12px 28px rgb(35 80 60 / 9%); transform: translateY(-2px); }
.agent-card--skeleton { min-height: 172px; }
.agent-card__heading { display: flex; align-items: center; gap: 10px; }
.agent-card__icon { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #245e4d; background: #dff3e9; font-size: var(--dsh-font-size-section); }
.agent-card__icon--1 { color: #385fa3; background: #e4ecfb; }
.agent-card__icon--2 { color: #9b5d1c; background: #faead8; }
.agent-card__icon--3 { color: #7854a6; background: #eee7f8; }
.agent-card__title { min-width: 0; flex: 1; }
.agent-card__title h2 { margin: 0; overflow: hidden; color: #222522; font-size: var(--dsh-font-size-body); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.catalog-add-button { display: inline-flex; min-width: 78px; height: 36px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 5px; padding: 0 10px; border: 0; border-radius: 9px; color: #242624; background: #f1f2f0; cursor: pointer; font-size: var(--dsh-font-size-caption); font-weight: 620; transition: background 140ms ease, transform 140ms ease; }
.catalog-add-button .el-icon { font-size: var(--dsh-font-size-body); }
.catalog-add-button:hover { background: #e4eee9; transform: scale(1.04); }
.catalog-add-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.agent-card__description { display: -webkit-box; min-height: 44px; margin: 15px 0 13px; overflow: hidden; color: #666c67; font-size: var(--dsh-font-size-caption); line-height: 1.65; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.agent-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; }
.agent-card__footer > span { padding: 3px 8px; border: 1px solid #e3e7e4; border-radius: 5px; color: #69716c; background: #f7f8f7; font-size: var(--dsh-font-size-badge); }
.agent-card__detail { padding: 0; border: 0; color: #6a746d; background: transparent; cursor: pointer; font-size: var(--dsh-font-size-caption); }
.agent-card__detail:hover { color: #17674f; }
.agent-state { min-height: 360px; }

@media (max-width: 1080px) { .agent-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 820px) { .agent-plaza-page { padding-top: 64px; } }
@media (max-width: 640px) {
  .agent-plaza-page { padding: 64px 13px 32px; }
  .agent-card-grid { grid-template-columns: 1fr; gap: 12px; }
  .agent-card { min-height: 168px; }
}
</style>
