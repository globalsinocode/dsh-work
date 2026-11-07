<script setup lang="ts">
import { Iphone } from '@element-plus/icons-vue'
import { computed, nextTick, onMounted, ref } from 'vue'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { DingTalkSelfBinding } from '@/types/domain'

/**
 * 用户中心 › 钉钉（钉钉接入 DT-S1，原型④）：查看本人的钉钉绑定与解除。绑定只能在钉钉内登录或由管理员代绑。
 * 部署未配置钉钉、或 AI Hub 账号时不显示。
 */
const authStore = useAuthStore()
const view = ref<DingTalkSelfBinding>()
const error = ref('')
const flash = ref('')
const confirming = ref(false)
const busy = ref(false)
const section = ref<HTMLElement>()

const reasons: Record<string, string> = {
  admin_unbind: '管理员已解除绑定',
  self_unbind: '你已解除绑定',
  rebound_to_other: '已由管理员改绑到其他员工',
  departed: '钉钉中已不是企业成员',
  account_disabled: '账号曾被停用',
  admin_password_reset: '管理员重置了你的密码',
  corp_changed: '钉钉应用已换到其他企业，请重新绑定',
}
const visible = computed(() => Boolean(view.value && (view.value.enabled || view.value.status !== 'unbound')))
const account = computed(() => {
  const binding = view.value?.binding
  if (!binding) return ''
  return `${binding.dingtalkName ?? '未知姓名'}${binding.dingtalkDepartment ? `（${binding.dingtalkDepartment}）` : ''}`
})
const boundBy = computed(() => {
  const binding = view.value?.binding
  if (!binding) return ''
  return binding.boundBy === 'admin' ? `管理员${binding.boundByAdminName ?? ''}代为绑定` : '本人在钉钉内登录时绑定'
})

async function load() {
  try {
    view.value = await workbenchApi.getDingTalkBinding()
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '钉钉绑定加载失败'
  }
}

async function unbind() {
  busy.value = true
  try {
    const wasDingTalkSession = authStore.identityProvider === 'dingtalk'
    view.value = await workbenchApi.unbindDingTalk()
    confirming.value = false
    flash.value = '已解除绑定。'
    // 当前就是钉钉内的登录：会话已随解绑失效，回到登录页。
    if (wasDingTalkSession) window.location.assign('/login')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解除绑定失败'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await load()
  if (new URLSearchParams(window.location.search).get('section') === 'dingtalk') {
    await nextTick()
    section.value?.scrollIntoView?.({ block: 'start' })
  }
})
</script>

<template>
  <section v-if="visible || error" ref="section" class="panel settings-section dingtalk-settings" aria-label="钉钉">
    <div class="settings-section__heading">
      <span><el-icon><Iphone /></el-icon></span>
      <div><h2>钉钉</h2><p>绑定钉钉后，可以在钉钉中收到 dsh-work 的提醒，并在钉钉内打开 dsh-work 时无需登录。</p></div>
    </div>
    <div class="dingtalk-settings__body">
      <p v-if="error" role="alert" class="dingtalk-settings__error">{{ error }} <el-button link type="primary" @click="load">重试</el-button></p>
      <template v-else-if="view?.status === 'bound' && view.binding">
        <div class="dingtalk-settings__state"><el-tag type="success" effect="plain" disable-transitions>已绑定</el-tag><span>可接收钉钉提醒，可在钉钉内免登</span></div>
        <dl class="dingtalk-settings__facts">
          <dt>钉钉账号</dt><dd>{{ account }}</dd>
          <dt>绑定方式</dt><dd>{{ boundBy }}</dd>
          <dt>绑定时间</dt><dd>{{ new Date(view.binding.boundAt).toLocaleString('zh-CN', { hour12: false }) }}</dd>
        </dl>
        <p v-if="view.binding.boundBy === 'admin'" class="dingtalk-settings__warning">这是管理员为你绑定的钉钉账号。如果不是你本人的钉钉账号，请立即解除绑定并联系管理员。</p>
        <div><el-button @click="confirming = true">解除绑定</el-button></div>
      </template>
      <template v-else-if="view">
        <div class="dingtalk-settings__state">
          <el-tag :type="view.status === 'invalid' ? 'danger' : 'info'" effect="plain" disable-transitions>{{ view.status === 'invalid' ? '已失效' : '未绑定' }}</el-tag>
          <span>收不到钉钉提醒，在钉钉内打开需要登录</span>
        </div>
        <p v-if="view.status === 'invalid' && view.invalid?.reason && !view.selfRebindLocked" class="dingtalk-settings__muted">{{ reasons[view.invalid.reason] ?? '绑定已失效' }}</p>
        <p v-if="view.selfRebindLocked">管理员已暂停你的钉钉自行绑定。如需绑定，请联系管理员。</p>
        <template v-else>
          <h3>如何绑定</h3>
          <ol>
            <li>在手机或电脑上的钉钉中，进入“工作台”，打开 <strong>dsh-work</strong>；</li>
            <li>用你的 dsh-work 账号和密码登录一次；</li>
            <li>登录后自动绑定当前钉钉账号，之后在钉钉内打开无需再登录。</li>
          </ol>
          <p class="dingtalk-settings__muted">也可以请管理员为你代为绑定。</p>
        </template>
      </template>
      <p v-if="flash" role="status" class="dingtalk-settings__flash">{{ flash }}</p>
    </div>
    <el-dialog v-model="confirming" title="解除钉钉绑定？" width="min(440px, calc(100vw - 32px))" append-to-body>
      <p>解除后你将不再收到钉钉提醒，钉钉内的登录会立即失效。以后在钉钉内打开 dsh-work 并登录一次即可重新绑定。</p>
      <template #footer>
        <el-button :disabled="busy" @click="confirming = false">取消</el-button>
        <el-button type="danger" :loading="busy" @click="unbind">解除绑定</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.dingtalk-settings { margin-top: 20px; overflow: hidden; }
.settings-section__heading { display: flex; align-items: center; gap: 11px; padding: 16px 18px; border-bottom: 1px solid var(--dsh-color-border); }
.settings-section__heading > span { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: #315dc4; background: #edf3ff; }
.settings-section__heading h2 { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); }
.settings-section__heading p { margin: 4px 0 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); }
.dingtalk-settings__body { display: grid; gap: 12px; padding: 16px 18px 18px; font-size: var(--dsh-font-size-caption); color: #344054; line-height: 1.7; }
.dingtalk-settings__body p, .dingtalk-settings__body h3, .dingtalk-settings__body ol { margin: 0; }
.dingtalk-settings__body h3 { font-size: var(--dsh-font-size-body); color: var(--dsh-color-ink); }
.dingtalk-settings__body ol { padding-left: 20px; }
.dingtalk-settings__state { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.dingtalk-settings__facts { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
.dingtalk-settings__facts dt { color: var(--dsh-color-muted); }
.dingtalk-settings__facts dd { margin: 0; }
.dingtalk-settings__warning { padding: 10px 12px; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb; color: #92400e; }
.dingtalk-settings__muted { color: var(--dsh-color-muted); }
.dingtalk-settings__error { color: var(--dsh-color-danger, #b91c1c); }
.dingtalk-settings__flash { color: #15803d; }
</style>
