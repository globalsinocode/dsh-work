<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import CollabShell from '@/layouts/CollabShell.vue'
import EmployeeShell from '@/layouts/EmployeeShell.vue'
import { locationForMode, routeMode } from '@/router/mode-routes'
import { useUiModeStore } from '@/stores/ui-mode'

const route = useRoute()
const router = useRouter()
const uiMode = useUiModeStore()
const publicRoute = computed(() => Boolean(route.meta.public))
const shellRoute = computed(() => route.matched.length > 0 && !publicRoute.value)
// 模式专属页始终放在所属模式的壳层里；切换模式后在地址换好之前不会出现“B 壳层套 A 页面”。
const shell = computed(() => routeMode(route) ?? uiMode.mode)

// 模式变化（logo 菜单切换，或后台核对出服务端偏好与本地缓存不同）时，当前页按 12.5 的
// 规则换到另一模式的对应地址；共用页保持原地址，只换壳层。
watch(() => uiMode.mode, (mode) => {
  if (!shellRoute.value) return
  const target = locationForMode(route, mode)
  if (target) void router.replace(target)
})
</script>

<template>
  <router-view v-if="publicRoute" />
  <template v-else-if="shellRoute">
    <CollabShell v-if="shell === 'collab'" />
    <EmployeeShell v-else />
  </template>
</template>
