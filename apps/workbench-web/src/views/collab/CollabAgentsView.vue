<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AgentProfileDetail from '@/components/AgentProfileDetail.vue'
import CollabDirectoryLayout from '@/components/collab/CollabDirectoryLayout.vue'
import { useContentStore } from '@/stores/content'

/** 协作模式「AI 同事」页（D25）：左目录 + 右详情，详情内容与 A 的 AI 同事广场共用。 */
const route = useRoute()
const router = useRouter()
const contentStore = useContentStore()
const loading = ref(true)
const errorMessage = ref('')
const keyword = ref('')

const selectedId = computed(() => {
  const raw = route.params.agentId
  return typeof raw === 'string' ? raw : ''
})
const selectedAgent = computed(() => contentStore.agents.find(agent => agent.id === selectedId.value))
const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return contentStore.agents
  return contentStore.agents.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(text))
})

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    await contentStore.refreshAgents()
  } catch (cause) {
    errorMessage.value = cause instanceof Error ? cause.message : 'AI 同事加载失败'
  } finally {
    loading.value = false
  }
}

function select(agentId: string) {
  void router.push({ name: 'collab-agent', params: { agentId } })
}
function back() {
  void router.push({ name: 'collab-agents' })
}
function chat(agentId: string) {
  void router.push({ name: 'collab-agent-chat', params: { agentId } })
}

onMounted(load)
</script>

<template>
  <CollabDirectoryLayout
    v-model:keyword="keyword"
    title="AI 同事"
    list-label="AI 同事"
    search-label="搜索 AI 同事"
    search-placeholder="搜索"
    :selected="!!selectedAgent"
    @back="back"
  >
    <template #status>
      <el-skeleton v-if="loading && !contentStore.agents.length" :rows="4" animated />
      <el-alert v-else-if="errorMessage" type="error" :closable="false" show-icon :title="errorMessage">
        <el-button link type="primary" @click="load">重试</el-button>
      </el-alert>
      <p v-else-if="!contentStore.agents.length" class="dir-status">没有可用的 AI 同事</p>
      <p v-else-if="!filtered.length" class="dir-status">没有匹配的 AI 同事</p>
    </template>
    <template v-if="filtered.length" #items>
      <li v-for="agent in filtered" :key="agent.id">
        <button
          type="button"
          class="dir-row"
          :aria-current="agent.id === selectedId ? 'page' : undefined"
          @click="select(agent.id)"
        >
          <span class="dir-row__avatar" aria-hidden="true">{{ agent.name.slice(0, 1) }}</span>
          <span class="dir-row__main">
            <span class="dir-row__name">{{ agent.name }}</span>
            <span class="dir-row__sub">{{ agent.description }}</span>
          </span>
        </button>
      </li>
    </template>

    <AgentProfileDetail v-if="selectedAgent" :agent="selectedAgent">
      <template #actions>
        <el-button type="primary" @click="chat(selectedAgent.id)">发消息</el-button>
      </template>
    </AgentProfileDetail>
  </CollabDirectoryLayout>
</template>
