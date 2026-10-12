<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const authStore = useAuthStore()
const errorCode = computed(() => typeof route.query.code === 'string' ? route.query.code : 'authentication_failed')
const accountBlocked = computed(() => ['business_user_required', 'permission_denied', 'initial_admin_not_authorized', 'account_disabled'].includes(errorCode.value))
const errorTitle = computed(() => accountBlocked.value ? '当前账号无法访问' : '登录失败')
const errorDescription = computed(() => ({
  business_user_required: '当前登录的是 AI Hub 平台管理账号，不能访问 dsh-work。请切换为业务员工账号。',
  access_denied: '你取消了授权，或 AI Hub 未允许该账号访问管理后台。',
  account_disabled: '该账号已停用，请联系平台管理员。',
  permission_denied: '当前业务员工账号尚未获得管理权限，请联系 dsh-work 管理员授权。',
  initial_admin_not_authorized: '当前账号尚未获得管理权限。首次初始化请使用 AI Hub 中登记的应用初始管理员业务账号；已有管理员时，请联系 dsh-work 管理员授权。',
  invalid_callback: '登录回调参数不完整，请重新发起登录。',
  invalid_state: '登录会话已过期或状态校验失败，请重新登录。',
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
