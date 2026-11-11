# Docker 全栈部署

Mac mini / launchd **不是**本路径的目标。这里 **PostgreSQL、API+DSH、Nginx 静态前端** 都在容器里跑，和 `deploy/compose.yaml`（仅 PG + Nginx、API 在宿主机）不同。

## 容器一览

| 容器名 | 镜像 | 作用 |
| --- | --- | --- |
| `dsh-work-postgres` | postgres:17 | 业务库 |
| `dsh-work-server` | `dsh-work/server:latest` | API、DSH ACP、执行容器调度（挂 `docker.sock`） |
| `dsh-work-web` | `dsh-work/web:latest` | HTTPS + 员工端/管理端 `dist` + 反代 API |

执行 Attempt 时仍会 **额外** 拉起短命 Linux 执行容器（由 `DSH_WORK_EXECUTION_IMAGE` 指定），与 Mac 生产行为一致，只是 API 也在 Docker 里。

## 首次启动

```bash
pnpm docker:init-env          # 生成 deploy/docker/stack.env
# 编辑 stack.env：POSTGRES 密码、DSH_WORK_SESSION_SECRET、DSH_WORK_ACP_PROVIDER/MODEL 等
pnpm docker:tls             # 自签 TLS（浏览器需信任一次）
docker pull <stack.env 里的 DSH_WORK_EXECUTION_IMAGE>
pnpm docker:up              # 构建镜像（含 DSH harness，耗时可较长）并后台启动
```

**Windows / amd64 执行镜像：** CI 推到 GHCR 的是 **arm64**，在 Windows 上 `docker pull ghcr.io/.../execution@sha256:…` 拉得到也 **跑不了**。请在本机构建并写 digest：

```bash
pnpm docker:execution-image
# 把输出的 DSH_WORK_EXECUTION_IMAGE=… 写入 .env 与 deploy/docker/stack.env
```

不要用 `localhost:5000/...`，除非你自己起了 registry（`docker run -p 5000:5000 registry:2`）并把镜像 push 进去。以前删掉的 `dsh-work-local-registry` 就是这类服务。

访问（接受自签证书）：

- 员工端：https://localhost:4174/workbench  
- 管理端：https://localhost:4180/overview  

首次管理员：保持 `DSH_WORK_ADMIN_BOOTSTRAP_ENABLED=true`，打开管理端 bootstrap 路径创建账号后改回 `false`。

模型密钥：写入 DSH 凭据（`DSH_HOME` 卷 `/app/deploy/.dsh`），**不要**写进 `stack.env`。按 DSH 文档在容器内或挂载卷中配置 Credentials Provider。

## MCP 用户授权（OAuth）探活

管理端新增 **用户授权** 型 MCP 时，OAuth 回调固定为员工台 origin（`DSH_WORK_WORKBENCH_DEFAULT_ORIGIN`，Docker 全栈一般为 `https://localhost:4174`），**不是**管理端 4180。上游 IdP（如 data-hub）须登记回调：

`https://localhost:4174/api/workbench/v1/mcp-grants/callback`

| 现象 | 常见原因 |
| --- | --- |
| 弹窗「授权失败」 | 授权/令牌端点不是有效 `http`/`https` URL；或 `DSH_WORK_WORKBENCH_ORIGINS` 未配置 |
| `连接器 mcp 操作未完成` | 未处理的异常（配置错误会以 422 返回具体文案）；探活换票失败、或容器内连不上表单里的 `localhost` MCP/OAuth |
| 员工台提示「授权没有完成，请重试」 | 常为换票后 JWT `iss` 与登记表单中的**授权端点**不一致（如 data-hub 授权页在 5175、令牌在 3005）；须先登录 4174 再点同意；换票失败也会落此提示 |
| 外部连接显示「管理员尚未登记…」 | 管理端只做过 OAuth 探活、未点「添加 MCP」时库里没有 `user_oauth` 连接器；探活成功 ≠ 已登记 |
| 授权后仍不能点「添加 MCP」 | 须先在同浏览器登录员工台（4174），用**与管理端相同账号**完成回调；授权后回到管理端再点一次「测试连接」 |
| `redirect_uri` 未登记 | IdP 客户端未包含上表回调（勿只登记 4180） |
| Scope / resource 不符 | 与上游约定一致（例如 data-hub：`mcp:read`，`resource` 与 MCP 端点完全一致） |
| 同意后员工台仍「授权没有完成」 | 常见为**令牌端点写错**：`http://localhost:3005/oauth/token` 返回 **404**，应改为 `http://localhost:3005/api/oauth/token`；授权页为 `http://localhost:5175/api/oauth/authorize` |

**Docker 注意：** API 在容器内执行发现与换票。表单里若 MCP 或 OAuth 跑在宿主机，请把地址中的 `localhost` 改为 `host.docker.internal`（Windows/Mac Docker Desktop），否则连通测试会在容器内连错目标。

## 日常

- Docker Desktop 里对三个容器 **Start / Stop**（`restart: unless-stopped`）。
- `pnpm docker:logs` — 日志  
- `pnpm docker:down` — 停栈（不删数据卷）

## 本地改代码热更新

与 **本 compose 不要同时占用 4174/4180**。开发用热更新单容器：

```bash
pnpm dev:docker
```

见 [`deploy/dsh-work.compose.yaml`](../dsh-work.compose.yaml)（容器 `dsh-work-dev-hot`，镜像 `dsh-work:dev-hot`）。

## 数据卷

- `dsh-work-postgres-data` — 数据库  
- `dsh-work-app-data` — 上传/Skill 等（`DSH_WORK_DATA_ROOT`）  
- `dsh-work-dsh-home` — DSH 配置与凭据（`DSH_HOME`）
