# dsh-work 移动端（H5）接入规范

> 面向移动端 H5 客户端（含 AI Agent 阅读）的对接约定。契约唯一事实来源：
> `docs/development/openapi-mobile-h5.json`（仅收录移动端实际调用的端点）、`docs/development/run-event.schema.json`。
> 本文与 AdminShell「开发接入 → 接入规范」页面内容保持一致。

## 1. 定位与边界

- 移动端是独立的 API 消费方，与员工工作台（workbench-web）平级，独立工程、独立部署产物。
- 服务端只提供 Workbench API（`/api/workbench/v1`），不为移动端新增第二套执行链路。
- 所有 Agent 交互必须经 Run/Attempt API 发起；禁止绕过 dsh-work 直连模型 API。
- 管理平台 API（`/api/admin/v1`）不属于移动端接入范围。

## 2. 部署形态与同源访问

- 移动端入口（独立端口或二级域名）必须由自身网关/nginx 反代 `/api` 与 `/auth` 到 dsh-work 服务端。
- 服务端不提供 CORS；浏览器视角必须同源，禁止跨源直连 API。
- 推荐二级域名（如 `m.example.internal`）+ HTTPS：与桌面端天然隔离 Cookie 会话。
- 同 IP 不同端口可行，但 `dsh_work_session` Cookie 按 host 隔离、不认端口，会与桌面端共享会话。

### 部署清单

1. nginx 为移动端 origin 新增 server block：`/` 指移动端静态产物；`location /api/`、`location /auth/` proxy_pass 到 dsh-work 服务端，并 `proxy_buffering off`（SSE 必需）。
2. 服务端 `DSH_WORK_WORKBENCH_ORIGINS` 追加移动端 origin（所有 origin 须同端口）。
3. AI Hub 应用 `dsh-work` 的回调地址追加一行：`<移动端 origin>/auth/workbench/callback`（逐字匹配、无尾斜杠）。不新建 AI Hub 应用。

## 3. 认证与会话

- 发起登录：浏览器跳转 `GET /auth/workbench/login` → AI Hub OIDC → 回调建立会话。
- 会话凭证：服务端签发 HttpOnly Cookie `dsh_work_session`（SameSite=Lax, Path=/）。客户端不持有 token。
- 后续请求自动携带 Cookie；同源部署下无需任何 header。
- 会话失效返回 `401`，error.code 为 `authentication_required`：引导用户重新走登录跳转。
- 登出：`POST /auth/workbench/logout`（GET 亦可）；切换账号走 `/auth/workbench/switch-account`。
- 角色、权限、数据范围由服务端裁决，客户端传入的任何权限字段都会被忽略。

## 4. 请求与响应

- 前缀：`/api/workbench/v1`，请求与响应均为 `application/json`。
- 成功包络：`{ "data": ..., "meta": { "api": "...", "adapter": "...", "timestamp": "..." } }`，业务数据只读 `data`。
- 失败包络：`{ "error": { "code", "message", "object?", "suggestion?", "traceId?" } }`。
  - `code`：稳定机读标识，用于分支处理。
  - `message`/`suggestion`：面向用户展示。
  - `traceId`：排障凭证，上报问题时携带。
- 常见状态码：401 未登录、403 无权限、404 不存在、409 状态冲突、421 入口来源未登记（检查 ORIGINS 白名单）。
- 列表接口游标分页：响应含 `nextCursor`，下一页以同名 query 参数回传；`nextCursor` 为空即到底。

## 5. 事件流（SSE）

- 端点：`GET /api/workbench/v1/runs/{runId}/events`，`Content-Type: text/event-stream`。
- 浏览器用原生 `EventSource` 接入；每条事件携带 `id`（游标）与 `event`（类型）。
- 断线后浏览器自动带 `Last-Event-ID` 重连，服务端从该游标续传，不丢事件。
- 服务端周期发送 `: heartbeat` 注释行保活；Run 进入 `succeeded`/`failed`/`cancelled` 终态后流结束，客户端应停止重连。
- 事件载荷结构以 `docs/development/run-event.schema.json` 为准；团队成员被收权时流会主动终止。

```text
id: 41
event: run.step.started
data: {"runId":"run-…","step":"…"}

: heartbeat
```

## 6. 版本兼容

- `v1` 内只增不删、向后兼容；破坏性变更发布 `v2` 并预留迁移窗口。
- 客户端应按字段可选容忍未知新增字段（不严格校验未知 key）。

## 7. 联调环境

- Prototype 模式（内存数据、受控身份）仅用于冒烟联调，不能作为验收依据。
- 验收必须使用 PostgreSQL + OIDC 完整环境（`docs/development/development.md`）。
- 移动端发现的服务端缺陷回 dsh-work 仓库修复，不在客户端绕过。

## 8. 最小接入路径

1. 部署移动端静态产物 + nginx 反代 `/api`、`/auth`（见 §2）。
2. 跳转 `/auth/workbench/login` 完成登录，随后 `GET /api/workbench/v1/session` 拿当前用户。
3. `POST /api/workbench/v1/sessions` 建会话 → `POST /sessions/{id}/runs` 发起任务 → `GET /runs/{runId}/events` 订阅 SSE 渲染进度。
4. 列表、详情、文件下载等按需调用 `openapi-mobile-h5.json` 中的对应端点（完整工作台端点见 `openapi-workbench.json`，移动端不需要）。
