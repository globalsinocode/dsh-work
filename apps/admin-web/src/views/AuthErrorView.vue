<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const authStore = useAuthStore()
const errorCode = computed(() => typeof route.query.code === 'string' ? route.query.code : 'authentication_failed')
const accountBlocked = computed(() => ['permission_denied', 'account_disabled'].includes(errorCode.value))
const errorTitle = computed(() => accountBlocked.value ? '当前账号无法访问' : '登录失败')
const errorDescription = computed(() => ({
  account_disabled: '该账号已停用，请联系平台管理员。',
  permission_denied: '当前业务员工账号尚未获得管理权限，请联系 dsh-work 管理员授权。',
  session_unavailable: '暂时无法校验登录会话，请稍后重试。',
}[errorCode.value] ?? '登录没有完成，请重新发起登录。'))
</script>

<template>
  <main class="auth-result-page">
    <el-result icon="error" :title="errorTitle" :sub-title="errorDescription">
      <template #extra>
        <template v-if="accountBlocked">
          <p>请重新验证登录身份，完成后返回当前应用。</p>
          <el-button type="primary" @click="authStore.switchAccount()">切换账号</el-button>
        </template>
        <el-button v-else type="primary" @click="authStore.login('/overview')">重新登录</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.auth-result-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: var(--color-bg-page); }
</style>
