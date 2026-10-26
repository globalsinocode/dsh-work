<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { workbenchApi } from '@/api/client'
import { User } from '@element-plus/icons-vue'

import ExternalConnections from '@/components/external-connections/external-connections.vue'
import { roleLabels, useAuthStore } from '@/stores/auth'
import type { McpUserGrantListItem } from '@/types/domain'

const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()
const policy = ref('')
const policyError = ref('')
const mcpGrants = ref<McpUserGrantListItem[]>([])
const mcpGrantsLoading = ref(false)
const mcpGrantBanner = ref('')

async function loadPolicy() {
  try { policy.value = (await workbenchApi.getContentPolicy()).notice; policyError.value = '' }
  catch { policyError.value = '暂时无法加载内容保留规则，请重试。' }
}

async function loadMcpGrants() {
  mcpGrantsLoading.value = true
  try {
    const page = await workbenchApi.listMcpGrants()
    mcpGrants.value = page.list
  } finally {
    mcpGrantsLoading.value = false
  }
}

async function authorizeMcp(connectorId: string) {
  const { authorizationUrl } = await workbenchApi.beginMcpGrantAuthorization(connectorId)
  window.location.assign(authorizationUrl)
}

async function revokeMcp(connectorId: string) {
  await workbenchApi.revokeMcpGrant(connectorId)
  await loadMcpGrants()
}

onMounted(async () => {
  void loadPolicy()
  await loadMcpGrants()
  const grant = typeof route.query.mcpGrant === 'string' ? route.query.mcpGrant : ''
  if (grant === 'connected') {
    mcpGrantBanner.value = ''
    await loadMcpGrants()
    const query = { ...route.query }
    delete query.mcpGrant
    void router.replace({ query })
  } else if (grant === 'failed') {
    mcpGrantBanner.value = '授权没有完成，请重试'
    const query = { ...route.query }
    delete query.mcpGrant
    void router.replace({ query })
  }
})
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
          <div><h2>企业身份</h2><p>{{ authStore.identityProvider === 'local-password' ? '账号由管理员开通和维护' : '身份由企业登录系统提供，不能在 dsh-work 中修改' }}</p></div>
        </div>
        <el-button v-if="authStore.identityProvider === 'local-password'" tag="a" href="/change-password" type="primary" link>修改密码</el-button>
        <dl class="identity-grid">
          <div><dt>姓名</dt><dd>{{ authStore.user.name }}</dd></div>
          <div><dt>员工编号</dt><dd class="mono">{{ authStore.user.id }}</dd></div>
          <div><dt>部门</dt><dd>{{ authStore.user.department }}</dd></div>
          <div><dt>角色</dt><dd>{{ roleLabels[authStore.user.role] }}</dd></div>
          <div class="identity-grid__wide"><dt>数据范围</dt><dd>{{ authStore.user.dataScopes.join('、') }}</dd></div>
        </dl>
      </section>

      <ExternalConnections
        :items="mcpGrants"
        :loading="mcpGrantsLoading"
        :grant-error="mcpGrantBanner"
        :authorize="authorizeMcp"
        :revoke="revokeMcp"
        :reload="loadMcpGrants"
      />

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
