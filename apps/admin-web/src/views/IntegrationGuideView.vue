<script setup lang="ts">
import { Connection, Document, Download, Key, Lock, Monitor, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

import guideMarkdown from '../../../../docs/development/mobile-integration-guide.md?raw'

function downloadGuide() {
  const url = URL.createObjectURL(new Blob([guideMarkdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'dsh-work-移动端接入规范.md'
  anchor.click()
  URL.revokeObjectURL(url)
  ElMessage.success('已下载接入规范 Markdown 文档')
}
</script>

<template>
  <div class="ops-page guide-page">
    <section class="guide-hero content-panel">
      <div class="guide-hero__copy">
        <p class="docs-eyebrow">开发接入</p>
        <div class="page-title" role="heading" aria-level="1">移动端接入规范</div>
        <p class="page-subtitle">移动端 H5 是独立的 API 消费方，与员工工作台平级。本页约定接入方式、认证、数据格式与边界。</p>
      </div>
      <el-button :icon="Download" data-testid="download-guide" @click="downloadGuide">下载 Markdown 文档</el-button>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Connection /></el-icon>
        <h2>部署形态与同源访问</h2>
      </header>
      <ul class="guide-list">
        <li>移动端使用独立工程开发，通过浏览器访问 dsh-work 服务端 API，不引入第二套执行链路。</li>
        <li>移动端入口（独立端口或二级域名）必须由自身网关/nginx 反代 <code>/api</code> 与 <code>/auth</code> 到 dsh-work 服务端，浏览器视角保持同源；服务端不提供 CORS，禁止跨源直连 API。</li>
        <li>移动端 origin 需要登记到服务端 <code>DSH_WORK_WORKBENCH_ORIGINS</code> 白名单与 AI Hub 应用回调地址，回调路径固定为 <code>/auth/workbench/callback</code>。</li>
        <li>二级域名与桌面端天然隔离会话；同 IP 不同端口会共享 <code>dsh_work_session</code> Cookie（Cookie 按 host 隔离、不认端口）。</li>
      </ul>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Lock /></el-icon>
        <h2>认证与会话</h2>
      </header>
      <ul class="guide-list">
        <li>浏览器跳转 <code>GET /auth/workbench/login</code> 发起 AI Hub OIDC 登录，回调成功后服务端签发 HttpOnly Session Cookie（<code>dsh_work_session</code>，SameSite=Lax）。</li>
        <li>移动端不持有 token，后续请求自动携带 Cookie；会话失效返回 <code>401 authentication_required</code>，应引导用户重新登录。</li>
        <li>登出：<code>POST /auth/workbench/logout</code>（或 GET）；切换账号走 <code>/auth/workbench/switch-account</code>，不要自行调用 OIDC end-session。</li>
        <li>会话角色、权限和数据范围由 dsh-work 本地配置，客户端传入的任何权限字段都会被忽略。</li>
      </ul>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Document /></el-icon>
        <h2>请求与响应包络</h2>
      </header>
      <ul class="guide-list">
        <li>业务接口前缀 <code>/api/workbench/v1</code>，请求与响应均为 JSON。</li>
        <li>成功响应统一包络：<code>{ data, meta: { api, adapter, timestamp } }</code>，业务数据只读 <code>data</code>。</li>
        <li>列表接口使用游标分页：响应含 <code>nextCursor</code>，下一页以同名 query 参数回传。</li>
      </ul>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Key /></el-icon>
        <h2>错误格式</h2>
      </header>
      <ul class="guide-list">
        <li>失败响应为 <code>{ error: { code, message, object?, suggestion?, traceId? } }</code>，HTTP 状态码表达语义：401 未登录、403 无权限、404 不存在、409 状态冲突、421 入口来源未登记。</li>
        <li><code>code</code> 是稳定的机读标识，用于分支处理；<code>message</code>/<code>suggestion</code> 面向用户展示；排障时提供 <code>traceId</code>。</li>
      </ul>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Monitor /></el-icon>
        <h2>事件流（SSE）</h2>
      </header>
      <ul class="guide-list">
        <li>Run 执行进度通过 <code>GET /api/workbench/v1/runs/{runId}/events</code> 以 <code>text/event-stream</code> 推送，浏览器使用原生 <code>EventSource</code> 接入。</li>
        <li>每条事件携带 <code>id</code> 与 <code>event</code> 类型，断线后浏览器自动带 <code>Last-Event-ID</code> 重连，服务端从该游标续传，不丢事件。</li>
        <li>服务端定期发送 <code>: heartbeat</code> 注释行保活；Run 进入 succeeded/failed/cancelled 终态后流会结束，前端应停止重连。</li>
        <li>事件结构以 <code>docs/development/run-event.schema.json</code> 为准；团队成员被收权时流会主动终止。</li>
      </ul>
    </section>

    <section class="content-panel guide-section">
      <header class="guide-section__heading">
        <el-icon><Refresh /></el-icon>
        <h2>版本兼容与约束</h2>
      </header>
      <ul class="guide-list">
        <li><code>v1</code> 内只增不删，向后兼容；破坏性变更发布 <code>v2</code> 并预留迁移窗口。契约以 <code>docs/development/openapi-workbench.json</code> 为唯一事实来源。</li>
        <li>所有 Agent 交互必须经 Run/Attempt API 发起，禁止绕过 dsh-work 直连模型 API。</li>
        <li>Prototype 模式仅用于冒烟联调；验收必须使用 PostgreSQL + OIDC 完整环境。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.guide-page { max-width: 920px; margin: 0 auto; }
.guide-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 24px; }
.guide-hero .el-button { flex: 0 0 auto; }
.guide-hero .page-title { font-size: var(--font-size-heading); }
.guide-hero .page-subtitle { margin-bottom: 0; }
.guide-section { padding: 20px 24px; }
.guide-section__heading { display: flex; align-items: center; gap: 10px; }
.guide-section__heading .el-icon { color: var(--color-primary); font-size: var(--font-size-header); }
.guide-section__heading h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.guide-list { display: grid; gap: 10px; margin: 14px 0 0; padding-left: 20px; }
.guide-list li { color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.7; }
.guide-list code { padding: 1px 5px; border-radius: var(--radius-tag); color: var(--color-text-primary); background: var(--color-bg-subtle); font-family: var(--el-font-family); font-size: var(--font-size-badge); }
</style>
