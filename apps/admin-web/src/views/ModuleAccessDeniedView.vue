<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'
import { ADMIN_MODULE_LABELS, type AdminModule } from '@/utils/admin-modules'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const moduleLabel = computed(() => {
  const owner = String(route.query.module ?? '')
  if (owner === 'audit') return '审计'
  return ADMIN_MODULE_LABELS[owner as AdminModule] ?? ''
})
const landing = computed(() => authStore.landingRoute())
const landingTitle = computed(() => String(router.resolve(landing.value).meta.title ?? '管理后台'))
</script>

<template>
  <section class="module-denied">
    <el-result icon="warning" :title="moduleLabel ? `无权访问“${moduleLabel}”` : '无权访问此页面'">
      <template #sub-title>
        <p class="module-denied__text">
          这个页面属于“{{ moduleLabel || '其他' }}”模块，你的账号没有查看权限。如需使用，请联系有“修改员工与权限”权限的管理员为你的角色加上对应模块的权限。
        </p>
      </template>
      <template #extra>
        <el-button type="primary" @click="router.replace(landing)">返回{{ landingTitle }}</el-button>
      </template>
    </el-result>
  </section>
</template>

<style scoped>
.module-denied { display: grid; min-height: 420px; place-items: center; padding: 24px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.module-denied__text { max-width: 560px; margin: 0; color: var(--color-text-secondary); line-height: 22px; }
</style>
