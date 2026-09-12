<script setup lang="ts">
import type { InstalledSkillPackage } from '@/types/assistant'
import { Document } from '@element-plus/icons-vue'
defineProps<{ source: string; targetName?: string; package?: InstalledSkillPackage; resolvedRef?: string }>()
const sampleFiles = [
  { path: 'SKILL.md', description: '适用场景与执行说明' },
  { path: 'references/format.md', description: '文档整理规范' },
  { path: 'templates/summary.md', description: '摘要与行动项模板' },
]
</script>

<template>
      <div v-if="package" class="preview-layout">
        <div class="package-details">
          <div class="package-title"><span class="package-icon"><el-icon><Document /></el-icon></span><div><h4>{{ package.name }}</h4><p>{{ package.description }}</p></div><el-tag type="info">{{ package.version ? `上游 ${package.version}` : '未声明上游版本' }}</el-tag></div>
          <dl class="package-metadata"><div><dt>安装来源</dt><dd>{{ source }}</dd></div><div v-if="resolvedRef"><dt>固定提交</dt><dd>{{ resolvedRef }}</dd></div><div><dt>内容摘要</dt><dd>{{ package.sha256 }}</dd></div><div><dt>安装目标</dt><dd>新增 Skill · 平台版本 0.1.0</dd></div></dl>
          <h4>包内文件 <span class="muted">{{ package.files.length }} 个</span></h4>
          <el-table class="data-table" :data="package.files" empty-text="暂无文件"><el-table-column prop="path" label="文件" min-width="190" /><el-table-column prop="size" label="大小（字节）" width="125" /></el-table>
          <el-collapse><el-collapse-item title="查看执行说明" name="instructions"><pre class="package-instructions">{{ package.instructions }}</pre></el-collapse-item></el-collapse>
        </div>
        <aside class="dependency-panel"><h4>工具与权限</h4><p v-if="!package.toolIds.length">纯指令 Skill，无工具依赖。</p><div v-for="tool in package.toolIds" :key="tool" class="dependency-title"><strong>{{ tool }}</strong><el-tag type="success" size="small">已匹配</el-tag></div><dl><div><dt>访问范围</dt><dd>当前任务授权文件与固定版本 Skill 资源</dd></div><div><dt>操作权限</dt><dd>只读，无脚本执行与外部联网权限</dd></div></dl><p class="dependency-note">平台工具校验后的真实预览。确认安装会保存待验证版本，不自动发布。</p></aside>
      </div>
      <div v-else class="preview-layout">
        <div class="package-details">
          <div class="package-title"><span class="package-icon"><el-icon><Document /></el-icon></span><div><h4>文档整理</h4><p>提炼文档摘要、关键结论与行动项，按统一模板输出。</p></div><el-tag type="info">v1.0.0 · 示例</el-tag></div>
          <dl class="package-metadata"><div><dt>安装来源</dt><dd>{{ source }}</dd></div><div><dt>安装目标</dt><dd>{{ targetName ? `${targetName} · 新版本` : '新增 Skill' }}</dd></div><div><dt>适用场景</dt><dd>整理业务材料、会议纪要与项目文档</dd></div></dl>
          <h4>包内文件 <span class="muted">3 个 · 示例</span></h4>
          <el-table class="data-table" :data="sampleFiles" empty-text="暂无文件"><el-table-column prop="path" label="文件" min-width="190" /><el-table-column prop="description" label="用途" min-width="160" /></el-table>
        </div>
        <aside class="dependency-panel"><h4>工具与权限</h4><div class="dependency-title"><strong>文件读取</strong><el-tag type="success" size="small" effect="plain">已匹配 · 示例</el-tag></div><p>读取当前任务中获准访问的文件，供 Skill 整理分析。</p><dl><div><dt>访问范围</dt><dd>当前任务已授权文件</dd></div><div><dt>操作权限</dt><dd>只读</dd></div><div><dt>外部网络</dt><dd>无需访问</dd></div></dl><p class="dependency-note">实际依赖与匹配结果将在接入安装服务后展示。</p></aside>
      </div>
</template>

<style scoped>
.package-instructions { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; }
.preview-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(230px, .4fr); gap: var(--spacing-section); }
.package-details { min-width: 0; }
.package-title, .dependency-title { display: flex; align-items: center; gap: var(--spacing-card); }
.package-title > div { flex: 1; }
h4 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
p { color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.7; }
.package-title p { margin: calc(var(--spacing-card) / 4) 0 0; }
.package-icon { display: grid; place-items: center; flex-shrink: 0; width: calc(var(--spacing-section) * 2); height: calc(var(--spacing-section) * 2); border-radius: var(--radius-card); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-heading); }
.package-metadata { margin: var(--spacing-section) 0; }
.package-metadata > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: var(--spacing-card); padding: calc(var(--spacing-card) / 2) 0; }
dt { color: var(--color-text-secondary); }
dd { margin: 0; overflow-wrap: anywhere; }
.package-details > h4 { margin-bottom: var(--spacing-card); }
.muted { color: var(--color-text-secondary); font-size: var(--font-size-caption); font-weight: var(--font-weight-body); }
.dependency-panel { padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-page); }
.dependency-title { margin-top: var(--spacing-card); justify-content: space-between; flex-wrap: wrap; }
.dependency-panel dl { display: flex; flex-direction: column; gap: var(--spacing-card); font-size: var(--font-size-caption); }
.dependency-panel dd { margin-top: calc(var(--spacing-card) / 4); }
.dependency-note { padding-top: var(--spacing-card); border-top: 1px solid var(--color-border); }
@media (max-width: 1180px) { .preview-layout { grid-template-columns: minmax(0, 1fr); } }
</style>
