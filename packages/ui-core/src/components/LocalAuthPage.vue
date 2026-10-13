<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowRight, OfficeBuilding } from '@element-plus/icons-vue'
import AppLogo from './AppLogo.vue'

const props = defineProps<{ audience: 'admin' | 'workbench'; changePassword?: boolean }>()
const username = ref('')
const password = ref('')
const newPassword = ref('')
const confirmation = ref('')
const loading = ref(true)
const saving = ref(false)
const redirectingToAiHub = ref(false)
const busy = computed(() => saving.value || redirectingToAiHub.value)
const error = ref('')
const ready = ref(false)
const localEnabled = ref(false)
const aiHubEnabled = ref(false)
const parameters = new URLSearchParams(window.location.search)
const returnTo = (() => {
  const fallback = props.audience === 'admin' ? '/overview' : '/workbench'
  try {
    const target = new URL(parameters.get('return_to') ?? fallback, window.location.origin)
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : fallback
  } catch { return fallback }
})()
const loginLink = `/login?return_to=${encodeURIComponent(returnTo)}`

async function initialize() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`/auth/${props.audience}/configuration`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('暂时无法加载登录配置，请重试')
    const configuration = await response.json() as { mode: string; localEnabled?: boolean; aiHubEnabled?: boolean }
    if (!['prototype', 'local', 'oidc'].includes(configuration.mode)) throw new Error('登录配置无效，请联系管理员')
    if (configuration.mode === 'prototype') {
      window.location.replace(props.audience === 'admin' ? '/overview' : '/workbench')
      return
    }
    localEnabled.value = configuration.localEnabled ?? configuration.mode === 'local'
    aiHubEnabled.value = configuration.aiHubEnabled ?? configuration.mode === 'oidc'
    ready.value = true
    if (parameters.get('auth_error') === 'ai_hub_unavailable') error.value = 'AI Hub 暂不可用，请稍后重试或使用账号密码登录。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录服务暂不可用'
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (busy.value || !ready.value || !localEnabled.value) return
  error.value = ''
  if (props.changePassword && newPassword.value !== confirmation.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  if (props.changePassword && ([...newPassword.value].length < 8 || [...newPassword.value].length > 12)) {
    error.value = '新密码需为 8–12 个字符'
    return
  }
  saving.value = true
  try {
    const response = await fetch(`/auth/${props.audience}/${props.changePassword ? 'password' : 'login'}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(props.changePassword
        ? { currentPassword: password.value, newPassword: newPassword.value, returnTo }
        : { username: username.value, password: password.value, returnTo }),
    })
    const result = await response.json() as { location?: string; error?: { message?: string } }
    if (!response.ok) throw new Error(result.error?.message ?? '登录服务暂不可用，请重试')
    const location = new URL(result.location ?? '/login', window.location.origin)
    if (location.origin !== window.location.origin) throw new Error('登录返回地址无效')
    window.location.assign(location.toString())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试'
  } finally {
    password.value = ''
    newPassword.value = ''
    confirmation.value = ''
    saving.value = false
  }
}

function loginWithAiHub() {
  if (!ready.value || busy.value) return
  password.value = ''
  if (!aiHubEnabled.value) {
    error.value = 'AI Hub 登录尚未启用，请使用账号密码登录，或联系管理员。'
    return
  }
  error.value = ''
  redirectingToAiHub.value = true
  const action = parameters.get('switch_account') === 'true' ? 'switch-account' : 'login'
  window.location.assign(`/auth/${props.audience}/oidc/${action}?return_to=${encodeURIComponent(returnTo)}`)
}

onMounted(() => void initialize())
</script>

<template>
  <main class="local-auth-page">
    <div class="local-auth-layout">
    <section v-loading="loading" class="local-auth-card" :aria-busy="loading || busy">
      <AppLogo class="local-auth-logo" dark />
      <header>
        <h1>{{ changePassword ? '修改密码' : audience === 'admin' ? '登录运营平台' : '登录员工工作台' }}</h1>
        <p class="local-auth-description">{{ changePassword ? '设置仅自己知道的密码，保存后直接进入系统。' : '使用管理员为你开通的账号登录。' }}</p>
      </header>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
      <el-button v-if="!loading && !ready" @click="initialize">重试</el-button>
      <template v-if="ready">
      <el-alert v-if="!localEnabled" title="账号密码登录尚未启用，请联系管理员或使用 AI Hub 账号登录。" type="info" :closable="false" show-icon />
      <el-form label-position="top" class="local-auth-form" @submit.prevent="submit">
        <el-form-item v-if="!changePassword" label="登录账号" for="local-username">
          <el-input id="local-username" v-model="username" placeholder="请输入登录账号" autocomplete="username" autocapitalize="none" :maxlength="254" required :disabled="busy || !localEnabled" />
        </el-form-item>
        <el-form-item :label="changePassword ? '当前密码' : '密码'" for="local-password">
          <el-input id="local-password" v-model="password" :placeholder="changePassword ? '请输入当前密码' : '请输入密码'" type="password" show-password autocomplete="current-password" :maxlength="128" required :disabled="busy || !localEnabled" />
        </el-form-item>
        <template v-if="changePassword">
          <el-form-item label="新密码" for="local-new-password">
            <el-input id="local-new-password" v-model="newPassword" type="password" show-password autocomplete="new-password" :minlength="8" :maxlength="12" required :disabled="saving" />
          </el-form-item>
          <p class="local-auth-hint">密码长度为 8–12 个字符。</p>
          <el-form-item label="确认新密码" for="local-confirm-password">
            <el-input id="local-confirm-password" v-model="confirmation" type="password" show-password autocomplete="new-password" :minlength="8" :maxlength="12" required :disabled="saving" />
          </el-form-item>
        </template>
        <el-button class="local-auth-submit" type="primary" native-type="submit" :loading="saving" :disabled="busy || !localEnabled">{{ saving ? '正在提交…' : changePassword ? '保存新密码' : '登录' }}</el-button>
      </el-form>
      <p class="local-auth-hint local-auth-help">{{ changePassword ? '所有设备上的旧登录会话将失效。' : '没有账号或忘记密码？请联系管理员' }}</p>
      <template v-if="!changePassword && aiHubEnabled">
        <div class="local-auth-divider">其他登录方式</div>
        <el-button class="local-auth-secondary" :disabled="busy" :loading="redirectingToAiHub" @click="loginWithAiHub"><el-icon v-if="!redirectingToAiHub"><OfficeBuilding /></el-icon><span>{{ redirectingToAiHub ? '正在前往 AI Hub…' : '使用 AI Hub 账号登录' }}</span><el-icon v-if="!redirectingToAiHub"><ArrowRight /></el-icon></el-button>
      </template>
      <a v-if="changePassword" class="local-auth-back" :href="loginLink">返回登录</a>
      </template>
    </section>
    <footer class="local-auth-footer">dsh-work · 企业 Agent 工作空间</footer>
    </div>
  </main>
</template>

<style scoped>
:global(body:has(.local-auth-page)) { min-width: 320px; }
.local-auth-page { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--dsh-color-canvas); }
.local-auth-layout { width: 100%; max-width: 440px; }
.local-auth-card { display: grid; gap: 20px; width: 100%; padding: 32px; background: var(--dsh-color-panel); border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-lg); box-shadow: var(--dsh-shadow-panel); }
.local-auth-logo { margin-bottom: 12px; }
h1 { margin: 0; font-size: var(--dsh-font-size-page-title); font-weight: 650; letter-spacing: -.02em; line-height: 1.4; color: var(--dsh-color-ink); }
.local-auth-description, .local-auth-hint { margin: 0; line-height: 1.6; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-body); }
.local-auth-description { margin-top: 8px; }
.local-auth-form :deep(.el-form-item) { margin-bottom: 20px; }
.local-auth-form :deep(.el-form-item__label) { color: var(--dsh-color-ink); }
.local-auth-form :deep(.el-input__wrapper) { min-height: 44px; padding: 0 13px; }
.local-auth-hint { font-size: var(--dsh-font-size-caption); }
.local-auth-form > .local-auth-hint { margin: -8px 0 16px; }
.local-auth-help { margin-top: -4px; text-align: center; }
.local-auth-submit, .local-auth-secondary { width: 100%; min-height: 44px; margin: 0; }
.local-auth-submit :deep(span), .local-auth-secondary :deep(span) { display: inline-flex; gap: 8px; align-items: center; justify-content: center; }
.local-auth-divider { display: flex; align-items: center; gap: 14px; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); margin-top: 6px; }
.local-auth-divider::before, .local-auth-divider::after { content: ''; height: 1px; flex: 1; background: var(--dsh-color-border); }
.local-auth-back { color: var(--dsh-color-brand); text-align: center; }
.local-auth-footer { margin-top: 24px; text-align: center; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
@media (max-width: 480px) { .local-auth-page { padding: 24px 16px; } .local-auth-card { padding: 24px; } .local-auth-form :deep(.el-input__inner) { font-size: var(--dsh-font-size-subheading); } }
</style>
