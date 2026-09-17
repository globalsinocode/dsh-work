<script setup lang="ts">
import { computed, ref } from 'vue'

import adminSpecJson from '../../../../docs/development/openapi-admin.json'
import workbenchSpecJson from '../../../../docs/development/openapi-workbench.json'

interface ApiParameter {
  name: string
  in?: string
  required?: boolean
  description?: string
  schema?: { type?: string }
}

interface ApiOperation {
  operationId?: string
  summary?: string
  description?: string
  parameters?: ApiParameter[]
  requestBody?: { content?: Record<string, { schema?: { $ref?: string; type?: string } }> }
  responses?: Record<string, { description?: string; $ref?: string }>
}

interface OpenApiSpec {
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, ApiOperation>>
}

interface EndpointEntry {
  method: string
  path: string
  operation: ApiOperation
}

interface EndpointGroup {
  name: string
  endpoints: EndpointEntry[]
}

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const

const specs: Array<{ key: string; label: string; spec: OpenApiSpec }> = [
  { key: 'workbench', label: '员工端 API', spec: workbenchSpecJson as unknown as OpenApiSpec },
  { key: 'admin', label: '管理端 API', spec: adminSpecJson as unknown as OpenApiSpec },
]

const activeSpecKey = ref('workbench')
const activeSpec = computed(() => specs.find(item => item.key === activeSpecKey.value) ?? specs[0])

const groups = computed<EndpointGroup[]>(() => {
  const grouped = new Map<string, EndpointEntry[]>()
  for (const [path, operations] of Object.entries(activeSpec.value.spec.paths)) {
    const segment = path.split('/').filter(Boolean)[0] ?? 'root'
    for (const method of HTTP_METHODS) {
      const operation = operations[method]
      if (!operation) continue
      const list = grouped.get(segment) ?? []
      list.push({ method: method.toUpperCase(), path, operation })
      grouped.set(segment, list)
    }
  }
  return [...grouped.entries()].map(([name, endpoints]) => ({ name, endpoints }))
})

const endpointCount = computed(() => groups.value.reduce((total, group) => total + group.endpoints.length, 0))

function methodClass(method: string) {
  return `method-badge method-badge--${method.toLowerCase()}`
}

function switchSpec(key: string) {
  activeSpecKey.value = key
}

function navigateTabs(event: KeyboardEvent) {
  const supported = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!supported.includes(event.key)) return
  event.preventDefault()
  const index = specs.findIndex(item => item.key === activeSpecKey.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? specs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + specs.length) % specs.length
  const item = specs[next]
  if (!item) return
  switchSpec(item.key)
  document.getElementById(`api-docs-tab-${item.key}`)?.focus()
}

function requestBodyContentType(operation: ApiOperation) {
  const content = operation.requestBody?.content ?? {}
  if ('application/json' in content) return 'application/json'
  return Object.keys(content)[0] ?? 'application/json'
}

function requestBodyRef(operation: ApiOperation): string {
  const schema = operation.requestBody?.content?.['application/json']?.schema
    ?? Object.values(operation.requestBody?.content ?? {})[0]?.schema
  return schema?.$ref?.split('/').pop() ?? schema?.type ?? 'object'
}

function responseStatuses(operation: ApiOperation) {
  const keys = Object.keys(operation.responses ?? {})
  const numeric = keys.filter(status => status !== 'default').sort((a, b) => Number(a) - Number(b))
  return keys.includes('default') ? [...numeric, 'default'] : numeric
}
</script>

<template>
  <div class="ops-page api-docs-page">
    <section class="content-panel api-docs-hero">
      <div>
        <p class="docs-eyebrow">开发接入</p>
        <div class="page-title" role="heading" aria-level="1">接口文档</div>
        <p class="page-subtitle">内容与仓库 OpenAPI 契约（docs/development/openapi-*.json）同步构建，随版本发布。</p>
      </div>
    </section>

    <div class="status-tabs" role="tablist" aria-label="API 分组" @keydown="navigateTabs">
      <button
        v-for="item in specs"
        :id="`api-docs-tab-${item.key}`"
        :key="item.key"
        class="status-tab"
        :class="{ active: activeSpecKey === item.key }"
        type="button"
        role="tab"
        :aria-selected="activeSpecKey === item.key"
        aria-controls="api-docs-panel"
        :tabindex="activeSpecKey === item.key ? 0 : -1"
        @click="switchSpec(item.key)"
      >{{ item.label }}</button>
    </div>

    <div id="api-docs-panel" role="tabpanel" :aria-labelledby="`api-docs-tab-${activeSpec.key}`">
      <section class="content-panel api-docs-meta">
        <dl class="api-meta">
          <div><dt>名称</dt><dd data-testid="api-spec-title">{{ activeSpec.spec.info.title }}</dd></div>
          <div><dt>版本</dt><dd><code>{{ activeSpec.spec.info.version }}</code></dd></div>
          <div><dt>端点数</dt><dd>{{ endpointCount }}</dd></div>
        </dl>
        <p v-if="activeSpec.spec.info.description" class="api-meta__description">{{ activeSpec.spec.info.description }}</p>
      </section>

      <section v-for="group in groups" :key="group.name" class="content-panel api-group">
        <header class="api-group__heading">
          <h2><code>/{{ group.name }}</code></h2>
          <span class="api-group__count">{{ group.endpoints.length }} 个端点</span>
        </header>
        <ul class="api-endpoint-list">
          <li v-for="endpoint in group.endpoints" :key="`${endpoint.method} ${endpoint.path}`" class="api-endpoint">
            <div class="api-endpoint__line">
              <span :class="methodClass(endpoint.method)">{{ endpoint.method }}</span>
              <code class="api-endpoint__path">{{ endpoint.path }}</code>
              <span class="api-endpoint__statuses" aria-label="响应状态码">
                <span v-for="status in responseStatuses(endpoint.operation)" :key="status" class="api-status" :title="status === 'default' ? '未匹配显式状态码时的默认响应' : `HTTP ${status}`">{{ status }}</span>
              </span>
            </div>
            <p class="api-endpoint__summary">{{ endpoint.operation.summary ?? endpoint.operation.operationId }}</p>
            <p v-if="endpoint.operation.description" class="api-endpoint__description">{{ endpoint.operation.description }}</p>
            <dl v-if="endpoint.operation.parameters?.length" class="api-params">
              <div v-for="param in endpoint.operation.parameters" :key="param.name" class="api-params__row">
                <dt><code>{{ param.name }}</code></dt>
                <dd>{{ param.in ?? '-' }} · {{ param.schema?.type ?? '-' }}<span v-if="param.required" class="api-params__required">必填</span></dd>
              </div>
            </dl>
            <p v-if="endpoint.operation.requestBody" class="api-endpoint__hint">请求体 <code>{{ requestBodyContentType(endpoint.operation) }}</code>：<code>{{ requestBodyRef(endpoint.operation) }}</code>，字段见 OpenAPI 契约 components。</p>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.api-docs-page { max-width: 920px; margin: 0 auto; }
.api-docs-hero { padding: 24px; }
.api-docs-hero .page-title { font-size: var(--font-size-heading); }
.api-docs-hero .page-subtitle { margin-bottom: 0; }
.api-docs-meta { padding: 16px 24px; }
.api-meta { display: flex; flex-wrap: wrap; gap: 24px; margin: 0; }
.api-meta > div { display: flex; align-items: baseline; gap: 8px; }
.api-meta dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.api-meta dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.api-meta__description { margin: 12px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.7; }
.api-group { padding: 16px 24px; }
.api-group__heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--color-border); padding-bottom: 10px; }
.api-group__heading h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.api-group__count { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.api-endpoint-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.api-endpoint { padding: 14px 0; border-bottom: 1px solid var(--color-border); }
.api-endpoint:last-child { border-bottom: 0; }
.api-endpoint__line { display: flex; align-items: center; gap: 10px; }
.api-endpoint__path { color: var(--color-text-primary); font-size: var(--font-size-caption); }
.api-endpoint__statuses { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.api-status { padding: 1px 6px; border-radius: var(--radius-tag); color: var(--color-text-muted); background: var(--color-bg-subtle); font-size: var(--font-size-badge); }
.api-endpoint__summary { margin: 6px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.api-endpoint__description { margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.7; }
.api-endpoint__hint { margin: 6px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.method-badge { flex: 0 0 auto; min-width: 52px; padding: 2px 8px; border-radius: var(--radius-tag); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); text-align: center; }
.method-badge--get { color: var(--color-success); background: var(--color-success-light); }
.method-badge--post { color: var(--color-primary); background: var(--color-primary-light); }
.method-badge--patch { color: var(--color-warning); background: var(--color-warning-light); }
.method-badge--delete { color: var(--color-danger); background: var(--color-danger-light); }
.method-badge--put { color: var(--color-text-secondary); background: var(--color-bg-subtle); }
.api-params { display: grid; gap: 0; margin: 10px 0 0; border: 1px solid var(--color-border); border-radius: var(--radius-tag); overflow: hidden; }
.api-params__row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 7px 12px; border-bottom: 1px solid var(--color-border); }
.api-params__row:last-child { border-bottom: 0; }
.api-params__row dt { color: var(--color-text-primary); font-size: var(--font-size-badge); }
.api-params__row dd { margin: 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.api-params__required { margin-left: 8px; color: var(--color-danger); font-weight: var(--font-weight-title); }
</style>
