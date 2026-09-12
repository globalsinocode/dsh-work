# dsh-work 接入 AI Hub 身份服务

本文的命令与表单示例以本地 `local` 环境为主。若 AI Hub 已在 Mac mini 上以纯 IP HTTPS
部署，生产地址、`production` 环境登记和首次安装顺序请使用
[Mac mini 部署流程（AI Hub 已部署）](mac-mini-deployment-runbook.md)，不要照搬下文的
localhost、HTTP 或开发端口。

## 1. 责任边界

dsh-work 采用“统一身份、应用自主授权”模式：

- AI Hub 负责 OIDC 登录、稳定 `user_id`、账号状态、基础员工资料和增量员工目录；
- dsh-work 负责角色、功能权限、数据范围、Session 撤销和全部业务鉴权；
- 浏览器只持有 dsh-work 的不透明 HttpOnly Session Cookie，不持有 AI Hub Token；
- dsh-work 不调用 AI Hub `/me/permissions` 或在线授权决策，也不在 AI Hub 登记 `dsh_work.*` 权限点；
- 员工端和管理端共用一个 AI Hub 应用环境凭据，只使用不同回调地址和不同 dsh-work Session Cookie。

这与“使用 Google 账号登录、业务应用自己配置权限”的边界一致。AI Hub 中的平台登记人、应用负责人和环境初始管理员相互独立：登记人只留审计，负责人承担治理与联络，只有环境明确指定的初始管理员可以一次性初始化 dsh-work 首位本地超级管理员。

## 2. AI Hub 应用与环境

只创建一个应用：`dsh-work`。不要再创建 `dsh-work-admin`。

创建应用时从员工目录选择业务负责人；该选择不授予 dsh-work 权限。创建 `local` 环境时，再把“初始管理员”设为准备首次登录 dsh-work 管理后台的员工。两者可以是同一人，也可以不同，并且都必须是 AI Hub 员工目录中状态为 `ACTIVE` 的用户。

本地开发环境表单填写如下：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| 环境标识 | `local` | 对应 `AI_HUB_ENVIRONMENT` |
| 版本 | 实际部署版本 | 与 `server/package.json` 的 `releaseVersion` 或已验证 Release 一致 |
| 门户入口 | `http://localhost:4174/workbench` | 从 AI Hub 打开应用时进入员工端 |
| API 地址 | `http://host.docker.internal:4190/api` | AI Hub 在 Docker 内运行时使用；原生运行改为 `http://localhost:4190/api` |
| 健康检查 | `http://host.docker.internal:4190/health` | AI Hub 在 Docker 内运行时使用；原生运行改为 `http://localhost:4190/health` |
| OIDC 回调地址 | 见下方两行 | 必须逐字匹配，不加尾部 `/` |
| 初始管理员 | 准备首次登录管理端的业务员工 | 从员工目录选择；仅对 `local` 环境生效 |
| 状态 | 启用 | 应用和环境都必须为 ACTIVE |

OIDC 回调地址文本框每行一个：

```text
http://localhost:4190/auth/workbench/callback
http://localhost:4190/auth/admin/callback
```

`host.docker.internal` 是 AI Hub 容器访问宿主机服务的地址；OIDC 回调由浏览器访问，仍使用 `localhost:4190`。使用前者时 dsh-work 应设置 `DSH_WORK_SERVER_HOST=0.0.0.0`。

## 3. Scope 与凭据

应用环境凭据需要包含：

- 用户登录：`openid`、`profile`、`email`、`offline_access`、`ai_hub.identity`、`platform.me.read`；
- 初始管理员认领：`platform.application.bootstrap`；
- 员工目录服务同步：`platform.directory.read`。

`platform.application.bootstrap` 只允许当前环境明确登记的初始管理员认领一次；应用负责人和平台登记人都不会隐式获得该资格。`platform.directory.read` 只允许绑定到该应用的 Service Token 使用。不要登记以下旧配置：

- `dsh_work.workbench.use`、`dsh_work.admin.write` 等 AI Hub 应用权限；
- AI Hub 应用角色或 AI Hub 数据范围；
- `platform.authorization.decide`；
- 为通过接入认证而启用与本应用无关的通知能力。

在 AI Hub「密钥管理」为 `local` 环境创建或轮换凭据。`client_secret` 只显示一次，应立即进入本地 `.env` 或受管 Secret Manager，不得提交 Git。员工端和管理端必须使用同一组 Application ID、Issuer、Client ID 和 Client Secret。

接入治理选择 `OIDC_ONLY`，而不是旧的 `API_ONLY`。

## 4. dsh-work 环境变量

```dotenv
DSH_WORK_AUTH_MODE=oidc
DSH_WORK_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>

AI_HUB_PLATFORM_URL=http://platform.localhost:8088
AI_HUB_APPLICATION_ID=dsh-work
AI_HUB_ENVIRONMENT=local
AI_HUB_OIDC_ISSUER=<AI Hub 凭据弹窗中的 Issuer>
AI_HUB_CLIENT_ID=<AI Hub 凭据弹窗中的 Client ID>
AI_HUB_CLIENT_SECRET=<一次性显示的 Client Secret>
AI_HUB_OIDC_AUDIENCE=<通常与 Client ID 相同>

AI_HUB_WORKBENCH_PORTAL_URL=http://localhost:4174
AI_HUB_WORKBENCH_REDIRECT_URI=http://localhost:4190/auth/workbench/callback
AI_HUB_ADMIN_PORTAL_URL=http://localhost:4180
AI_HUB_ADMIN_REDIRECT_URI=http://localhost:4190/auth/admin/callback

DSH_WORK_SESSION_SECRET=<openssl rand -base64 48 的完整输出>
DSH_WORK_COOKIE_SECURE=false
DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS=900
```

本地 Vite 代理保留浏览器的 Host（`changeOrigin: false`），登录与 API 校验使用
`localhost:4174/4180`。上面的旧单入口配置仍支持直接回调 `localhost:4190`：
仅回调处理会把已配置的回调 Origin 映射回对应门户，不会将后端端口加入登录/API
白名单。启用多 Origin 后，每个回调必须与发起登录时的入口一致。

`DSH_WORK_SESSION_SECRET` 直接填写命令输出的一整行，不要包含尖括号。生产环境必须使用独立随机值、HTTPS、`DSH_WORK_COOKIE_SECURE=true`，目录同步间隔必须为正数，建议从 `900` 秒开始。服务会在启动后立即对账一次；`0` 只允许用于隔离的非生产诊断，此时需要管理员手工同步。

服务端会拒绝员工端与管理端配置不同的应用或凭据，因此不再支持 `dsh-work-admin` 独立应用模式。

## 5. 首位管理员与后续授权

首次启用步骤固定为：

1. AI Hub 中登记应用负责人，在 `local` 环境单独指定初始管理员，并创建环境凭据；
2. 启动 dsh-work，迁移会创建本地身份映射、授权版本、初始管理员记录和目录同步状态；
3. 环境初始管理员打开 `http://localhost:4180` 并完成 AI Hub 登录；
4. dsh-work 读取 `/me` 建立本地用户，调用一次性 `admin-bootstrap`，然后只在本地授予 `platform_admin`；
5. 初始管理员进入“员工与权限”，同步员工目录并为其他员工配置角色和数据范围；
6. 至少再配置一位平台管理员，避免首位管理员停用后无人维护。

后续登录不依赖 AI Hub 中的业务角色。权限变更会增加本地 `local_authorization_version`，现有 Session 下一次请求立即使用新权限；停用员工会撤销其全部 dsh-work Session，但保留本地授权记录用于审计或恢复。

Bootstrap 只在本地认领记录首次原子写入时授予 `role-platform-admin`。同一初始管理员重试已领取的 AI Hub Bootstrap 不会补回后来在 dsh-work 中明确撤销的管理员角色。

系统禁止移除最后一位有效平台管理员。若所有管理员都在 AI Hub 被停用，需由数据库运维按变更流程为一个已同步且有效的本地用户恢复 `role-platform-admin`，并记录审计/工单；不能通过新建第二个 AI Hub 应用绕过恢复流程。

`role-platform-admin` 不允许设置自动到期时间，避免最后一个管理员因定时过期导致系统锁死；管理员生命周期通过显式授权、撤权和审计记录管理。

## 6. 员工目录同步

管理后台“员工与权限”支持：

- 增量同步：使用保存的 opaque cursor 读取 AI Hub 变更；
- 重新全量同步：从目录起点重读所有员工；
- 同步状态：最近开始、最近成功、错误、处理数量；
- Tombstone：AI Hub 非 ACTIVE 用户映射为本地停用并撤销 Session。

上述查询可由具有管理读取权限的账号查看；同步、角色编辑、员工授权和 Session 撤销只允许本地 `admin:*` 平台管理员执行，普通 `admin:write` 不具备身份授权管理能力。

同步只更新 `external_user_id`、subject、姓名、邮箱、组织、业务用户标记和账号状态。`business_user=false` 的 AI Hub 平台账号会被停用、撤销会话并从员工授权列表排除。同步绝不新增、删除或覆盖 dsh-work 的角色、功能权限和数据范围历史。

## 7. 验收顺序

1. 执行 `pnpm --filter @dsh-work/server db:migrate`；
2. 执行 `pnpm test:sso` 和使用测试数据库执行 `pnpm test:sso:integration`；
3. 在 AI Hub 执行 `OIDC_ONLY` 接入认证；
4. 使用环境中登记的初始管理员首次登录管理端，确认自动获得本地平台管理员；
5. 手工同步员工，确认新员工默认没有角色；
6. 为测试员工分配 `employee`，确认可以登录员工端；
7. 移除角色，确认下一个请求立即 403，而不是等待 AI Hub Token 过期；
8. 修改用户和角色数据范围，确认运行授权使用本地合并结果；
9. 在 AI Hub 停用测试员工并同步，确认 Session 被撤销；
10. 停止 AI Hub Platform API：已有 dsh-work Session 不直接依赖 Platform API；另停用 OIDC Token Endpoint，确认 Token 进入到期前 30 秒刷新窗口后请求被阻断。不要把 Session 默认 8 小时期限当作离线窗口；
11. 验证不能移除最后一位平台管理员，并检查所有变更均写入 `audit_events`。

## 8. 外部待办

代码无法替代以下真实环境操作：

- 在 AI Hub 创建/升级 `dsh-work` 应用，分别登记业务负责人和各环境初始管理员；
- 轮换凭据以包含 Bootstrap 与 Directory Scope，并安全保存 Secret；
- 将生产 Session Secret 写入 Secret Manager；
- 配置 HTTPS、Cookie、服务可达性与定时目录同步；
- 完成真实账号、停用、故障和恢复 UAT，保存 AI Hub 接入认证与 dsh-work 审计证据。

## 账号切换与门户会话

平台账号被 `business_user_required` 拒绝时，错误页的“切换账号”访问对应 Audience 的 `/auth/workbench/switch-account` 或 `/auth/admin/switch-account`。服务端撤销当前应用 Session，并新建带 `prompt=login`、PKCE、state 和 nonce 的授权事务，锁定原入口及回调。不能把普通 OIDC `end-session` 当作账号切换：未登记退出回跳时 Authentik 会忽略该回跳，已登记回跳时又要求有效 ID Token hint，均不能保证返回当前业务应用。

AI Hub 门户与 dsh-work 的应用 Session 独立。切换 dsh-work 身份不会自动撤销 AI Hub 门户已有的管理员 Session；验收应确认业务人员最终回到原员工端或管理端，且该应用会话的身份为所选员工，而不是根据另一个门户显示的账号判断。
