<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import { workbenchApi } from '@/api/client'
import { urlBase64ToUint8Array } from '@/utils/system-notification-client'

const props = defineProps<{
  enabled: boolean
}>()

const pushEnabled = ref(false)
const pushHint = ref('')
const pushLoading = ref(false)
const collabUnread = ref(true)
const runFinished = ref(true)
const prefsLoading = ref(false)

const pushSwitchDisabled = computed(() => pushLoading.value || pushHint.value === '通知服务暂不可用')

async function loadPreferences() {
  prefsLoading.value = true
  try {
    const prefs = await workbenchApi.getNotificationPreferences()
    collabUnread.value = prefs.collabUnread
    runFinished.value = prefs.runFinished
  } finally {
    prefsLoading.value = false
  }
}

async function refreshPushAvailability() {
  if (!props.enabled) return
  pushLoading.value = true
  pushHint.value = ''
  try {
    const config = await workbenchApi.getPushConfig()
    pushHint.value = ''
    if (!config?.vapidPublicKey) {
      pushHint.value = '通知服务暂不可用'
      pushEnabled.value = false
      return
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      pushEnabled.value = false
      pushHint.value = '当前浏览器不支持系统通知'
      return
    }
    if (Notification.permission === 'granted') {
      pushEnabled.value = true
      await syncSubscription(config.vapidPublicKey)
    } else if (Notification.permission === 'denied') {
      pushEnabled.value = false
      pushHint.value = '请在系统设置中允许通知'
    } else {
      pushEnabled.value = false
    }
  } catch (cause) {
    pushEnabled.value = false
    pushHint.value = cause instanceof Error && cause.message.includes('暂不可用')
      ? '通知服务暂不可用'
      : '暂时无法读取通知配置'
  } finally {
    pushLoading.value = false
  }
}

async function syncSubscription(vapidPublicKey: string) {
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
  }
  await workbenchApi.savePushSubscription(subscription.toJSON())
}

async function unregisterPush() {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    await workbenchApi.deletePushSubscription({ endpoint: subscription.endpoint })
    await subscription.unsubscribe()
  }
}

async function onPushToggle(next: boolean) {
  if (!props.enabled || pushSwitchDisabled.value) return
  pushLoading.value = true
  try {
    if (next) {
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        pushEnabled.value = false
        pushHint.value = permission === 'denied' ? '请在系统设置中允许通知' : ''
        return
      }
      const config = await workbenchApi.getPushConfig()
      await syncSubscription(config.vapidPublicKey)
      pushEnabled.value = true
      pushHint.value = ''
    } else {
      await unregisterPush()
      pushEnabled.value = false
    }
  } catch (cause) {
    pushEnabled.value = false
    ElMessage.error(cause instanceof Error ? cause.message : '通知订阅更新失败')
  } finally {
    pushLoading.value = false
  }
}

async function patchPreference(field: 'collabUnread' | 'runFinished', value: boolean) {
  prefsLoading.value = true
  try {
    const updated = await workbenchApi.patchNotificationPreferences({ [field]: value })
    collabUnread.value = updated.collabUnread
    runFinished.value = updated.runFinished
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '偏好保存失败')
  } finally {
    prefsLoading.value = false
  }
}

watch(() => props.enabled, (value) => {
  if (value) {
    void loadPreferences()
    void refreshPushAvailability()
  }
}, { immediate: true })
</script>

<template>
  <section v-if="enabled" class="panel settings-section notification-settings">
    <h2>系统通知</h2>
    <p class="notification-settings__intro">
      协作新消息与任务结果可在页面顶部条或浏览器系统通知中提醒；偏好按账号保存，Push 订阅按本机浏览器保存。
    </p>
    <div class="notification-settings__row">
      <div>
        <strong>系统通知</strong>
        <p v-if="pushHint" class="notification-settings__hint">{{ pushHint }}</p>
      </div>
      <el-switch
        :model-value="pushEnabled"
        :disabled="pushSwitchDisabled"
        :loading="pushLoading"
        @change="onPushToggle"
      />
    </div>
    <div class="notification-settings__row">
      <div><strong>协作新消息</strong></div>
      <el-switch
        :model-value="collabUnread"
        :disabled="prefsLoading"
        @change="(value: boolean) => patchPreference('collabUnread', value)"
      />
    </div>
    <div class="notification-settings__row">
      <div><strong>任务完成提醒</strong></div>
      <el-switch
        :model-value="runFinished"
        :disabled="prefsLoading"
        @change="(value: boolean) => patchPreference('runFinished', value)"
      />
    </div>
  </section>
</template>

<style scoped>
.notification-settings {
  margin-top: 20px;
  padding: 20px;
}

.notification-settings__intro {
  margin: 8px 0 16px;
  color: #5c5f5b;
  font-size: 14px;
}

.notification-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid #ececea;
}

.notification-settings__hint {
  margin: 4px 0 0;
  color: #9a6b2f;
  font-size: 13px;
}
</style>
