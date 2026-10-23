<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Close, Search } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import CollabAvatar from '@/components/collab/CollabAvatar.vue'
import { useContentStore } from '@/stores/content'
import type { MemberCandidate, Workspace } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 创建项目空间 / 新建群组（A、B 共用，方案 12.8 #4）：至少选择一位 AI 同事，同事可一并选入。
 * 成员选择器：顶部一个搜索框，左侧“AI 同事 / 同事”两栏（栏标题全选当前显示的行），右侧“已选”。
 * 选了同事时提交前预览数据范围影响，与创建后邀请同事同一口径。
 */
const props = defineProps<{ modelValue: boolean; mode: 'work' | 'collab' }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [workspace: Workspace]
}>()

const PEOPLE_PAGE_SIZE = 30
const SEARCH_DEBOUNCE_MS = 250
const contentStore = useContentStore()
const name = ref('')
const description = ref('')
const selectedIds = ref<string[]>([])
const selectedPeople = ref<MemberCandidate[]>([])
const keyword = ref('')
const loadingAgents = ref(false)
const agentError = ref('')
const people = ref<MemberCandidate[]>([])
const peopleCursor = ref<string | null>(null)
const loadingPeople = ref(false)
const peopleError = ref('')
const submitting = ref(false)
let peopleRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
})
const noun = computed(() => (props.mode === 'collab' ? '群组' : '项目空间'))
const title = computed(() => (props.mode === 'collab' ? '新建群组' : '创建项目空间'))
const agents = computed(() => contentStore.agents)
const filteredAgents = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return agents.value
  return agents.value.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(text))
})
const selectedAgents = computed(() => selectedIds.value.flatMap(id => agents.value.find(agent => agent.id === id) ?? []))
const selectedPersonIds = computed(() => new Set(selectedPeople.value.map(person => person.id)))
const selectedCount = computed(() => selectedAgents.value.length + selectedPeople.value.length)
const trimmedName = computed(() => name.value.trim())
const nameValid = computed(() => trimmedName.value.length >= 2 && trimmedName.value.length <= 60)
const canSubmit = computed(() => nameValid.value && selectedIds.value.length > 0)
const showAgentHint = computed(() => selectedIds.value.length === 0 && !loadingAgents.value && !agentError.value && agents.value.length > 0)

/** 栏标题勾选框：作用于当前显示的行。 */
function columnState(ids: string[], isSelected: (id: string) => boolean) {
  const count = ids.filter(isSelected).length
  return { checked: ids.length > 0 && count === ids.length, indeterminate: count > 0 && count < ids.length }
}
const agentColumn = computed(() => columnState(filteredAgents.value.map(agent => agent.id), id => selectedIds.value.includes(id)))
const peopleColumn = computed(() => columnState(people.value.map(person => person.id), id => selectedPersonIds.value.has(id)))

function toggleAgent(id: string, checked: boolean) {
  const rest = selectedIds.value.filter(item => item !== id)
  selectedIds.value = checked ? [...rest, id] : rest
}
function toggleAllAgents(checked: boolean) {
  const shown = new Set(filteredAgents.value.map(agent => agent.id))
  const rest = selectedIds.value.filter(id => !shown.has(id))
  selectedIds.value = checked ? [...rest, ...shown] : rest
}
function togglePerson(person: MemberCandidate, checked: boolean) {
  const rest = selectedPeople.value.filter(item => item.id !== person.id)
  selectedPeople.value = checked ? [...rest, person] : rest
}
function toggleAllPeople(checked: boolean) {
  const shown = new Set(people.value.map(person => person.id))
  const rest = selectedPeople.value.filter(person => !shown.has(person.id))
  selectedPeople.value = checked ? [...rest, ...people.value] : rest
}

function resetForm() {
  name.value = ''
  description.value = ''
  selectedIds.value = []
  selectedPeople.value = []
  keyword.value = ''
}

async function loadAgents() {
  loadingAgents.value = true
  agentError.value = ''
  try {
    await contentStore.refreshAgents()
    if (agents.value.length === 1 && selectedIds.value.length === 0) {
      selectedIds.value = [agents.value[0]!.id]
    }
  } catch (cause) {
    agentError.value = cause instanceof Error ? cause.message : 'AI 同事加载失败'
  } finally {
    loadingAgents.value = false
  }
}

/** 同事候选按关键词在服务端检索并分页；`more` 为加载下一页。旧请求的结果丢弃。 */
async function loadPeople(more = false) {
  const request = ++peopleRequest
  loadingPeople.value = true
  peopleError.value = ''
  try {
    const page = await workbenchApi.listNewSpaceMemberCandidates({
      query: keyword.value.trim() || undefined,
      cursor: more ? peopleCursor.value ?? undefined : undefined,
      limit: PEOPLE_PAGE_SIZE,
    })
    if (request !== peopleRequest) return
    people.value = more ? [...people.value, ...page.items] : page.items
    peopleCursor.value = page.nextCursor
  } catch (cause) {
    if (request !== peopleRequest) return
    peopleError.value = cause instanceof Error ? cause.message : '同事加载失败'
  } finally {
    if (request === peopleRequest) loadingPeople.value = false
  }
}

watch(() => props.modelValue, open => {
  if (!open) return
  void loadAgents()
  void loadPeople()
}, { immediate: true })

watch(keyword, () => {
  if (!props.modelValue) return
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void loadPeople(), SEARCH_DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

/** 选了同事时先预览数据范围影响；有影响需确认，取消则不创建。 */
async function confirmDisclosureImpact(agentIds: string[], memberUserIds: string[]) {
  if (!memberUserIds.length) return true
  const impacts = await workbenchApi.previewNewSpaceDisclosureImpact({ agentIds, memberUserIds })
  if (!impacts.length) return true
  const lines = impacts.map(item => `“${item.name}”将不能再使用：${item.lostDataScopes.join('、')}`)
  try {
    await ElMessageBox.confirm(
      `Agent 在本${noun.value}只能使用全体成员共同拥有的数据范围。加入所选同事后：\n${lines.join('\n')}`,
      '加入后 Agent 的可用数据范围会缩小',
      { confirmButtonText: `仍然创建`, cancelButtonText: '返回修改', type: 'warning', customStyle: { whiteSpace: 'pre-line' } },
    )
    return true
  } catch {
    return false
  }
}

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const finalName = trimmedName.value
  const agentIds = [...selectedIds.value]
  const memberUserIds = selectedPeople.value.map(person => person.id)
  try {
    if (!(await confirmDisclosureImpact(agentIds, memberUserIds))) return
    const workspace = await contentStore.createTeamWorkspace({
      name: finalName,
      description: description.value.trim(),
      agentIds,
      memberUserIds,
    })
    ElMessage.success(`已创建${noun.value}“${finalName}”`)
    resetForm()
    visible.value = false
    emit('created', workspace)
  } catch (cause) {
    notifyActionFailure('创建', `${noun.value}“${finalName}”`, cause, '检查所选 AI 同事与同事是否仍可加入后重试。')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="min(880px, calc(100vw - 32px))" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item :label="`${noun}名称`" required>
        <el-input v-model="name" maxlength="60" show-word-limit :aria-label="`${noun}名称`" placeholder="例如：九月交付风险分析" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input
          v-model="description"
          type="textarea"
          :rows="2"
          maxlength="120"
          show-word-limit
          aria-label="说明"
          placeholder="说明这个项目的目标与范围"
        />
      </el-form-item>
      <el-form-item label="成员" required>
        <p class="create-space__helper">
          {{ noun }}至少需要一位 AI 同事；同事可现在选择，也可创建后在{{ mode === 'collab' ? '群信息' : '成员管理' }}中邀请。
        </p>
        <div class="member-picker">
          <div class="member-picker__main">
            <el-input
              v-model="keyword"
              class="member-picker__search"
              :prefix-icon="Search"
              aria-label="搜索 AI 同事或同事"
              placeholder="搜索"
              clearable
            />
            <div class="member-picker__columns">
              <section class="member-picker__column" aria-label="AI 同事">
                <el-checkbox
                  class="member-picker__head"
                  :model-value="agentColumn.checked"
                  :indeterminate="agentColumn.indeterminate"
                  :disabled="!filteredAgents.length"
                  aria-label="全选 AI 同事"
                  @change="(value: unknown) => toggleAllAgents(Boolean(value))"
                >
                  AI 同事<span class="member-picker__count">{{ filteredAgents.length }}</span>
                </el-checkbox>
                <el-alert v-if="agentError" type="error" :closable="false" show-icon :title="agentError">
                  <el-button link type="primary" @click="loadAgents">重试</el-button>
                </el-alert>
                <el-skeleton v-else-if="loadingAgents && !agents.length" :rows="3" animated />
                <p v-else-if="!agents.length" class="member-picker__empty">没有可用的 AI 同事</p>
                <p v-else-if="!filteredAgents.length" class="member-picker__empty">没有匹配的 AI 同事</p>
                <ul v-else class="member-picker__list">
                  <li v-for="agent in filteredAgents" :key="agent.id">
                    <el-checkbox
                      class="member-picker__row"
                      :model-value="selectedIds.includes(agent.id)"
                      @change="(value: unknown) => toggleAgent(agent.id, Boolean(value))"
                    >
                      <CollabAvatar kind="agent" :size="36" />
                      <span class="member-picker__copy">
                        <strong>{{ agent.name }}</strong>
                        <small>{{ agent.description }}</small>
                      </span>
                    </el-checkbox>
                  </li>
                </ul>
              </section>
              <section class="member-picker__column" aria-label="同事">
                <el-checkbox
                  class="member-picker__head"
                  :model-value="peopleColumn.checked"
                  :indeterminate="peopleColumn.indeterminate"
                  :disabled="!people.length"
                  aria-label="全选同事"
                  @change="(value: unknown) => toggleAllPeople(Boolean(value))"
                >
                  同事<span class="member-picker__count">{{ people.length }}{{ peopleCursor ? '+' : '' }}</span>
                </el-checkbox>
                <el-alert v-if="peopleError" type="error" :closable="false" show-icon :title="peopleError">
                  <el-button link type="primary" @click="loadPeople()">重试</el-button>
                </el-alert>
                <el-skeleton v-else-if="loadingPeople && !people.length" :rows="3" animated />
                <p v-else-if="!people.length" class="member-picker__empty">{{ keyword.trim() ? '没有匹配的同事' : '没有可选择的同事' }}</p>
                <ul v-else class="member-picker__list">
                  <li v-for="person in people" :key="person.id">
                    <el-checkbox
                      class="member-picker__row"
                      :model-value="selectedPersonIds.has(person.id)"
                      @change="(value: unknown) => togglePerson(person, Boolean(value))"
                    >
                      <CollabAvatar kind="person" :names="[person.displayName]" :size="36" />
                      <span class="member-picker__copy">
                        <strong>{{ person.displayName }}</strong>
                        <small>{{ person.department }}</small>
                      </span>
                    </el-checkbox>
                  </li>
                  <li v-if="peopleCursor" class="member-picker__more">
                    <el-button link type="primary" :loading="loadingPeople" @click="loadPeople(true)">加载更多</el-button>
                  </li>
                </ul>
              </section>
            </div>
          </div>
          <aside class="member-picker__selected" aria-label="已选成员">
            <h3>已选 {{ selectedCount }}</h3>
            <ul v-if="selectedCount" class="member-picker__chosen">
              <li v-for="agent in selectedAgents" :key="`agent-${agent.id}`">
                <CollabAvatar kind="agent" :size="28" />
                <span class="member-picker__chosen-name">{{ agent.name }}</span>
                <el-button link :icon="Close" :aria-label="`移除 ${agent.name}`" @click="toggleAgent(agent.id, false)" />
              </li>
              <li v-for="person in selectedPeople" :key="`person-${person.id}`">
                <CollabAvatar kind="person" :names="[person.displayName]" :size="28" />
                <span class="member-picker__chosen-name">{{ person.displayName }}</span>
                <el-button link :icon="Close" :aria-label="`移除 ${person.displayName}`" @click="togglePerson(person, false)" />
              </li>
            </ul>
            <p v-else class="member-picker__empty">从左侧勾选 AI 同事与同事</p>
          </aside>
        </div>
        <p v-if="showAgentHint" class="create-space__hint" role="alert">至少选择一位 AI 同事</p>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">
        {{ mode === 'collab' ? '创建群组' : '创建项目空间' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.create-space__helper { width: 100%; margin: 0 0 8px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); line-height: 1.5; }
.create-space__hint { margin: 6px 0 0; color: var(--dsh-color-danger, var(--el-color-danger)); font-size: var(--dsh-font-size-caption); }

.member-picker {
  display: grid; width: 100%; grid-template-columns: minmax(0, 2fr) minmax(200px, 1fr);
  overflow: hidden; border: 1px solid var(--dsh-color-border); border-radius: 16px;
}
.member-picker__main { display: flex; min-width: 0; flex-direction: column; gap: 12px; padding: 12px; }
.member-picker__search :deep(.el-input__wrapper) { border-radius: 999px; }
/* 固定高度：搜索或勾选导致行数变化时弹窗不跳动。 */
.member-picker__columns { display: grid; height: 300px; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); }
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
  .member-picker { grid-template-columns: minmax(0, 1fr); }
  .member-picker__columns { height: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: none; gap: 12px; }
  .member-picker__column { padding: 0; }
  .member-picker__column + .member-picker__column { padding-top: 12px; border-top: 1px solid var(--dsh-color-border); border-left: 0; }
  .member-picker__list { flex: none; max-height: 220px; }
  .member-picker__selected { max-height: 240px; border-top: 1px solid var(--dsh-color-border); border-left: 0; }
}
</style>
