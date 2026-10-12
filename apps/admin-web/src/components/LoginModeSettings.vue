<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { LoginSettings } from '@/types/domain'

const auth = useAuthStore()
const settings = ref<LoginSettings>()
const selectedMode = ref<'local' | 'oidc'>('local')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const requiresRefresh = ref(false)
const modeNames = { local: '独立账号密码', oidc: 'AI Hub 统一登录', prototype: '原型身份' }
const selectedOption = computed(() => settings.value?.options.find(option => option.mode === selectedMode.value))
const dirty = computed(() => selectedMode.value !== (settings.value?.savedMode ?? settings.value?.activeMode))
const canSave = computed(() => dirty.value && selectedOption.value?.available && !requiresRefresh.value && !loading.value && !saving.value)

function apply(next: LoginSettings) {
  settings.value = next
  selectedMode.value = next.savedMode ?? (next.activeMode === 'oidc' ? 'oidc' : 'local')
  requiresRefresh.value = false
}

async function load() {
  loading.value = true
  error.value = ''
  try { apply(await adminApi.getLoginSettings()) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '登录设置加载失败，请重试' }
  finally { loading.value = false }
}

async function save() {
  if (!auth.canManageIdentity || !canSave.value || !settings.value) return
  const mode = selectedMode.value
  const revision = settings.value.revision
  const cancelling = mode === settings.value.activeMode
  const confirmed = await ElMessageBox.confirm(
    cancelling
      ? `保存后将继续使用${modeNames[mode]}，取消待生效的切换。`
      : `重启应用后将改用${modeNames[mode]}，员工端与管理端的所有用户都需重新登录。请确认目标模式下已有可登录的平台管理员。`,
    cancelling ? '取消登录模式切换' : '确认修改登录模式',
    { type: 'warning', confirmButtonText: '确认保存', cancelButtonText: '返回修改' },
  ).then(() => true).catch(() => false)
  if (!confirmed) return
  saving.value = true
  error.value = ''
  try {
    apply(await adminApi.saveLoginSettings(mode, revision))
    ElMessage.success(settings.value?.pendingRestart ? '登录设置已保存，重启应用后生效' : '已取消登录模式切换')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录设置保存失败'
    // Reconfirm from a fresh revision after any failure; never silently overwrite another administrator.
    requiresRefresh.value = true
  } finally { saving.value = false }
}

onMounted(() => void load())
</script>

<template>
  <section v-loading="loading" class="content-panel login-settings" aria-label="登录模式配置" :aria-busy="loading || saving">
    <div class="login-settings__heading">
      <div><h2>登录模式</h2><p>员工端与管理端使用同一种登录方式，账号权限继续由本平台管理。</p></div>
      <el-button :loading="loading" :disabled="saving" @click="load">刷新设置</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
    <template v-if="settings">
      <dl class="login-settings__status">
        <div><dt>当前生效</dt><dd>{{ modeNames[settings.activeMode] }}</dd></div>
        <div><dt>已保存</dt><dd>{{ settings.savedMode ? modeNames[settings.savedMode] : '使用部署默认值' }}</dd></div>
        <div><dt>生效状态</dt><dd><el-tag :type="settings.pendingRestart ? 'warning' : 'success'" effect="plain">{{ settings.pendingRestart ? '重启后生效' : '已生效' }}</el-tag></dd></div>
      </dl>
      <el-alert v-if="settings.pendingRestart" title="切换尚未生效；请安排应用重启。重启前可以选择当前模式并保存，取消切换。" type="warning" :closable="false" show-icon />
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item v-if="auth.canManageIdentity" label="选择登录方式">
          <el-radio-group v-model="selectedMode" aria-label="选择登录方式" :disabled="saving || loading" class="login-settings__options">
            <article v-for="option in settings.options" :key="option.mode" class="login-settings__option">
              <el-radio :value="option.mode" :disabled="!option.available">{{ modeNames[option.mode] }}</el-radio>
              <p>{{ option.mode === 'local' ? '由管理员创建账号，员工使用账号和密码登录；关闭自助注册。' : '使用企业 AI Hub 身份登录，保留本平台的角色与数据范围。' }}</p>
              <ul v-if="option.issues.length" class="login-settings__issues"><li v-for="issue in option.issues" :key="issue">{{ issue }}</li></ul>
              <span v-else class="login-settings__ready">配置与管理员条件已具备</span>
            </article>
          </el-radio-group>
        </el-form-item>
        <p v-else class="login-settings__note">仅平台管理员可以修改登录模式。</p>
        <p class="login-settings__note">保存后重启生效。切换前请确认目标登录方式可用；应用不会自动重启。上游凭据与入口地址由部署环境维护，此处不会显示密钥。</p>
        <div v-if="auth.canManageIdentity" class="login-settings__actions"><el-button type="primary" native-type="submit" :loading="saving" :disabled="!canSave">保存登录模式</el-button></div>
      </el-form>
    </template>
  </section>
</template>

<style scoped>
.login-settings { display: grid; gap: var(--spacing-section); width: 100%; }
.login-settings__heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--spacing-section); }
.login-settings__heading h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.login-settings__heading p, .login-settings__option p, .login-settings__note { margin: calc(var(--spacing-card) / 2) 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
.login-settings__status { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-section); margin: 0; }
.login-settings__status dt { color: var(--color-text-muted); font-size: var(--font-size-caption); }
.login-settings__status dd { margin: calc(var(--spacing-card) / 2) 0 0; color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.login-settings__options { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-section); }
.login-settings__option { padding: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.login-settings__issues { margin: calc(var(--spacing-card) / 2) 0 0; padding-left: var(--spacing-card); color: var(--color-warning-strong); font-size: var(--font-size-caption); line-height: 1.6; overflow-wrap: anywhere; }
.login-settings__ready { color: var(--color-success-strong); font-size: var(--font-size-caption); }
.login-settings__actions { display: flex; justify-content: flex-end; margin-top: var(--spacing-section); }
@media (max-width: 960px) { .login-settings__options { grid-template-columns: 1fr; } }
</style>
