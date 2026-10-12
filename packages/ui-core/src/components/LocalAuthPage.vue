<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLogo from './AppLogo.vue'

const props = defineProps<{ audience: 'admin' | 'workbench'; changePassword?: boolean }>()
const username = ref('')
const password = ref('')
const newPassword = ref('')
const confirmation = ref('')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const ready = ref(false)
const changed = new URLSearchParams(window.location.search).get('password_changed') === 'true'

async function initialize() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`/auth/${props.audience}/configuration`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('暂时无法加载登录配置，请重试')
    const configuration = await response.json() as { mode: string }
    if (configuration.mode !== 'local') {
      window.location.replace(configuration.mode === 'oidc' ? `/auth/${props.audience}/login` : props.audience === 'admin' ? '/overview' : '/workbench')
      return
    }
    ready.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录服务暂不可用'
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (saving.value) return
  error.value = ''
  if (props.changePassword && newPassword.value !== confirmation.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  saving.value = true
  try {
    const returnTo = new URLSearchParams(window.location.search).get('return_to') ?? (props.audience === 'admin' ? '/overview' : '/workbench')
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

onMounted(() => void initialize())
</script>

<template>
  <main class="local-auth-page">
    <section v-loading="loading" class="local-auth-card" :aria-busy="loading || saving">
      <AppLogo dark />
      <h1>{{ changePassword ? '修改密码' : audience === 'admin' ? '登录管理后台' : '登录员工工作台' }}</h1>
      <p class="local-auth-description">{{ changePassword ? '设置仅自己知道的密码。修改后需重新登录。' : '使用管理员为你开通的账号登录。' }}</p>
      <el-alert v-if="changed && !changePassword" title="密码已修改，请使用新密码登录" type="success" :closable="false" show-icon />
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
      <el-button v-if="!loading && !ready" @click="initialize">重试</el-button>
      <el-form v-if="ready" label-position="top" @submit.prevent="submit">
        <el-form-item v-if="!changePassword" label="登录账号" for="local-username">
          <el-input id="local-username" v-model="username" autocomplete="username" autocapitalize="none" :maxlength="80" required :disabled="saving" autofocus />
        </el-form-item>
        <el-form-item :label="changePassword ? '当前密码' : '密码'" for="local-password">
          <el-input id="local-password" v-model="password" type="password" show-password autocomplete="current-password" :maxlength="128" required :disabled="saving" />
        </el-form-item>
        <template v-if="changePassword">
          <el-form-item label="新密码" for="local-new-password">
            <el-input id="local-new-password" v-model="newPassword" type="password" show-password autocomplete="new-password" :minlength="15" :maxlength="128" required :disabled="saving" />
          </el-form-item>
          <p class="local-auth-hint">15–128 个字符，可使用便于记忆的长句。</p>
          <el-form-item label="确认新密码" for="local-confirm-password">
            <el-input id="local-confirm-password" v-model="confirmation" type="password" show-password autocomplete="new-password" :minlength="15" :maxlength="128" required :disabled="saving" />
          </el-form-item>
        </template>
        <el-button class="local-auth-submit" type="primary" native-type="submit" :loading="saving">{{ changePassword ? '保存新密码' : '登录' }}</el-button>
      </el-form>
      <p class="local-auth-hint">{{ changePassword ? '所有设备上的旧登录会话将失效。' : '没有账号或忘记密码？请联系管理员。' }}</p>
      <a v-if="changePassword" href="/login">返回登录</a>
    </section>
  </main>
</template>

<style scoped>
:global(body:has(.local-auth-page)) { min-width: 320px; }
.local-auth-page { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--dsh-color-canvas); }
.local-auth-card { display: grid; gap: 16px; width: 100%; max-width: 440px; padding: 32px; background: var(--dsh-color-panel); border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-lg); box-shadow: var(--dsh-shadow-panel); }
h1 { margin: 0; font-size: var(--dsh-font-size-page-title); color: var(--dsh-color-ink); }
.local-auth-description, .local-auth-hint { margin: 0; line-height: 1.6; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-body); }
.local-auth-hint { font-size: var(--dsh-font-size-caption); }
.local-auth-submit { width: 100%; }
@media (max-width: 480px) { .local-auth-page { padding: 16px; } .local-auth-card { padding: 24px; } }
</style>
