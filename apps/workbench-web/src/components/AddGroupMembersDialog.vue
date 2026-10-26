<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type ElMessageBoxOptions } from 'element-plus'
import type { CSSProperties } from 'vue'

import { workbenchApi } from '@/api/client'
import MemberPicker, { type MemberPickerItem, type MemberPickerLoader } from '@/components/MemberPicker.vue'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 群组 / 项目空间“添加成员”：与新建群组同一个成员选择器。候选来自本空间（已加入的不出现）；
 * 添加 AI 同事只有负责人可以（`canAddAgents`），否则只显示同事一栏。添加同事前按全体所选同事
 * 预览数据范围影响（与单个添加同一口径），会缩小时先确认。逐个加入，部分失败时列出未加入的对象。
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  canAddAgents: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ added: [] }>()

const PAGE_SIZE = 30
const selectedAgents = ref<MemberPickerItem[]>([])
const selectedPeople = ref<MemberPickerItem[]>([])
const submitting = ref(false)

const selectedCount = computed(() => (props.canAddAgents ? selectedAgents.value.length : 0) + selectedPeople.value.length)

const loadAgents: MemberPickerLoader = async ({ query, cursor }) => {
  const page = await workbenchApi.listWorkspaceAgentCandidates(props.workspaceId, { query, cursor, limit: PAGE_SIZE })
  return {
    items: page.items.map(agent => ({ id: agent.agentId, name: agent.name, description: agent.description })),
    nextCursor: page.nextCursor,
  }
}

const loadPeople: MemberPickerLoader = async ({ query, cursor }) => {
  const page = await workbenchApi.listMemberCandidates(props.workspaceId, { query, cursor, limit: PAGE_SIZE })
  return {
    items: page.items.map(person => ({ id: person.id, name: person.displayName, description: person.department })),
    nextCursor: page.nextCursor,
  }
}

watch(open, value => {
  if (!value) return
  selectedAgents.value = []
  selectedPeople.value = []
})

/**
 * Agent 交付数据范围取全体成员交集：一次加入多位同事时，失去的范围等于各自预览失去范围的并集。
 * 有影响需确认，取消则不添加。
 */
async function confirmDisclosureImpact(userIds: string[]) {
  if (!userIds.length) return true
  const merged = new Map<string, { name: string; scopes: Set<string> }>()
  for (const userId of userIds) {
    for (const impact of await workbenchApi.previewMemberDisclosureImpact(props.workspaceId, userId)) {
      const entry = merged.get(impact.agentMemberId) ?? { name: impact.name, scopes: new Set<string>() }
      for (const scope of impact.lostDataScopes) entry.scopes.add(scope)
      merged.set(impact.agentMemberId, entry)
    }
  }
  if (!merged.size) return true
  const lines = [...merged.values()].map(item => `“${item.name}”将不能再使用：${[...item.scopes].join('、')}`)
  try {
    const confirmOptions: ElMessageBoxOptions = {
      confirmButtonText: '仍然添加',
      cancelButtonText: '返回修改',
      type: 'warning',
      customStyle: { whiteSpace: 'pre-line' } as CSSProperties,
    }
    await ElMessageBox.confirm(
      `Agent 在本空间只能使用全体成员共同拥有的数据范围。加入所选同事后：\n${lines.join('\n')}`,
      '加入后 Agent 的可用数据范围会缩小',
      confirmOptions,
    )
    return true
  } catch {
    return false
  }
}

async function submit() {
  if (!selectedCount.value || submitting.value) return
  submitting.value = true
  const agents = props.canAddAgents ? [...selectedAgents.value] : []
  const people = [...selectedPeople.value]
  try {
    if (!(await confirmDisclosureImpact(people.map(person => person.id)))) return
    const failed: string[] = []
    let firstError: unknown
    for (const agent of agents) {
      try {
        await workbenchApi.addWorkspaceAgentMember(props.workspaceId, { agentId: agent.id })
      } catch (cause) {
        failed.push(agent.name)
        firstError ??= cause
      }
    }
    for (const person of people) {
      try {
        await workbenchApi.addWorkspaceMember(props.workspaceId, { userId: person.id, role: 'member' })
      } catch (cause) {
        failed.push(person.name)
        firstError ??= cause
      }
    }
    const added = agents.length + people.length - failed.length
    if (added) emit('added')
    if (failed.length) {
      notifyActionFailure('添加成员', `“${failed.join('、')}”`, firstError, added ? `其余 ${added} 位已加入；确认未加入的成员仍可加入后重试。` : '确认所选成员仍可加入后重试。')
      // 已加入的从已选中去掉，只留下未加入的，便于重试。
      selectedAgents.value = selectedAgents.value.filter(item => failed.includes(item.name))
      selectedPeople.value = selectedPeople.value.filter(item => failed.includes(item.name))
      return
    }
    ElMessage.success(`已添加 ${added} 位成员`)
    open.value = false
  } catch (cause) {
    notifyActionFailure('添加成员', `“${props.workspaceName}”`, cause, '稍后重试。')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="open" title="添加成员" width="min(880px, calc(100vw - 32px))" append-to-body>
    <p class="add-members__helper">
      {{ canAddAgents ? '选择要加入的 AI 同事与同事；同事加入后角色为“成员”，可在管理成员中调整。' : '选择要加入的同事，加入后角色为“成员”。添加 AI 同事需要负责人操作。' }}
    </p>
    <MemberPicker
      v-model:agents="selectedAgents"
      v-model:people="selectedPeople"
      :active="open"
      :show-agents="canAddAgents"
      :load-agents="loadAgents"
      :load-people="loadPeople"
    />
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :disabled="!selectedCount" :loading="submitting" @click="submit">
        添加{{ selectedCount ? ` ${selectedCount} 位` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.add-members__helper { margin: 0 0 12px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); line-height: 1.5; }
</style>
