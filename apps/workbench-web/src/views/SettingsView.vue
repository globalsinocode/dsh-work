<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { workbenchApi } from '@/api/client'
import { Notebook, User } from '@element-plus/icons-vue'
import type { ControlledMemoryConsent } from '@/types/domain'

import { roleLabels, useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const policy = ref('')
const policyError = ref('')
const memoryConsents = ref<ControlledMemoryConsent[]>([])
const memoryLoading = ref(false)
const memoryError = ref('')
async function loadPolicy() {
  try { policy.value = (await workbenchApi.getContentPolicy()).notice; policyError.value = '' }
  catch { policyError.value = '暂时无法加载内容保留规则，请重试。' }
}
async function loadMemoryConsents() {
  memoryLoading.value = true
  try {
    memoryConsents.value = await workbenchApi.listMemoryConsents()
    memoryError.value = ''
  } catch {
    memoryError.value = '暂时无法加载记忆授权，请重试。'
  } finally {
    memoryLoading.value = false
  }
}
async function withdrawConsent(consent: ControlledMemoryConsent) {
  await ElMessageBox.confirm(
    `撤回“${consent.title}”的授权？撤回后新的运行和等待中的恢复都不会再引用它，历史审核与引用记录仍会保留。`,
    '撤回记忆授权',
    { confirmButtonText: '撤回授权', cancelButtonText: '取消', type: 'warning' },
  )
  try {
    await workbenchApi.withdrawMemoryConsent(consent.id)
    ElMessage.success('记忆授权已撤回')
    await loadMemoryConsents()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : String(cause))
  }
}
function formatTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)) : '—'
}
const candidateStatusLabels: Record<ControlledMemoryConsent['candidateStatus'], string> = {
  pending: '待审核', approved: '已发布', rejected: '已拒绝', withdrawn: '已撤回',
}
const visibilityLabels: Record<ControlledMemoryConsent['visibility'], string> = {
  private: '仅本人', workspace: '当前工作空间', organization: '组织范围',
}
onMounted(() => { void loadPolicy(); void loadMemoryConsents() })
</script>

<template>
  <div class="page-container settings-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">用户中心</h1>
        <p class="page-description">查看企业身份和当前账号的数据使用范围。</p>
      </div>
    </header>

    <div class="settings-layout">
      <section class="panel settings-section">
        <div class="settings-section__heading">
          <span><el-icon><User /></el-icon></span>
          <div><h2>企业身份</h2><p>身份由企业登录系统提供，不能在 dsh-work 中修改</p></div>
        </div>
        <dl class="identity-grid">
          <div><dt>姓名</dt><dd>{{ authStore.user.name }}</dd></div>
          <div><dt>员工编号</dt><dd class="mono">{{ authStore.user.id }}</dd></div>
          <div><dt>部门</dt><dd>{{ authStore.user.department }}</dd></div>
          <div><dt>角色</dt><dd>{{ roleLabels[authStore.user.role] }}</dd></div>
          <div class="identity-grid__wide"><dt>数据范围</dt><dd>{{ authStore.user.dataScopes.join('、') }}</dd></div>
        </dl>
      </section>

      <section class="panel settings-section retention-notice">
        <h2>内容保留与账号停用</h2>
        <p v-if="policy">{{ policy }}</p>
        <p v-if="policyError" role="alert">{{ policyError }} <el-button @click="loadPolicy">重试</el-button></p>
        <p>默认仅本人在员工工作台访问个人内容；企业授权审计、运维和备份按公司规则执行，不因个人入口而豁免。</p>
      </section>

      <section class="panel settings-section memory-consents">
        <div class="settings-section__heading">
          <span><el-icon><Notebook /></el-icon></span>
          <div><h2>受控记忆授权</h2><p>管理你明确提交的稳定偏好和可复用经验</p></div>
        </div>
        <el-alert
          title="记忆候选经过管理员审核后才可使用，并始终作为非权威参考。撤回会立即阻止后续运行和恢复继续引用。"
          type="info"
          :closable="false"
          show-icon
        />
        <p v-if="memoryError" class="memory-error" role="alert">
          {{ memoryError }} <el-button link type="primary" @click="loadMemoryConsents">重试</el-button>
        </p>
        <el-table v-else v-loading="memoryLoading" :data="memoryConsents" empty-text="暂无记忆授权">
          <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
          <el-table-column label="范围" min-width="120"><template #default="{ row }">{{ visibilityLabels[row.visibility as ControlledMemoryConsent['visibility']] }}</template></el-table-column>
          <el-table-column label="候选状态" min-width="105"><template #default="{ row }">{{ candidateStatusLabels[row.candidateStatus as ControlledMemoryConsent['candidateStatus']] }}</template></el-table-column>
          <el-table-column label="可使用至" min-width="130"><template #default="{ row }">{{ formatTime(row.retentionUntil) }}</template></el-table-column>
          <el-table-column label="授权状态" min-width="105">
            <template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '有效' : '已撤回' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }"><el-button v-if="row.status === 'active'" link type="danger" @click="withdrawConsent(row)">撤回授权</el-button></template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.retention-notice { margin-top: 20px; padding: 20px; }
.memory-consents { margin-top: 20px; }
.memory-consents :deep(.el-alert) { margin: 16px 18px 0; width: auto; }
.memory-error { margin: 16px 18px; color: var(--dsh-color-danger); }
.settings-layout {
  display: block;
}

.settings-section {
  overflow: hidden;
}

.settings-section__heading {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--dsh-color-border);
}

.settings-section__heading > span {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: #315dc4;
  background: #edf3ff;
}

.settings-section__heading h2 {
  margin: 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
}

.settings-section__heading p {
  margin: 4px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.identity-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 24px;
  margin: 0;
  padding: 10px 18px 17px;
}

.identity-grid div {
  padding: 11px 0;
  border-bottom: 1px solid #eef0f4;
}

.identity-grid__wide {
  grid-column: 1 / -1;
}

.identity-grid dt {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.identity-grid dd {
  margin: 5px 0 0;
  color: #344054;
  font-size: var(--dsh-font-size-caption);
  font-weight: 590;
}

</style>
