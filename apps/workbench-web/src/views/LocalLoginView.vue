<script setup lang="ts">
import { LocalAuthPage } from '@dsh-work/ui-core'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  isDingTalkContainer, keepBindingTicket, peekBindingTicket, requestDingTalkAuthCode,
  setDingTalkFlash, takeBindingTicket, type DingTalkFlash,
} from '@/container/dingtalk'

/**
 * 员工端登录与改密。在钉钉容器内先自动免登（钉钉接入方案 4.3）：有绑定直接进入，没有绑定时显示
 * 账号密码登录页并说明“登录后将绑定此钉钉账号”（4.2 方式一）。钉钉外与原来一致。
 */
const route = useRoute()
const changePassword = computed(() => route.path === '/change-password')
const inContainer = isDingTalkContainer()
const loggedOut = new URLSearchParams(window.location.search).get('logged_out') === '1'
const phase = ref<'checking' | 'form'>(inContainer && !changePassword.value && !loggedOut ? 'checking' : 'form')
const pending = ref<{ bindingToken: string; name: string | null; department: string | null } | null>(null)
const message = ref(inContainer && loggedOut ? '已退出登录。从钉钉工作台重新打开 dsh-work 时会再次自动登录。' : '')
const changeTicket = ref<string | null>(changePassword.value && inContainer ? peekBindingTicket() : null)
const returnTo = (() => {
  const value = new URLSearchParams(window.location.search).get('return_to') ?? '/workbench'
  try {
    const target = new URL(value, window.location.origin)
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : '/workbench'
  } catch { return '/workbench' }
})()

async function dingtalkLogin() {
  phase.value = 'checking'
  message.value = ''
  pending.value = null
  try {
    const configurationResponse = await fetch('/auth/workbench/configuration', { credentials: 'same-origin' })
    const configuration: { dingtalk?: { corpId: string } } = configurationResponse.ok ? await configurationResponse.json().catch(() => ({})) : {}
    // 部署未配置钉钉：照常显示账号密码登录。
    const corpId = configuration.dingtalk?.corpId
    if (!corpId) return
    const authCode = await requestDingTalkAuthCode(corpId)
    const response = await fetch('/auth/workbench/dingtalk/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authCode, returnTo }),
    })
    // 网关返回 HTML 错误页（502/504）时不显示原始解析错误。
    const result = await response.json().catch(() => ({})) as {
      status?: 'signed_in' | 'binding_required'; location?: string; bindingToken?: string
      dingtalkName?: string | null; dingtalkDepartment?: string | null; error?: { message?: string }
    }
    if (!response.ok) throw new Error(result.error?.message ?? '钉钉登录暂不可用，请使用账号密码登录')
    if (result.status === 'signed_in' && result.location) {
      const location = new URL(result.location, window.location.origin)
      if (location.origin === window.location.origin) {
        window.location.assign(location.toString())
        return
      }
    }
    if (result.status === 'binding_required' && result.bindingToken) {
      pending.value = { bindingToken: result.bindingToken, name: result.dingtalkName ?? null, department: result.dingtalkDepartment ?? null }
    }
  } catch (cause) {
    message.value = cause instanceof Error ? `${cause.message}。可以先用账号密码登录（本次不绑定钉钉）。` : '钉钉登录暂不可用'
  } finally {
    phase.value = 'form'
  }
}

function complete(result: { outcome: 'bound' | 'not_bound' | 'bound_after_change' | 'password_change'; location: string; ticket?: string }) {
  if (result.outcome === 'password_change') {
    if (result.ticket) keepBindingTicket(result.ticket)
  } else {
    if (changePassword.value) takeBindingTicket()
    setDingTalkFlash(result.outcome as DingTalkFlash)
  }
  window.location.assign(result.location)
}

onMounted(() => { if (phase.value === 'checking') void dingtalkLogin() })
</script>

<template>
  <main v-if="phase === 'checking'" class="dingtalk-checking" aria-busy="true">
    <p role="status">正在通过钉钉登录…</p>
  </main>
  <LocalAuthPage
    v-else
    :key="route.path"
    audience="workbench"
    :change-password="changePassword"
    :dingtalk="pending"
    :dingtalk-binding-token="changeTicket"
    :dingtalk-message="message"
    @dingtalk-complete="complete"
    @dingtalk-retry="dingtalkLogin"
  />
</template>

<style scoped>
.dingtalk-checking { min-height: 100dvh; display: grid; place-items: center; color: var(--dsh-color-muted); background: var(--dsh-color-canvas); }
</style>
