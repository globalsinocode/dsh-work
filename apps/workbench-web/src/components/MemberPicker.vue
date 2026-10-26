<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Close, Search } from '@element-plus/icons-vue'

import CollabAvatar from '@/components/collab/CollabAvatar.vue'

/** 选择器里的一行：AI 同事或同事。 */
export interface MemberPickerItem {
  id: string
  name: string
  description: string
}

export interface MemberPickerPage {
  items: MemberPickerItem[]
  nextCursor: string | null
}

export type MemberPickerLoader = (input: { query?: string; cursor?: string }) => Promise<MemberPickerPage>

/**
 * 成员选择器（新建群组 / 创建项目空间与群组“添加成员”共用）：顶部一个搜索框，左侧“AI 同事 / 同事”
 * 两栏（栏标题全选当前显示的行），右侧“已选”列表可逐个移除。两栏数据都由上层的加载函数按关键词
 * 与游标提供，选择器只负责展示与选择；`showAgents` 为 false 时只显示同事一栏。
 */
const props = withDefaults(defineProps<{
  loadAgents: MemberPickerLoader
  loadPeople: MemberPickerLoader
  showAgents?: boolean
  /** 打开时为 true：每次打开重新加载两栏。 */
  active: boolean
}>(), { showAgents: true })
const emit = defineEmits<{ 'agents-loaded': [items: MemberPickerItem[]] }>()
const selectedAgents = defineModel<MemberPickerItem[]>('agents', { default: () => [] })
const selectedPeople = defineModel<MemberPickerItem[]>('people', { default: () => [] })

const SEARCH_DEBOUNCE_MS = 250
const keyword = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined

/** 一栏的加载状态；旧请求的结果丢弃。 */
function useColumn(load: () => MemberPickerLoader) {
  const items = ref<MemberPickerItem[]>([])
  const cursor = ref<string | null>(null)
  const loading = ref(false)
  const error = ref('')
  let request = 0
  async function fetch(more = false) {
    const current = ++request
    loading.value = true
    error.value = ''
    try {
      const page = await load()({
        query: keyword.value.trim() || undefined,
        cursor: more ? cursor.value ?? undefined : undefined,
      })
      if (current !== request) return
      items.value = more ? [...items.value, ...page.items] : page.items
      cursor.value = page.nextCursor
    } catch (cause) {
      if (current !== request) return
      error.value = cause instanceof Error ? cause.message : '加载失败'
    } finally {
      if (current === request) loading.value = false
    }
  }
  return { items, cursor, loading, error, fetch }
}

const agents = useColumn(() => props.loadAgents)
const people = useColumn(() => props.loadPeople)

const agentIds = computed(() => new Set(selectedAgents.value.map(item => item.id)))
const personIds = computed(() => new Set(selectedPeople.value.map(item => item.id)))
const selectedCount = computed(() => (props.showAgents ? selectedAgents.value.length : 0) + selectedPeople.value.length)

/** 栏标题勾选框：作用于当前显示的行。 */
function columnState(items: MemberPickerItem[], selected: Set<string>) {
  const count = items.filter(item => selected.has(item.id)).length
  return { checked: items.length > 0 && count === items.length, indeterminate: count > 0 && count < items.length }
}
const agentColumn = computed(() => columnState(agents.items.value, agentIds.value))
const peopleColumn = computed(() => columnState(people.items.value, personIds.value))

type Column = 'agents' | 'people'
const models = { agents: selectedAgents, people: selectedPeople }

function toggle(column: Column, item: MemberPickerItem, checked: boolean) {
  const model = models[column]
  const rest = model.value.filter(entry => entry.id !== item.id)
  model.value = checked ? [...rest, item] : rest
}
function toggleAll(column: Column, shown: MemberPickerItem[], checked: boolean) {
  const model = models[column]
  const ids = new Set(shown.map(item => item.id))
  const rest = model.value.filter(entry => !ids.has(entry.id))
  model.value = checked ? [...rest, ...shown] : rest
}

async function loadAll() {
  await Promise.all([props.showAgents ? agents.fetch() : Promise.resolve(), people.fetch()])
  if (props.showAgents && !agents.error.value) emit('agents-loaded', agents.items.value)
}

watch(() => props.active, active => {
  if (!active) return
  keyword.value = ''
  void loadAll()
}, { immediate: true })

watch(keyword, () => {
  if (!props.active) return
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (props.showAgents) void agents.fetch()
    void people.fetch()
  }, SEARCH_DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(searchTimer))
</script>

<template>
  <div class="member-picker" :class="{ 'member-picker--people-only': !showAgents }">
    <div class="member-picker__main">
      <el-input
        v-model="keyword"
        class="member-picker__search"
        :prefix-icon="Search"
        :aria-label="showAgents ? '搜索 AI 同事或同事' : '搜索同事'"
        placeholder="搜索"
        clearable
      />
      <div class="member-picker__columns">
        <section v-if="showAgents" class="member-picker__column" aria-label="AI 同事">
          <el-checkbox
            class="member-picker__head"
            :model-value="agentColumn.checked"
            :indeterminate="agentColumn.indeterminate"
            :disabled="!agents.items.value.length"
            aria-label="全选 AI 同事"
            @change="(value: unknown) => toggleAll('agents', agents.items.value, Boolean(value))"
          >
            AI 同事<span class="member-picker__count">{{ agents.items.value.length }}{{ agents.cursor.value ? '+' : '' }}</span>
          </el-checkbox>
          <el-alert v-if="agents.error.value" type="error" :closable="false" show-icon :title="agents.error.value">
            <el-button link type="primary" @click="agents.fetch()">重试</el-button>
          </el-alert>
          <el-skeleton v-else-if="agents.loading.value && !agents.items.value.length" :rows="3" animated />
          <p v-else-if="!agents.items.value.length" class="member-picker__empty">{{ keyword.trim() ? '没有匹配的 AI 同事' : '没有可选择的 AI 同事' }}</p>
          <ul v-else class="member-picker__list">
            <li v-for="item in agents.items.value" :key="item.id">
              <el-checkbox
                class="member-picker__row"
                :model-value="agentIds.has(item.id)"
                @change="(value: unknown) => toggle('agents', item, Boolean(value))"
              >
                <CollabAvatar kind="agent" :size="36" />
                <span class="member-picker__copy">
                  <strong>{{ item.name }}</strong>
                  <small>{{ item.description }}</small>
                </span>
              </el-checkbox>
            </li>
            <li v-if="agents.cursor.value" class="member-picker__more">
              <el-button link type="primary" :loading="agents.loading.value" @click="agents.fetch(true)">加载更多</el-button>
            </li>
          </ul>
        </section>
        <section class="member-picker__column" aria-label="同事">
          <el-checkbox
            class="member-picker__head"
            :model-value="peopleColumn.checked"
            :indeterminate="peopleColumn.indeterminate"
            :disabled="!people.items.value.length"
            aria-label="全选同事"
            @change="(value: unknown) => toggleAll('people', people.items.value, Boolean(value))"
          >
            同事<span class="member-picker__count">{{ people.items.value.length }}{{ people.cursor.value ? '+' : '' }}</span>
          </el-checkbox>
          <el-alert v-if="people.error.value" type="error" :closable="false" show-icon :title="people.error.value">
            <el-button link type="primary" @click="people.fetch()">重试</el-button>
          </el-alert>
          <el-skeleton v-else-if="people.loading.value && !people.items.value.length" :rows="3" animated />
          <p v-else-if="!people.items.value.length" class="member-picker__empty">{{ keyword.trim() ? '没有匹配的同事' : '没有可选择的同事' }}</p>
          <ul v-else class="member-picker__list">
            <li v-for="item in people.items.value" :key="item.id">
              <el-checkbox
                class="member-picker__row"
                :model-value="personIds.has(item.id)"
                @change="(value: unknown) => toggle('people', item, Boolean(value))"
              >
                <CollabAvatar kind="person" :names="[item.name]" :size="36" />
                <span class="member-picker__copy">
                  <strong>{{ item.name }}</strong>
                  <small>{{ item.description }}</small>
                </span>
              </el-checkbox>
            </li>
            <li v-if="people.cursor.value" class="member-picker__more">
              <el-button link type="primary" :loading="people.loading.value" @click="people.fetch(true)">加载更多</el-button>
            </li>
          </ul>
        </section>
      </div>
    </div>
    <aside class="member-picker__selected" aria-label="已选成员">
      <h3>已选 {{ selectedCount }}</h3>
      <ul v-if="selectedCount" class="member-picker__chosen">
        <template v-if="showAgents">
          <li v-for="item in selectedAgents" :key="`agent-${item.id}`">
            <CollabAvatar kind="agent" :size="28" />
            <span class="member-picker__chosen-name">{{ item.name }}</span>
            <el-button link :icon="Close" :aria-label="`移除 ${item.name}`" @click="toggle('agents', item, false)" />
          </li>
        </template>
        <li v-for="item in selectedPeople" :key="`person-${item.id}`">
          <CollabAvatar kind="person" :names="[item.name]" :size="28" />
          <span class="member-picker__chosen-name">{{ item.name }}</span>
          <el-button link :icon="Close" :aria-label="`移除 ${item.name}`" @click="toggle('people', item, false)" />
        </li>
      </ul>
      <p v-else class="member-picker__empty">{{ showAgents ? '从左侧勾选 AI 同事与同事' : '从左侧勾选同事' }}</p>
    </aside>
  </div>
</template>

<style scoped>
.member-picker {
  display: grid; width: 100%; grid-template-columns: minmax(0, 2fr) minmax(200px, 1fr);
  overflow: hidden; border: 1px solid var(--dsh-color-border); border-radius: 16px;
}
.member-picker--people-only { grid-template-columns: minmax(0, 1.4fr) minmax(200px, 1fr); }
.member-picker__main { display: flex; min-width: 0; flex-direction: column; gap: 12px; padding: 12px; }
.member-picker__search :deep(.el-input__wrapper) { border-radius: 999px; }
/* 固定高度：搜索或勾选导致行数变化时弹窗不跳动。 */
.member-picker__columns { display: grid; height: 300px; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); }
.member-picker--people-only .member-picker__columns { grid-template-columns: minmax(0, 1fr); }
.member-picker__column { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: 4px; padding: 0 12px; }
.member-picker__column + .member-picker__column { border-left: 1px solid var(--dsh-color-border); }
.member-picker__head { height: 32px; margin: 0; }
.member-picker__head :deep(.el-checkbox__label) { color: var(--dsh-color-subtle); font-weight: 600; }
.member-picker__count { margin-left: 8px; color: var(--dsh-color-subtle); font-weight: 400; }
.member-picker__list { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 2px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.member-picker__row { display: flex; width: 100%; height: auto; margin: 0; padding: 6px 0; white-space: normal; }
.member-picker__row :deep(.el-checkbox__label) { display: flex; min-width: 0; flex: 1; align-items: center; gap: 10px; }
.member-picker__copy { display: flex; min-width: 0; flex-direction: column; line-height: 1.4; }
.member-picker__copy strong { overflow: hidden; color: var(--dsh-color-text); font-size: var(--dsh-font-size-body); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.member-picker__copy small { overflow: hidden; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.member-picker__more { padding: 4px 0; text-align: center; }
.member-picker__empty { margin: 8px 0; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); }
.member-picker__selected { display: flex; min-width: 0; min-height: 0; max-height: 368px; flex-direction: column; border-left: 1px solid var(--dsh-color-border); background: var(--dsh-color-canvas); }
.member-picker__selected h3 { margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--dsh-color-border); font-size: var(--dsh-font-size-body); font-weight: 600; }
.member-picker__selected > .member-picker__empty { padding: 0 16px; }
.member-picker__chosen { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 2px; margin: 0; padding: 8px; overflow: auto; list-style: none; }
.member-picker__chosen li { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 8px; line-height: 1.4; }
.member-picker__chosen-name { min-width: 0; flex: 1; overflow: hidden; font-size: var(--dsh-font-size-body); text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 720px) {
  .member-picker, .member-picker--people-only { grid-template-columns: minmax(0, 1fr); }
  .member-picker__columns { height: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: none; gap: 12px; }
  .member-picker__column { padding: 0; }
  .member-picker__column + .member-picker__column { padding-top: 12px; border-top: 1px solid var(--dsh-color-border); border-left: 0; }
  .member-picker__list { flex: none; max-height: 220px; }
  .member-picker__selected { max-height: 240px; border-top: 1px solid var(--dsh-color-border); border-left: 0; }
}
</style>
