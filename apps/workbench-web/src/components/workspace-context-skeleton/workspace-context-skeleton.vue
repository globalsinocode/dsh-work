<template>
  <div
    class="workspace-context-skeleton"
    data-testid="workspace-context-skeleton"
    role="status"
    aria-busy="true"
    aria-label="正在加载工作空间"
  >
    <div class="workspace-context-skeleton__page">
      <main class="workspace-context-skeleton__main">
        <header class="workspace-context-skeleton__header">
          <el-skeleton animated>
            <template #template>
              <div class="workspace-context-skeleton__tabs">
                <div
                  v-for="index in TAB_PLACEHOLDER_COUNT"
                  :key="`tab-${index}`"
                  class="workspace-context-skeleton__tab"
                >
                  <el-skeleton-item variant="circle" class="workspace-context-skeleton__tab-icon" />
                  <el-skeleton-item variant="text" class="workspace-context-skeleton__tab-label" />
                  <el-skeleton-item variant="text" class="workspace-context-skeleton__tab-count" />
                </div>
              </div>
            </template>
          </el-skeleton>
          <el-skeleton animated class="workspace-context-skeleton__header-action">
            <template #template>
              <el-skeleton-item variant="button" class="workspace-context-skeleton__info-btn" />
            </template>
          </el-skeleton>
        </header>

        <div class="workspace-context-skeleton__body">
          <el-skeleton animated class="workspace-context-skeleton__viewbar">
            <template #template>
              <div class="workspace-context-skeleton__viewbar-inner">
                <el-skeleton-item variant="button" class="workspace-context-skeleton__view-pill" />
                <el-skeleton-item
                  variant="button"
                  class="workspace-context-skeleton__view-pill workspace-context-skeleton__view-pill--short"
                />
              </div>
            </template>
          </el-skeleton>

          <el-skeleton animated class="workspace-context-skeleton__toolbar panel">
            <template #template>
              <el-skeleton-item variant="button" class="workspace-context-skeleton__search" />
              <el-skeleton-item variant="text" class="workspace-context-skeleton__toolbar-meta" />
            </template>
          </el-skeleton>

          <div class="workspace-context-skeleton__list panel">
            <el-skeleton
              v-for="index in HISTORY_ROW_PLACEHOLDER_COUNT"
              :key="`row-${index}`"
              animated
              class="workspace-context-skeleton__row"
            >
              <template #template>
                <el-skeleton-item variant="circle" class="workspace-context-skeleton__row-dot" />
                <el-skeleton-item variant="text" class="workspace-context-skeleton__row-title" />
                <el-skeleton-item variant="text" class="workspace-context-skeleton__row-meta" />
                <el-skeleton-item variant="text" class="workspace-context-skeleton__row-time" />
                <el-skeleton-item variant="button" class="workspace-context-skeleton__row-tag" />
              </template>
            </el-skeleton>
          </div>

          <div class="workspace-context-skeleton__composer">
            <el-skeleton animated>
              <template #template>
                <el-skeleton-item variant="rect" class="workspace-context-skeleton__composer-surface" />
              </template>
            </el-skeleton>
          </div>
        </div>
      </main>

      <aside class="workspace-context-skeleton__aside" aria-hidden="true">
        <el-skeleton animated class="workspace-context-skeleton__aside-block">
          <template #template>
            <div class="workspace-context-skeleton__aside-head">
              <el-skeleton-item variant="text" class="workspace-context-skeleton__aside-eyebrow" />
              <el-skeleton-item variant="text" class="workspace-context-skeleton__aside-title" />
            </div>
            <div class="workspace-context-skeleton__aside-hero">
              <el-skeleton-item variant="rect" class="workspace-context-skeleton__aside-folder" />
              <el-skeleton-item variant="text" class="workspace-context-skeleton__aside-name" />
              <el-skeleton-item variant="text" class="workspace-context-skeleton__aside-desc" />
              <el-skeleton-item
                variant="text"
                class="workspace-context-skeleton__aside-desc workspace-context-skeleton__aside-desc--short"
              />
            </div>
            <div
              v-for="index in ASIDE_SECTION_PLACEHOLDER_COUNT"
              :key="`aside-section-${index}`"
              class="workspace-context-skeleton__aside-section"
            >
              <el-skeleton-item variant="text" class="workspace-context-skeleton__section-label" />
              <el-skeleton-item variant="text" class="workspace-context-skeleton__section-line" />
              <el-skeleton-item
                variant="text"
                class="workspace-context-skeleton__section-line workspace-context-skeleton__section-line--short"
              />
            </div>
          </template>
        </el-skeleton>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 团队空间详情首屏加载骨架（纯展示，不发请求）。
 *
 * 布局对齐 `WorkspaceDetailView` 的页签栏、历史对话区、底栏输入条与右侧信息面板，
 * 供 `WorkspaceEntryView` 鉴权入口与 `WorkspaceDetailView` 在 store 尚未解析出空间对象时复用，
 * 避免通用 `el-skeleton :rows` 与真实页面结构错位。
 */
const TAB_PLACEHOLDER_COUNT = 3
const HISTORY_ROW_PLACEHOLDER_COUNT = 4
const ASIDE_SECTION_PLACEHOLDER_COUNT = 3
</script>

<style scoped>
.workspace-context-skeleton {
  height: 100vh;
  overflow: hidden;
  background: #fff;
}

.workspace-context-skeleton__page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  height: 100%;
}

.workspace-context-skeleton__main {
  display: flex;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
}

.workspace-context-skeleton__header {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  justify-content: space-between;
  border-bottom: 1px solid #e5e7e4;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 4px 18px rgb(31 40 35 / 3%);
}

.workspace-context-skeleton__tabs {
  display: flex;
  min-width: 0;
  height: 52px;
  flex: 1;
  align-items: stretch;
  gap: 3px;
  padding: 0 18px;
}

.workspace-context-skeleton__tab {
  display: inline-flex;
  min-width: 118px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
}

.workspace-context-skeleton__tab-icon {
  width: 16px;
  height: 16px;
}

.workspace-context-skeleton__tab-label {
  width: 42px;
  height: 12px;
}

.workspace-context-skeleton__tab-count {
  width: 22px;
  height: 18px;
  border-radius: 999px;
}

.workspace-context-skeleton__header-action {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 18px 0 8px;
}

.workspace-context-skeleton__info-btn {
  width: 92px;
  height: 30px;
  border-radius: 8px;
}

.workspace-context-skeleton__body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 14px;
  overflow: hidden;
  background: #f8faf8;
}

.workspace-context-skeleton__viewbar {
  flex: 0 0 auto;
}

.workspace-context-skeleton__viewbar-inner {
  display: inline-flex;
  gap: 6px;
  padding: 2px;
  border: 1px solid #e3e5e2;
  border-radius: 9px;
  background: #fff;
}

.workspace-context-skeleton__view-pill {
  width: 72px;
  height: 28px;
  border-radius: 7px;
}

.workspace-context-skeleton__view-pill--short {
  width: 84px;
}

.workspace-context-skeleton__toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 10px 16px;
  box-shadow: none;
}

.workspace-context-skeleton__search {
  width: min(290px, 100%);
  height: 32px;
  border-radius: 8px;
}

.workspace-context-skeleton__toolbar-meta {
  width: 120px;
  height: 12px;
}

.workspace-context-skeleton__list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  box-shadow: none;
}

.workspace-context-skeleton__row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) 96px 96px auto;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 10px 16px;
  border-bottom: 1px solid #e8ebe8;
}

.workspace-context-skeleton__row-dot {
  width: 8px;
  height: 8px;
}

.workspace-context-skeleton__row-title {
  width: 72%;
  height: 14px;
}

.workspace-context-skeleton__row-meta {
  width: 72px;
  height: 12px;
}

.workspace-context-skeleton__row-time {
  width: 64px;
  height: 12px;
}

.workspace-context-skeleton__row-tag {
  width: 64px;
  height: 22px;
  border-radius: 999px;
}

.workspace-context-skeleton__composer {
  flex: 0 0 auto;
  padding-top: 2px;
  border-top: 1px solid #e8ebe8;
}

.workspace-context-skeleton__composer-surface {
  width: 100%;
  height: 88px;
  border-radius: 15px;
}

.workspace-context-skeleton__aside {
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border-left: 1px solid #e5e7e4;
  box-shadow: -8px 0 28px rgb(32 42 36 / 3%);
}

.workspace-context-skeleton__aside-block {
  height: 100%;
  padding: 18px 16px 24px;
}

.workspace-context-skeleton__aside-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 14px;
}

.workspace-context-skeleton__aside-eyebrow {
  width: 64px;
  height: 10px;
}

.workspace-context-skeleton__aside-title {
  width: 88px;
  height: 14px;
}

.workspace-context-skeleton__aside-hero {
  margin-bottom: 18px;
}

.workspace-context-skeleton__aside-folder {
  width: 42px;
  height: 42px;
  margin-bottom: 12px;
  border-radius: 11px;
}

.workspace-context-skeleton__aside-name {
  width: 78%;
  height: 18px;
  margin-bottom: 10px;
}

.workspace-context-skeleton__aside-desc {
  width: 100%;
  height: 12px;
  margin-bottom: 8px;
}

.workspace-context-skeleton__aside-desc--short {
  width: 62%;
}

.workspace-context-skeleton__aside-section {
  margin-bottom: 16px;
}

.workspace-context-skeleton__section-label {
  width: 56px;
  height: 11px;
  margin-bottom: 10px;
}

.workspace-context-skeleton__section-line {
  width: 100%;
  height: 12px;
  margin-bottom: 8px;
}

.workspace-context-skeleton__section-line--short {
  width: 70%;
}

@media (max-width: 1180px) {
  .workspace-context-skeleton__page {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-context-skeleton__aside {
    display: none;
  }
}

@media (max-width: 640px) {
  .workspace-context-skeleton__tabs {
    padding: 0 8px;
  }

  .workspace-context-skeleton__header-action {
    padding-right: 10px;
  }

  .workspace-context-skeleton__tab {
    min-width: 104px;
    padding: 0 8px;
  }

  .workspace-context-skeleton__body {
    padding: 12px 14px 12px;
  }

  .workspace-context-skeleton__row {
    grid-template-columns: 12px minmax(0, 1fr) auto;
  }

  .workspace-context-skeleton__row-meta,
  .workspace-context-skeleton__row-time {
    display: none;
  }

  .workspace-context-skeleton__row-tag {
    grid-column: 3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-context-skeleton :deep(.el-skeleton.is-animated .el-skeleton__item) {
    animation: none;
  }
}
</style>
