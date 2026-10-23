<script setup lang="ts">
/**
 * 协作模式目录页的共享两栏布局（D25：AI 同事页与群组页相同，样式按 B 原型）。
 * 左栏：标题 + 可选操作 + 圆角搜索框 + 可选筛选 + 列表；右栏：居中的选中项详情或空态。
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
        <div class="dir-layout__title-row">
          <h1 class="dir-layout__title">{{ title }}</h1>
          <slot name="action" />
        </div>
        <label class="dir-layout__search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-4-4" />
          </svg>
          <input v-model="keyword" type="search" :aria-label="searchLabel" :placeholder="searchPlaceholder ?? '搜索'">
        </label>
        <div v-if="$slots.filter" class="dir-layout__filter"><slot name="filter" /></div>
      </header>
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
.dir-layout { display: grid; height: 100vh; min-height: 0; grid-template-columns: minmax(280px, 330px) minmax(0, 1fr); background: var(--dsh-color-canvas); }
.dir-layout__list { display: flex; min-height: 0; min-width: 0; flex-direction: column; border-right: 1px solid #e9edf3; background: var(--dsh-color-panel); }
.dir-layout__head { display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 10px; }
.dir-layout__title-row { display: flex; align-items: center; gap: 10px; }
.dir-layout__title { flex: 1; margin: 0; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-section); font-weight: 700; }
.dir-layout__title-row :deep(.dir-action) {
  height: 32px; padding: 0 12px; border: 0; border-radius: 16px; color: #fff; background: var(--dsh-color-brand);
  font-size: var(--dsh-font-size-caption); cursor: pointer;
}
.dir-layout__title-row :deep(.dir-action:hover) { background: var(--dsh-color-brand-dark); }
.dir-layout__title-row :deep(.dir-action:focus-visible) { outline: 2px solid var(--dsh-color-brand-dark); outline-offset: 2px; }
.dir-layout__search {
  display: flex; height: 40px; align-items: center; gap: 8px; padding: 0 14px;
  border-radius: 22px; color: var(--dsh-color-muted); background: var(--dsh-color-canvas);
}
.dir-layout__search:focus-within { box-shadow: 0 0 0 2px var(--dsh-color-brand-soft), inset 0 0 0 1px var(--dsh-color-brand); }
.dir-layout__search input {
  min-width: 0; flex: 1; border: 0; outline: none; color: var(--dsh-color-ink); background: transparent;
  font-family: inherit; font-size: var(--dsh-font-size-body);
}
.dir-layout__filter { display: flex; flex-wrap: wrap; gap: 6px; }
.dir-layout__filter :deep(.dir-chip) {
  height: 30px; padding: 0 12px; border: 1px solid var(--dsh-color-border); border-radius: 15px;
  color: var(--dsh-color-text); background: var(--dsh-color-panel); font-size: var(--dsh-font-size-caption); cursor: pointer;
}
.dir-layout__filter :deep(.dir-chip[aria-pressed='true']) { border-color: var(--dsh-color-brand); color: var(--dsh-color-brand-dark); background: var(--dsh-color-brand-soft); }
.dir-layout__filter :deep(.dir-chip:focus-visible) { outline: 2px solid var(--dsh-color-brand); outline-offset: 1px; }
.dir-layout__body { min-height: 0; flex: 1; overflow: auto; padding: 0 10px 12px; }
.dir-layout__rows { display: flex; margin: 0; padding: 0; flex-direction: column; gap: 2px; list-style: none; }
.dir-layout__detail { min-width: 0; min-height: 0; overflow: auto; }
.dir-layout__content { display: flex; box-sizing: border-box; justify-content: center; padding: 56px 32px; }
.dir-layout__empty { height: 100%; }
.dir-layout__back { display: none; margin: 8px 12px 0; }

.dir-layout :deep(.dir-row) {
  display: flex; width: 100%; align-items: center; gap: 12px; padding: 12px;
  border: 0; border-radius: var(--dsh-radius-lg); color: inherit; background: transparent; cursor: pointer; text-align: left;
}
.dir-layout :deep(.dir-row:hover) { background: var(--dsh-color-canvas); }
.dir-layout :deep(.dir-row:focus-visible) { outline: 2px solid var(--dsh-color-brand); outline-offset: -2px; }
.dir-layout :deep(.dir-row[aria-current='page']) { background: var(--dsh-color-brand-soft); box-shadow: inset 0 0 0 1px #c9d6f7; }
.dir-layout :deep(.dir-row__main) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.dir-layout :deep(.dir-row__name) { overflow: hidden; color: var(--dsh-color-ink); font-size: var(--dsh-font-size-title); text-overflow: ellipsis; white-space: nowrap; }
.dir-layout :deep(.dir-row__sub) { overflow: hidden; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.dir-layout :deep(.dir-row__badge) {
  flex: 0 0 auto; padding: 2px 8px; border-radius: 10px; color: var(--dsh-color-text); background: var(--dsh-color-canvas);
  font-size: var(--dsh-font-size-micro);
}
.dir-layout :deep(.dir-status) { margin: 8px 6px; color: var(--dsh-color-subtle); font-size: var(--dsh-font-size-caption); }

@media (max-width: 820px) {
  /* 壳层在窄屏留出顶栏（52px）与底部标签栏（60px）。 */
  .dir-layout { height: calc(100vh - 52px - 60px); grid-template-columns: minmax(0, 1fr); }
  .dir-layout__list { border-right: 0; }
  .dir-layout.is-detail .dir-layout__list { display: none; }
  .dir-layout:not(.is-detail) .dir-layout__detail { display: none; }
  .dir-layout__back { display: inline-flex; }
  .dir-layout__content { padding: 24px 16px; }
}
</style>
