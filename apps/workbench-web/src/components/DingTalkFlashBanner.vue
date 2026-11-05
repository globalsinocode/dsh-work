<script setup lang="ts">
import { ref } from 'vue'

import { takeDingTalkFlash } from '@/container/dingtalk'

/** 钉钉内登录后的一次性提示（原型③首页横幅）：已绑定 / 改密并绑定 / 本次未绑定。 */
const flash = ref(takeDingTalkFlash())
const copy = {
  bound: '已绑定钉钉账号，之后在钉钉内打开无需再登录。',
  bound_after_change: '密码已修改，并已绑定钉钉账号。',
  not_bound: '本次未绑定钉钉：不会收到钉钉提醒，下次在钉钉内打开仍需登录。',
} as const
</script>

<template>
  <div v-if="flash" class="dingtalk-flash" :class="{ 'dingtalk-flash--warning': flash === 'not_bound' }" role="status">
    <span>{{ copy[flash] }}</span>
    <button type="button" aria-label="关闭提示" @click="flash = null">×</button>
  </div>
</template>

<style scoped>
.dingtalk-flash {
  /* 浮在页面上方，不改变各页的整屏布局；宽屏让出协作模式侧栏，窄屏在顶栏之下。 */
  position: fixed; z-index: 30; top: 12px; left: calc(var(--collab-rail-width, 0px) + 12px); right: 12px;
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 10px 12px;
  border-radius: 10px; background: #f0fdf4; color: #166534; font-size: var(--dsh-font-size-caption); line-height: 1.5;
  box-shadow: 0 4px 16px rgb(15 23 42 / 12%);
}
@media (max-width: 820px) { .dingtalk-flash { top: 60px; left: 12px; } }
.dingtalk-flash--warning { background: #fffbeb; color: #92400e; }
.dingtalk-flash button { min-width: 32px; min-height: 32px; border: 0; background: none; color: inherit; font-size: var(--dsh-font-size-subheading); line-height: 1; cursor: pointer; }
</style>
