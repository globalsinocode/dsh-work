<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import type { WorkbenchPushPayload } from '@/utils/push-notification-payload'

const props = defineProps<{
  payload: WorkbenchPushPayload | null
}>()

const emit = defineEmits<{
  dismiss: []
}>()

const router = useRouter()
const visible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

watch(() => props.payload, (next) => {
  if (hideTimer) clearTimeout(hideTimer)
  if (!next) {
    visible.value = false
    return
  }
  visible.value = true
  hideTimer = setTimeout(() => {
    visible.value = false
    emit('dismiss')
  }, 4000)
}, { immediate: true })

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
})

function open() {
  if (!props.payload) return
  void router.push(props.payload.url)
  visible.value = false
  emit('dismiss')
}
</script>

<template>
  <Transition name="system-notification-banner">
    <button
      v-if="visible && payload"
      type="button"
      class="system-notification-banner"
      @click="open"
    >
      <strong class="system-notification-banner__title">{{ payload.title }}</strong>
      <span class="system-notification-banner__body">{{ payload.body }}</span>
    </button>
  </Transition>
</template>

<style scoped>
.system-notification-banner {
  position: fixed;
  z-index: 40;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 12px;
  right: 12px;
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid rgb(24 25 24 / 8%);
  border-radius: 14px;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 8px 28px rgb(24 25 24 / 12%);
  text-align: left;
  cursor: pointer;
  backdrop-filter: blur(10px);
}

.system-notification-banner__title {
  overflow: hidden;
  font-size: var(--dsh-font-size-body);
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-notification-banner__body {
  overflow: hidden;
  color: #5c5f5b;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-notification-banner-enter-active,
.system-notification-banner-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.system-notification-banner-enter-from,
.system-notification-banner-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (min-width: 901px) {
  .system-notification-banner {
    left: 50%;
    right: auto;
    width: min(420px, calc(100vw - 320px));
    translate: -50% 0;
  }
}
</style>
