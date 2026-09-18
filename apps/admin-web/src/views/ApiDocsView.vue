<script setup lang="ts">
import { computed } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

import mobileSpecJson from '../../../../docs/development/openapi-mobile-h5.json'
import { collectDoc, type DocField, type DocOperation, type OpenApiDocument } from '../utils/openapi-doc'

// 本页面向独立开发的移动端 H5 项目：只渲染移动端实际调用的 Workbench API 子集，
// 不展示完整员工端/管理端契约；文件同时供页面渲染与下载导出。
const mobileSpec = mobileSpecJson as OpenApiDocument
const docTags = computed(() => collectDoc(mobileSpec))
const serverUrl = computed(() => mobileSpec.servers?.[0]?.url ?? '')
const operationCount = computed(() => docTags.value.reduce((sum, tag) => sum + tag.operations.length, 0))

function metaRows(op: DocOperation) {
  return [
    { label: 'HTTP URL', value: `${op.method} ${serverUrl.value}${op.path}`, mono: true },
    { label: 'HTTP Method', value: op.method, mono: false },
    { label: '权限要求', value: op.permission, mono: false },
  ]
}

const fieldColumns = [
  { prop: 'name', label: '字段' },
  { prop: 'type', label: '类型' },
  { prop: 'required', label: '必填' },
  { prop: 'description', label: '含义' },
]

function requiredText(field: DocField) {
  return field.required ? '是' : '否'
}

function downloadSpec() {
  const content = JSON.stringify(mobileSpec, null, 2)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'openapi-mobile-h5.json'
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  ElMessage.success('已下载移动端 H5 API OpenAPI 契约')
}
</script>

<template>
  <div class="ops-page api-docs-page">
    <section class="content-panel api-docs-hero">
      <div>
        <p class="docs-eyebrow">开发接入</p>
        <div class="page-title" role="heading" aria-level="1">接口文档</div>
        <p class="page-subtitle">
          {{ mobileSpec.info.title }} · 共 {{ operationCount }} 个接口，仅收录移动端实际调用的端点；
          契约文件 docs/development/openapi-mobile-h5.json。
        </p>
      </div>
      <el-button :icon="Download" data-testid="download-spec" @click="downloadSpec">下载移动端 H5 API OpenAPI</el-button>
    </section>

    <div id="api-docs-panel" class="api-docs-layout" data-testid="api-docs-panel">
      <aside class="api-docs-nav" aria-label="接口目录">
        <nav v-for="tag in docTags" :key="tag.name" class="api-docs-nav__group">
          <div class="api-docs-nav__tag">{{ tag.name }}</div>
          <a
            v-for="op in tag.operations"
            :key="op.anchor"
            class="api-docs-nav__item"
            :href="`#${op.anchor}`"
          >
            <span class="api-docs-nav__method" :data-method="op.method">{{ op.method }}</span>
            {{ op.summary }}
          </a>
        </nav>
      </aside>

      <div class="api-docs-main">
        <section v-for="tag in docTags" :key="tag.name" class="api-docs-tag">
          <h2 class="api-docs-tag__title">{{ tag.name }}</h2>
          <p v-if="tag.description" class="api-docs-tag__desc">{{ tag.description }}</p>

          <article v-for="op in tag.operations" :id="op.anchor" :key="op.anchor" class="endpoint-card content-panel">
            <h3 class="endpoint-card__title">{{ op.summary }}</h3>
            <p v-if="op.description" class="endpoint-card__desc">{{ op.description }}</p>

            <el-table class="data-table doc-meta-table" :data="metaRows(op)" :show-header="false">
              <el-table-column prop="label" width="140" />
              <el-table-column>
                <template #default="scope">
                  <code v-if="scope.row.mono">{{ scope.row.value }}</code>
                  <template v-else>{{ scope.row.value }}</template>
                </template>
              </el-table-column>
            </el-table>

            <template v-if="op.parameters.length">
              <h4 class="endpoint-card__section">请求参数</h4>
              <el-table class="data-table" :data="op.parameters">
                <el-table-column prop="name" label="参数" min-width="220">
                  <template #default="scope"><code>{{ scope.row.name }}</code></template>
                </el-table-column>
                <el-table-column prop="type" label="类型" width="120" />
                <el-table-column label="必填" width="80">
                  <template #default="scope">{{ requiredText(scope.row) }}</template>
                </el-table-column>
                <el-table-column prop="description" label="含义" min-width="220" />
              </el-table>
            </template>

            <template v-if="op.requestFields.length">
              <h4 class="endpoint-card__section">请求体字段</h4>
              <el-table class="data-table" :data="op.requestFields">
                <el-table-column prop="name" label="字段" min-width="220">
                  <template #default="scope"><code>{{ scope.row.name }}</code></template>
                </el-table-column>
                <el-table-column prop="type" label="类型" width="120" />
                <el-table-column label="必填" width="80">
                  <template #default="scope">{{ requiredText(scope.row) }}</template>
                </el-table-column>
                <el-table-column prop="description" label="含义" min-width="220" />
              </el-table>
            </template>

            <h4 class="endpoint-card__section">请求报文</h4>
            <pre class="doc-code">{{ op.requestMessage }}</pre>

            <h4 class="endpoint-card__section">
              响应报文
              <span class="endpoint-card__status">{{ op.responseStatus }} {{ op.responseDescription }}</span>
            </h4>
            <pre class="doc-code">{{ op.responseMessage }}</pre>

            <template v-if="op.responseFields.length">
              <h4 class="endpoint-card__section">响应 data</h4>
              <el-table class="data-table" :data="op.responseFields">
                <el-table-column
                  v-for="column in fieldColumns"
                  :key="column.prop"
                  :label="column.label"
                  :min-width="column.prop === 'name' || column.prop === 'description' ? 220 : undefined"
                  :width="column.prop === 'type' ? 120 : column.prop === 'required' ? 80 : undefined"
                >
                  <template #default="scope">
                    <code v-if="column.prop === 'name'">{{ scope.row.name }}</code>
                    <template v-else-if="column.prop === 'required'">{{ requiredText(scope.row) }}</template>
                    <template v-else>{{ scope.row[column.prop as keyof DocField] }}</template>
                  </template>
                </el-table-column>
              </el-table>
            </template>
          </article>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.api-docs-page { max-width: 1280px; margin: 0 auto; }
.api-docs-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 24px; }
.api-docs-hero .el-button { flex: 0 0 auto; }
.api-docs-hero .page-title { font-size: var(--font-size-heading); }
.api-docs-hero .page-subtitle { margin-bottom: 0; }

.api-docs-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; align-items: start; }

.api-docs-nav {
  position: sticky;
  top: calc(var(--dsh-topbar-height) + 12px);
  max-height: calc(100dvh - var(--dsh-topbar-height) - 24px);
  overflow-y: auto;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg-base);
}
.api-docs-nav__group + .api-docs-nav__group { margin-top: 14px; }
.api-docs-nav__tag { padding: 4px 8px; font-size: var(--font-size-micro); font-weight: var(--font-weight-title); color: var(--color-text-muted); }
.api-docs-nav__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-tag);
  font-size: var(--font-size-body);
  line-height: 1.5;
  color: var(--color-text-primary);
  text-decoration: none;
}
.api-docs-nav__item:hover { background: var(--color-bg-subtle); color: var(--color-text-heading); }
.api-docs-nav__method {
  flex: 0 0 auto;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: var(--font-size-micro);
  font-weight: var(--font-weight-title);
}
.api-docs-nav__method[data-method="GET"] { color: var(--color-success-strong); }
.api-docs-nav__method[data-method="POST"] { color: var(--color-primary); }
.api-docs-nav__method[data-method="DELETE"] { color: var(--color-danger-strong); }

.api-docs-tag__title { margin: 4px 0 4px; font-size: var(--font-size-heading); color: var(--color-text-heading); }
.api-docs-tag__desc { margin: 0 0 12px; font-size: var(--font-size-body); color: var(--color-text-secondary); }

.endpoint-card { padding: 20px 24px; margin-bottom: 16px; scroll-margin-top: calc(var(--dsh-topbar-height) + 12px); }
.endpoint-card__title { margin: 0 0 6px; font-size: var(--font-size-title); color: var(--color-text-heading); }
.endpoint-card__desc { margin: 0 0 14px; font-size: var(--font-size-body); line-height: 1.7; color: var(--color-text-secondary); }
.endpoint-card__section { margin: 18px 0 8px; font-size: var(--font-size-body); font-weight: var(--font-weight-title); color: var(--color-text-heading); }
.endpoint-card__status { margin-left: 8px; font-weight: var(--font-weight-body); color: var(--color-text-muted); }

.doc-meta-table :deep(.el-table__cell:first-child) { font-weight: var(--font-weight-title); color: var(--color-text-heading); background: var(--color-bg-subtle); }

.doc-code {
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-tag);
  background: var(--color-bg-subtle);
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: var(--font-size-caption);
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre;
  color: var(--color-text-primary);
}

@media (max-width: 900px) {
  .api-docs-layout { grid-template-columns: 1fr; }
  .api-docs-nav { position: static; max-height: none; }
}
</style>
