<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { workbenchApi } from '@/api/client'
import { User } from '@element-plus/icons-vue'

import { roleLabels, useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const policy = ref('')
const policyError = ref('')
async function loadPolicy() {
  try { policy.value = (await workbenchApi.getContentPolicy()).notice; policyError.value = '' }
  catch { policyError.value = '暂时无法加载内容保留规则，请重试。' }
}
onMounted(() => { void loadPolicy() })
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

    </div>
  </div>
</template>

<style scoped>
.retention-notice { margin-top: 20px; padding: 20px; }
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
