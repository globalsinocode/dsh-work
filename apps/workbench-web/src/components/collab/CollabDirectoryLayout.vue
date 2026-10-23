<script setup lang="ts">
/**
 * 协作模式目录页的共享两栏布局（D25：AI 同事页与群组页相同）。
 * 左栏：标题 + 可选筛选/操作 + 搜索 + 列表；右栏：选中项详情或空态。
 * 窄屏（≤820px）为「列表 → 详情」两级：选中后只显示详情，并提供“返回列表”。
 *
 * 行样式由本组件提供（`.dir-row` 系列，经 :deep 作用于插槽内容），两个页面不各写一套。
 */
defineProps<{
  title: string
  listLabel: string
  searchLabel: string
  searchPlaceholder?: string
  /** 是否已选中某项（决定窄屏显示详情还是列表）。 */
  selected: boolean
  emptyText?: string
}>()
const keyword = defineModel<string>('keyword', { default: '' })
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <div class="dir-layout" :class="{ 'is-detail': selected }">
    <section class="dir-layout__list" :aria-label="`${title}目录`">
      <header class="dir-layout__head">
        <h1 class="dir-layout__title">{{ title }}</h1>
        <slot name="action" />
      </header>
      <div v-if="$slots.filter" class="dir-layout__filter"><slot name="filter" /></div>
      <el-input v-model="keyword" class="dir-layout__search" type="search" :aria-label="searchLabel" :placeholder="searchPlaceholder ?? '搜索'" clearable />
      <div class="dir-layout__body">
        <slot name="status" />
        <ul v-if="$slots.items" class="dir-layout__rows" :aria-label="listLabel">
          <slot name="items" />
        </ul>
      </div>
    </section>

    <section class="dir-layout__detail" aria-label="详情">
      <el-button class="dir-layout__back" link aria-label="返回列表" @click="emit('back')">‹ 返回列表</el-button>
      <div v-if="selected" class="dir-layout__content"><slot /></div>
      <el-empty v-else class="dir-layout__empty" :description="emptyText ?? '选择左侧的一项查看详情'" />
    </section>
  </div>
</template>

<style scoped>
.dir-layout { display: grid; height: 100vh; min-height: 0; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); background: var(--dsh-color-panel); }
.dir-layout__list { display: flex; min-height: 0; min-width: 0; flex-direction: column; border-right: 1px solid var(--dsh-color-border); }
.dir-layout__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 16px 16px 8px; }
.dir-layout__title { margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-heading); font-weight: 700; }
.dir-layout__filter { padding: 0 16px 8px; }
.dir-layout__search { padding: 0 12px 8px; }
.dir-layout__body { min-height: 0; flex: 1; overflow: auto; padding: 0 6px 8px; }
.dir-layout__rows { margin: 0; padding: 0; list-style: none; }
.dir-layout__detail { min-width: 0; min-height: 0; overflow: auto; }
.dir-layout__content { max-width: 720px; padding: 24px; }
.dir-layout__empty { height: 100%; }
.dir-layout__back { display: none; margin: 8px 12px 0; }

.dir-layout :deep(.dir-row) {
  display: flex; width: 100%; min-height: 60px; align-items: center; gap: 12px; padding: 10px;
  border: 0; border-radius: 10px; color: inherit; background: transparent; cursor: pointer; text-align: left;
}
.dir-layout :deep(.dir-row:hover) { background: var(--dsh-color-canvas); }
.dir-layout :deep(.dir-row:focus-visible) { outline: 2px solid var(--dsh-color-brand); outline-offset: -2px; }
.dir-layout :deep(.dir-row[aria-current='page']) { background: var(--dsh-color-brand-soft); }
.dir-layout :deep(.dir-row__avatar) {
  display: grid; width: 40px; height: 40px; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 50%;
  color: #fff; background: var(--dsh-color-brand); font-size: var(--dsh-font-size-subheading); font-weight: 700;
}
.dir-layout :deep(.dir-row__avatar--puzzle) {
  grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; gap: 2px; padding: 4px;
  color: var(--dsh-color-brand-dark); background: var(--dsh-color-border); font-size: var(--dsh-font-size-micro);
}
.dir-layout :deep(.dir-row__avatar--puzzle > span) { display: grid; place-items: center; border-radius: 4px; background: var(--dsh-color-panel); }
.dir-layout :deep(.dir-row__main) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.dir-layout :deep(.dir-row__name) { overflow: hidden; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-body); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dir-layout :deep(.dir-row__sub) { overflow: hidden; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.dir-layout :deep(.dir-status) { margin: 8px 6px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); }

@media (max-width: 820px) {
  /* 壳层在窄屏留出顶栏（52px）与底部标签栏（60px）。 */
  .dir-layout { height: calc(100vh - 52px - 60px); grid-template-columns: minmax(0, 1fr); }
  .dir-layout__list { border-right: 0; }
  .dir-layout.is-detail .dir-layout__list { display: none; }
  .dir-layout:not(.is-detail) .dir-layout__detail { display: none; }
  .dir-layout__back { display: inline-flex; }
}
</style>
