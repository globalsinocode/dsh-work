<script setup lang="ts">
import { InfoFilled, Cpu, Monitor } from '@element-plus/icons-vue'

import { AppLogo } from '@dsh-work/ui-core'
import { buildInfo, shortCommit } from '@/utils/build-info'

const environmentLabel = import.meta.env.MODE === 'production' ? '生产构建' : '开发构建'
</script>

<template>
  <div class="ops-page about-page">
    <section class="about-hero content-panel">
      <div class="about-hero__brand"><AppLogo dark /></div>
      <div class="about-hero__copy">
        <p class="about-eyebrow">关于系统</p>
        <div class="page-title" role="heading" aria-level="1">{{ buildInfo.application }}</div>
        <p class="page-subtitle">企业 Agent 工作空间的统一管理与运行治理入口。</p>
      </div>
      <el-tag type="success" effect="plain" data-testid="about-release-version">v{{ buildInfo.releaseVersion }}</el-tag>
    </section>

    <section class="about-grid">
      <article class="content-panel about-card">
        <header class="about-card__heading">
          <span class="about-card__icon"><el-icon><InfoFilled /></el-icon></span>
          <div><h2>版本信息</h2><p>当前管理端构建使用的发布元数据。</p></div>
        </header>
        <dl class="about-details">
          <div><dt>系统版本</dt><dd data-testid="about-system-version">v{{ buildInfo.releaseVersion }}</dd></div>
          <div><dt>构建 Commit</dt><dd><code :title="buildInfo.buildCommit" data-testid="about-build-commit">{{ shortCommit(buildInfo.buildCommit) }}</code></dd></div>
          <div><dt>构建环境</dt><dd>{{ environmentLabel }}</dd></div>
        </dl>
      </article>

      <article class="content-panel about-card">
        <header class="about-card__heading">
          <span class="about-card__icon"><el-icon><Cpu /></el-icon></span>
          <div><h2>执行运行时</h2><p>服务端锁定的 DSH Runtime 兼容信息。</p></div>
        </header>
        <dl class="about-details">
          <div><dt>DSH Runtime</dt><dd data-testid="about-dsh-version">{{ buildInfo.dshVersion }}</dd></div>
          <div><dt>Runtime Commit</dt><dd><code :title="buildInfo.dshCommit" data-testid="about-dsh-commit">{{ shortCommit(buildInfo.dshCommit) }}</code></dd></div>
          <div><dt>ACP 协议</dt><dd>v{{ buildInfo.dshProtocolVersion }}</dd></div>
        </dl>
      </article>
    </section>

    <section class="about-note content-panel">
      <span class="about-note__icon"><el-icon><Monitor /></el-icon></span>
      <div><strong>版本说明</strong><p>系统版本来自发布制品元数据；Runtime 版本来自服务端 Runtime Lock。两者独立管理，升级其中一项不会自动修改另一项。</p></div>
    </section>
  </div>
</template>

<style scoped>
.about-page { max-width: 1180px; margin: 0 auto; }
.about-hero { display: flex; align-items: center; gap: 20px; padding: 24px; }
.about-hero__brand { display: grid; width: 58px; height: 58px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-card); background: var(--color-primary-light); }
.about-hero__brand :deep(.logo__mark) { width: 40px; height: 40px; }
.about-hero__brand :deep(.logo__text) { display: none; }
.about-hero__copy { min-width: 0; flex: 1; }
.about-eyebrow { margin: 0 0 5px; color: var(--color-primary); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); letter-spacing: .04em; }
.about-hero .page-title { font-size: var(--font-size-heading); }
.about-hero .page-subtitle { margin-bottom: 0; }
.about-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.about-card { min-width: 0; padding: 20px; }
.about-card__heading { display: flex; align-items: flex-start; gap: 12px; }
.about-card__icon { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-header); }
.about-card h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.about-card__heading p { margin: 4px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.about-details { display: grid; gap: 0; margin: 20px 0 0; border-top: 1px solid var(--color-border); }
.about-details > div { display: flex; min-height: 45px; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--color-border); }
.about-details dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.about-details dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); text-align: right; }
.about-details code { color: var(--color-text-primary); font-family: var(--el-font-family); font-size: var(--font-size-badge); }
.about-note { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px; }
.about-note__icon { color: var(--color-primary); font-size: var(--font-size-header); }
.about-note strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.about-note p { margin: 4px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.6; }
@media (max-width: 700px) { .about-hero { align-items: flex-start; flex-wrap: wrap; } .about-hero > .el-tag { margin-left: 78px; } .about-grid { grid-template-columns: 1fr; } }
</style>
