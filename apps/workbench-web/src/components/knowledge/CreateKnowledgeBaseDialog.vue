<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { workbenchApi } from '@/api/client'
import type { KnowledgeBase, KnowledgeDepartmentOption } from '@/types/knowledge'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 新建知识库（WK10）：归属部门只能在本人所属的部门中选择，默认主部门；可见范围默认授给归属部门并
 * 包含下级。确认前显示“将对哪些部门可见”，并提示权限不同的文档要放在不同的知识库里（第 3 节）。
 */
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ created: [base: KnowledgeBase] }>()

const departments = ref<KnowledgeDepartmentOption[]>([])
const loadingDepartments = ref(false)
const name = ref('')
const description = ref('')
const ownerDepartmentId = ref('')
const includeDescendants = ref(true)
const saving = ref(false)

const owner = computed(() => departments.value.find(item => item.id === ownerDepartmentId.value))
const visibleText = computed(() => owner.value ? `${owner.value.name}${includeDescendants.value ? '及其下级部门' : ''}` : '—')
const canSubmit = computed(() => Boolean(name.value.trim() && owner.value && !saving.value))

watch(open, async value => {
  if (!value) return
  name.value = ''
  description.value = ''
  includeDescendants.value = true
  loadingDepartments.value = true
  try {
    departments.value = await workbenchApi.listKnowledgeDepartments()
    ownerDepartmentId.value = departments.value.find(item => item.primary)?.id ?? departments.value[0]?.id ?? ''
  } catch (cause) {
    departments.value = []
    notifyActionFailure('读取部门', '新建知识库', cause, '请稍后重试。')
  } finally {
    loadingDepartments.value = false
  }
})

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  try {
    const created = await workbenchApi.createKnowledgeBase({
      name: name.value.trim(),
      description: description.value.trim(),
      ownerDepartmentId: ownerDepartmentId.value,
      includeDescendants: includeDescendants.value,
    })
    ElMessage.success('知识库已创建')
    open.value = false
    emit('created', created)
  } catch (cause) {
    notifyActionFailure('新建知识库', name.value.trim(), cause, '检查名称与归属部门后重试。')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="open" title="新建知识库" width="520px" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="名称" required>
        <el-input v-model="name" maxlength="60" show-word-limit placeholder="例如：计划组工作手册" />
      </el-form-item>
      <el-form-item label="说明（选填）">
        <el-input v-model="description" maxlength="200" placeholder="这个知识库放哪些文档" />
      </el-form-item>
      <el-form-item label="归属部门" required>
        <el-select v-model="ownerDepartmentId" :loading="loadingDepartments" placeholder="选择你所属的部门" style="width: 100%">
          <el-option
            v-for="department in departments"
            :key="department.id"
            :value="department.id"
            :label="department.primary ? `${department.name}（主部门）` : department.name"
          />
        </el-select>
      </el-form-item>
      <el-checkbox v-model="includeDescendants">包含所有下级部门</el-checkbox>
    </el-form>
    <div class="create-knowledge__notice" role="note">
      将对以下部门可见：<strong>{{ visibleText }}</strong><br>
      知识库只能整体授权：权限不同的文档请放在不同的知识库里。
    </div>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="saving" @click="submit">创建</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.create-knowledge__notice {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--dsh-color-warning-soft);
  color: #7a2e0e;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}
</style>
