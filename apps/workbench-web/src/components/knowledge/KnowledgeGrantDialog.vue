<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { StatusTag } from '@dsh-work/ui-core'
import { workbenchApi } from '@/api/client'
import type { KnowledgeBase, KnowledgeDepartmentOption } from '@/types/knowledge'
import { notifyActionFailure } from '@/utils/feedback'
import { describeKnowledgeGrants } from '@/utils/knowledge'

/**
 * 管理可见部门（weknora-knowledge-plan 5.4，WK11）：员工只能授给自己直接所属的部门，不能撤销平台管理员
 * 的授权，也不能撤到没有任何授权；授给其他部门或全公司由平台管理员在管理端操作。
 */
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ base: KnowledgeBase }>()
const emit = defineEmits<{ changed: [base: KnowledgeBase] }>()

const departments = ref<KnowledgeDepartmentOption[]>([])
const departmentId = ref('')
const includeDescendants = ref(true)
const busy = ref(false)

const grantedIds = computed(() => new Set(props.base.grants.map(grant => grant.departmentId)))
const candidates = computed(() => departments.value.filter(item => !grantedIds.value.has(item.id)))
const summary = computed(() => describeKnowledgeGrants(props.base.grants))

watch(open, async value => {
  if (!value) return
  includeDescendants.value = true
  try {
    departments.value = await workbenchApi.listKnowledgeDepartments()
  } catch {
    departments.value = []
  }
  departmentId.value = candidates.value[0]?.id ?? ''
})

async function add() {
  if (!departmentId.value) return
  busy.value = true
  try {
    const updated = await workbenchApi.addKnowledgeGrant(props.base.id, { departmentId: departmentId.value, includeDescendants: includeDescendants.value })
    emit('changed', updated)
    ElMessage.success('已添加可见部门')
    departmentId.value = candidates.value[0]?.id ?? ''
  } catch (cause) {
    notifyActionFailure('添加可见部门', props.base.name, cause, '只能授给你所属的部门。')
  } finally {
    busy.value = false
  }
}

async function revoke(grantId: string, name: string) {
  busy.value = true
  try {
    emit('changed', await workbenchApi.revokeKnowledgeGrant(props.base.id, grantId))
    ElMessage.success(`已撤销${name}`)
  } catch (cause) {
    notifyActionFailure('撤销可见部门', props.base.name, cause, '至少保留一个可见部门。')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dialog v-model="open" title="可见部门" width="520px" append-to-body>
    <p class="grant-dialog__hint">你只能授给自己所属的部门；授给其他部门或全公司请联系平台管理员。</p>
    <ul class="grant-dialog__list">
      <li v-for="grant in base.grants" :key="grant.id">
        <span class="grant-dialog__name">{{ grant.departmentName }}<em v-if="grant.includeDescendants && grant.departmentName !== '全公司'">（含下级）</em></span>
        <StatusTag :status="grant.grantedVia === 'admin' ? 'pending' : 'running'" :label="grant.grantedVia === 'admin' ? '管理员授予' : '员工授予'" />
        <el-button
          v-if="grant.grantedVia === 'employee' && base.grants.length > 1"
          link
          type="danger"
          :disabled="busy"
          :aria-label="`撤销${grant.departmentName}`"
          @click="revoke(grant.id, grant.departmentName)"
        >
          撤销
        </el-button>
        <span v-else class="grant-dialog__locked">{{ grant.grantedVia === 'admin' ? '只读' : '至少保留一个' }}</span>
      </li>
    </ul>
    <div v-if="candidates.length" class="grant-dialog__add">
      <el-select v-model="departmentId" aria-label="添加部门" placeholder="选择你所属的部门">
        <el-option v-for="department in candidates" :key="department.id" :value="department.id" :label="department.name" />
      </el-select>
      <el-checkbox v-model="includeDescendants">包含下级</el-checkbox>
      <el-button :disabled="!departmentId || busy" @click="add">添加</el-button>
    </div>
    <div class="grant-dialog__summary">当前可见部门：<strong>{{ summary }}</strong></div>
    <template #footer>
      <el-button type="primary" @click="open = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.grant-dialog__hint {
  margin: 0 0 12px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.grant-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.grant-dialog__list li {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid var(--dsh-color-border);
  border-radius: 10px;
}

.grant-dialog__name {
  flex: 1;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
}

.grant-dialog__name em {
  color: var(--dsh-color-muted);
  font-style: normal;
}

.grant-dialog__locked {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.grant-dialog__add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.grant-dialog__add .el-select {
  flex: 1 1 200px;
}

.grant-dialog__summary {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--dsh-color-canvas);
  color: var(--dsh-color-text);
  font-size: var(--dsh-font-size-caption);
}
</style>
