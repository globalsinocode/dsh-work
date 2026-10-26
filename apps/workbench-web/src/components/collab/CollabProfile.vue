<script setup lang="ts">
/**
 * 协作模式目录页的详情（原型：居中的大头像、名称、副标题、说明与圆角操作按钮，下方为
 * 信息卡片）。AI 同事与群组共用；头像、操作与额外卡片由插槽提供。
 */
defineProps<{
  name: string
  sub?: string
  description?: string
  facts: Array<{ label: string; value: string }>
}>()
</script>

<template>
  <div class="collab-profile">
    <div class="collab-profile__head">
      <slot name="avatar" />
      <h2 class="collab-profile__name">{{ name }}</h2>
      <span v-if="sub" class="collab-profile__sub">{{ sub }}</span>
      <p v-if="description" class="collab-profile__desc">{{ description }}</p>
      <div v-if="$slots.actions" class="collab-profile__actions"><slot name="actions" /></div>
    </div>
    <dl v-if="facts.length" class="collab-profile__facts">
      <template v-for="fact in facts" :key="fact.label">
        <dt>{{ fact.label }}</dt>
        <dd>{{ fact.value }}</dd>
      </template>
    </dl>
    <slot />
  </div>
</template>

<style scoped>
.collab-profile { display: flex; width: 100%; max-width: 640px; flex-direction: column; gap: 24px; }
.collab-profile__head { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
.collab-profile__name { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-heading); }
.collab-profile__sub { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.collab-profile__desc { max-width: 520px; margin: 0; color: var(--dsh-color-text); font-size: var(--dsh-font-size-body); line-height: 1.7; white-space: pre-line; }
.collab-profile__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 4px; }
.collab-profile__actions :deep(.el-button) { height: 42px; margin: 0; padding: 0 24px; border-radius: 21px; font-size: var(--dsh-font-size-title); }
.collab-profile__facts {
  display: grid; margin: 0; padding: 18px 20px; grid-template-columns: 96px minmax(0, 1fr); row-gap: 12px; column-gap: 12px;
  border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-lg); background: var(--dsh-color-panel);
  font-size: var(--dsh-font-size-body);
}
.collab-profile__facts dt { color: var(--dsh-color-muted); }
.collab-profile__facts dd { min-width: 0; margin: 0; color: var(--dsh-color-ink); overflow-wrap: anywhere; }
.collab-profile :deep(.collab-profile__card) {
  display: flex; flex-direction: column; gap: 10px; padding: 18px 20px;
  border: 1px solid var(--dsh-color-border); border-radius: var(--dsh-radius-lg); background: var(--dsh-color-panel);
}
.collab-profile :deep(.collab-profile__card h3) { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-title); }

@media (max-width: 820px) {
  .collab-profile__facts { grid-template-columns: 80px minmax(0, 1fr); padding: 14px 16px; }
}
</style>
