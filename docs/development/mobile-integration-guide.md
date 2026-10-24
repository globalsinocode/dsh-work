# dsh-work 移动端（H5）接入规范

> 面向移动端 H5 客户端（含 AI Agent 阅读）的对接约定。契约唯一事实来源：
> `docs/development/openapi-mobile-h5.json`（仅收录移动端实际调用的端点）、`docs/development/run-event.schema.json`、
> `docs/development/openapi-auth.json`（登录与会话）。
> 本文与 AdminShell「开发接入 → 接入规范」页面内容保持一致。

## 1. 定位与边界

- 移动端是独立的 API 消费方，与员工工作台（workbench-web）平级，独立工程、独立部署产物。
- 服务端只提供 Workbench API（`/api/workbench/v1`），不为移动端新增第二套执行链路。
- 所有 Agent 交互必须经 Run/Attempt API 发起；禁止绕过 dsh-work 直连模型 API。
- 管理平台 API（`/api/admin/v1`）不属于移动端接入范围。
- **认证优先使用平台独立账号（账号密码）**；移动端接入**不集成 AI Hub**，不配置、不引导、不依赖 OIDC 回调。

## 2. 部署形态与同源访问

- 移动端入口（独立端口或二级域名）必须由自身网关/nginx 反代 `/api` 与 `/auth` 到 dsh-work 服务端。
- 服务端不提供 CORS；浏览器视角必须同源，禁止跨源直连 API。
- 推荐二级域名（如 `m.example.internal`）+ HTTPS：与桌面端天然隔离 Cookie 会话。
- 同 IP 不同端口可行，但独立登录 Cookie 按 host 隔离、不认端口，会与桌面端共享会话。

### 部署清单

1. nginx 为移动端 origin 新增 server block：`/` 指移动端静态产物；`location /api/`、`location /auth/` proxy_pass 到 dsh-work 服务端，并 `proxy_buffering off`（SSE 必需）。
2. 服务端 `DSH_WORK_WORKBENCH_ORIGINS` 追加移动端 origin（所有 origin 须同端口）。
3. **不要**为移动端配置 AI Hub 应用回调；独立登录不依赖 OIDC。账号由平台管理员在管理端「员工与权限」开通，详见 [独立账号登录](../release/local-authentication.md)。

## 3. 认证与会话

- 能力探测（可选）：`GET /auth/workbench/configuration`。移动端应以 `localEnabled === true` 为接入前提；**忽略或不展示** `aiHubEnabled` 入口。
- 发起登录：浏览器跳转 `GET /auth/workbench/login?return_to=…` → 同源本地登录页（`/login`），或在移动端自建账号密码表单后 `POST /auth/workbench/login`（JSON：`username`、`password`，可选 `returnTo`；必须带与当前入口同源的 `Origin`）。
- 会话凭证：服务端签发 HttpOnly Cookie `dsh_work_local_session`（SameSite=Lax, Path=/；生产多为 Secure / `__Host-` 前缀）。客户端不持有 token。
- 后续请求自动携带 Cookie；同源部署下无需任何 Authorization header。
- 首次登录或管理员重置后可能要求改密：`POST /auth/workbench/password`，或引导到同源 `/change-password`；改密成功会轮换会话，无需再登一次。
- 会话失效返回 `401`，error.code 为 `authentication_required`：引导用户重新走独立登录。
- 登出：`POST /auth/workbench/logout`（GET 亦可）；切换账号走 `/auth/workbench/switch-account`。
- 角色、权限、数据范围由服务端裁决，客户端传入的任何权限字段都会被忽略。
- **明确不做：** 调用 `/auth/workbench/oidc/login`、登记 AI Hub 回调、在 UI 提供「使用 AI Hub 账号登录」。企业 SSO 若将来需要，按桌面端能力另行评估，不属于本规范的默认接入路径。

## 4. 请求与响应

- 前缀：`/api/workbench/v1`，请求与响应均为 `application/json`。
- 成功包络：`{ "data": ..., "meta": { "api": "...", "adapter": "...", "timestamp": "..." } }`，业务数据只读 `data`。
- 失败包络：`{ "error": { "code", "message", "object?", "suggestion?", "traceId?" } }`。
  - `code`：稳定机读标识，用于分支处理。
  - `message`/`suggestion`：面向用户展示。
  - `traceId`：排障凭证，上报问题时携带。
- 常见状态码：401 未登录、403 无权限（含 `password_change_required`）、404 不存在、409 状态冲突、421 入口来源未登记（检查 ORIGINS 白名单）、422 输入无效、429 登录限流。
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

- P0 冒烟服务（内存数据、测试身份）仅用于自动化冒烟，不能作为验收依据。
- 验收使用 PostgreSQL + **独立账号**完整环境（见 [开发与测试](development.md)、[独立账号登录](../release/local-authentication.md)）；**不要求**配置 AI Hub / OIDC。
- 移动端发现的服务端缺陷回 dsh-work 仓库修复，不在客户端绕过。

## 8. 最小接入路径

1. 部署移动端静态产物 + nginx 反代 `/api`、`/auth`；将 origin 写入 `DSH_WORK_WORKBENCH_ORIGINS`（见 §2）。由管理员开通独立账号。
2. `GET /auth/workbench/login` 或自建表单 `POST /auth/workbench/login` 完成独立登录；必要时改密。随后 `GET /api/workbench/v1/session` 拿当前用户。
3. `POST /api/workbench/v1/sessions` 建会话 → `POST /sessions/{id}/runs` 发起任务 → `GET /runs/{runId}/events` 订阅 SSE 渲染进度。
4. 列表、详情、文件下载等按需调用 `openapi-mobile-h5.json` 中的对应端点（完整工作台端点见 `openapi-workbench.json`，移动端不需要）。
