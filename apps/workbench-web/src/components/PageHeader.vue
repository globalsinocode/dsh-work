<script setup lang="ts">
defineProps<{ title: string }>()
</script>

<template>
  <!--
    员工端列表页统一的固定顶部区域：只放页面标题与主操作，不放副标题；
    吸顶占满内容区宽度，不进入左侧导航。外壳通过 CSS 变量告知顶部偏移
    （协作模式窄屏的固定顶栏）与起始让位（工作模式窄屏的菜单按钮）。
  -->
  <header class="page-topbar">
    <h1 class="page-topbar__title">{{ title }}</h1>
    <div v-if="$slots.actions" class="page-topbar__actions"><slot name="actions" /></div>
  </header>
</template>

<style scoped>
.page-topbar {
  position: sticky;
  z-index: 15;
  top: var(--dsh-page-topbar-offset, 0px);
  display: flex;
  min-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 32px 10px calc(32px + var(--dsh-page-topbar-inset-start, 0px));
  border-bottom: 1px solid var(--dsh-color-border);
  background: var(--dsh-color-panel);
}

.page-topbar__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-topbar__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.page-topbar__actions :deep(.el-button + .el-button) { margin-left: 0; }

@media (max-width: 960px) {
  .page-topbar { padding-right: 20px; padding-left: calc(20px + var(--dsh-page-topbar-inset-start, 0px)); }
}

@media (max-width: 640px) {
  .page-topbar { padding-right: 14px; padding-left: calc(14px + var(--dsh-page-topbar-inset-start, 0px)); }
}
</style>
