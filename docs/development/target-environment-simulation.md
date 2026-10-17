# 目标环境模拟：供应商拒绝与审计告警

用隔离工作树和可丢弃 PostgreSQL 复现供应商 401/403、畸形提示词，以及「没有 usage/tool 证据时的审计告警」。合成 Worker 只在 ACP `session/prompt` 失败。生产适配器不识别测试标记，不新增 HTTP 模型代理，也不另建 Agent 执行循环。

对齐基准是 [`config/target-environment/2026-10-17.json`](../../config/target-environment/2026-10-17.json)。

| 项 | 基准 |
| --- | --- |
| 源提交 | `667b00ea12db2db599f0966c7866c32238583018` |
| Node | 26.8.1 |
| pnpm | 11.24.0 |
| PostgreSQL | 17.11 |
| DSH | 0.1.2-rc.1，提交 `76fda729799fe9b3848dbe2c211d4b231032b81e`，profile `acp-app` |
| 迁移 | 到 `0081` |

## 隔离工作树

在主仓库外建独立工作树，不在当前开发目录里改目标提交：

```powershell
git fetch target
git worktree add --detach ..\dsh-work-target-simulation target/main
git -C ..\dsh-work-target-simulation rev-parse HEAD
```

`HEAD` 必须等于基准里的 `sourceCommit`。若 `target/main` 已经前进，只在这个工作树里 `git switch --detach 667b00ea12db2db599f0966c7866c32238583018`。后续命令都在该工作树根目录执行。

Node 使用 26.8.1，pnpm 使用 11.24.0。DSH 使用锁定提交的独立 checkout，并把 `DSH_RUNTIME_HOME` 指到该目录。profile 以存在 `packages/bundle/acp-app/cordis.patch.yml` 为准。`DSH_RUNTIME_COMPATIBILITY` 保持未设置。不要复制目标机的 `runtime.env`，也不要复制 `~/.dsh`。

## 仿真环境文件

`.gitignore` 已忽略 `.env.*`（保留 `.env.example`）。在工作树根目录从 [`deploy/runtime.env.example`](../../deploy/runtime.env.example) 生成 `.env.target-simulation`：

- 只保留模板结构。口令、主密钥和其他凭据在本机临时生成，只写入这个文件。
- 数据库指向下面的容器和库 `dsh_work_target_sim`。同时准备 `DSH_WORK_DATABASE_URL` 与 `DSH_WORK_TEST_DATABASE_URL`。
- `DSH_RUNTIME_HOME` 指向本次模拟的 DSH checkout。不要把 `DSH_HOME` 指到操作者的 `~/.dsh`。
- 不要把目标机 `runtime.env` 拷进来，不要把生成后的值贴进本文档、提交或终端回显。

把该文件载入当前进程后再跑预检和测试。不要打印文件内容。

## 可丢弃 PostgreSQL

只创建这一个容器，使用匿名数据卷，主机端口仅绑定环回地址：

```powershell
docker run -d --name dsh-work-target-sim-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=<本地生成的测试口令> -e POSTGRES_USER=dsh_work_sim -e POSTGRES_DB=dsh_work_target_sim postgres:17.11
```

迁移这个库，并确认 `schema_migrations` 到达 `0081`：

```powershell
$env:DSH_WORK_DATABASE_URL = '<指向 dsh_work_target_sim 的连接串>'
pnpm --filter @dsh-work/server db:migrate
```

预检读取当前进程的 Node、pnpm、`HEAD`、Runtime lock、`DSH_RUNTIME_HOME` 和 `DSH_WORK_TEST_DATABASE_URL`：

```powershell
$env:DSH_WORK_TEST_DATABASE_URL = '<同一可丢弃实例上的连接串>'
pnpm preflight:target-simulation
```

预检通过后再跑 Task 2 与 Task 3 的集成测试。它们会从该实例的 `postgres` 维护库各自创建并销毁一次性库：

```powershell
node --experimental-strip-types --test server/src/infrastructure/postgres/agent-draft-api.integration.test.ts
pnpm test:agent-release:integration
```

## 场景

供应商拒绝发生在模型回合。`failPrompt` 仍发送 `{ code: -32000, message, data: { category } }`。这两条标记的 `category` 不是 `model`，因此 `classifyRuntimeFailure` 保持 `RUNTIME_EXECUTION_FAILED`，而不是 `MODEL_INVOCATION_FAILED`。消息分别就是 `Invalid token` 和 `quota is not enough`。

审计告警沿用 `dsh-acp-runtime-adapter.ts` 的 `finally`：Manifest 有 `mcp_connections`、会话没有 usage/tool 证据时，`finalizeMcpAudit` 抛出，适配器执行既有的 `console.warn('mcp invocation audit failed', ...)`。不新增告警点。该告警不改写主失败。

合成链路的证据命令：

```powershell
node --experimental-strip-types --test --test-name-pattern "provider-401|provider-quota-403" server/src/modules/runtime/runtime-adapter.test.ts
```

| 场景 | 区分 | Run / Attempt | 错误码 | 日志或事件 | 预期状态 |
| --- | --- | --- | --- | --- | --- |
| `[provider-401]` | 主因 | 测试清单 `run-provider-401` / `attempt-1`。真实模拟各自新建 Run 与 Attempt。失败点是 ACP `session/prompt` | `RUNTIME_EXECUTION_FAILED`，消息 `Invalid token` | `run.started` 之后是 `run.failed`。reason 就是该消息。不含合成 token、`Authorization` 头值或完整上游响应体 | Attempt `failed`。不改写为 `MCP_AUTHENTICATION_REQUIRED`、`MCP_AUTHENTICATION_FAILED` 或 MCP 可用性错误 `dependency_unavailable` |
| `[provider-quota-403]` | 主因 | 测试清单 `run-provider-quota-403` / `attempt-1`。失败点同样是模型回合 | `RUNTIME_EXECUTION_FAILED`，消息 `quota is not enough` | 与上一行相同，reason 为该消息 | Attempt `failed`。分类边界与 401 相同 |
| 畸形提示词 | 主因 | 系统提示词含 `{{simToday}}` 的新 Run / Attempt。真实 DSH 在模型回合失败 | `RUNTIME_EXECUTION_FAILED` | `Internal error: turn failed: malformed prompt variable reference "{{simToday}}"` | Attempt `failed`。这是提示词回合失败，不是 MCP 认证或可用性错误 |
| 无 usage/tool 证据 | 下游告警 | 与上面任一主因同一个 Attempt。Manifest 含 MCP 连接，且会话目录没有 `session.jsonl` | 主因错误码不变 | 恰好一条 `mcp invocation audit failed`，正文含「DSH MCP 会话日志不可用，不能确认调用审计完整」 | Attempt 仍是 `failed`。告警不替换主失败 |
| 独立 504 | 独立失败 | 另一个 Attempt：依赖超时，或执行时限耗尽 | HTTP `504` / `dependency_timeout`；执行时限耗尽时 Attempt 为 `RUN_TIMEOUT` | 超时原因。不是 `Invalid token`、`quota is not enough` 或畸形提示词正文 | 单独的 `failed`。不要把它并进 401/403 或审计告警 |

## 清理

只删除这次显式创建的对象：

```powershell
docker exec dsh-work-target-sim-pg dropdb --if-exists -U dsh_work_sim dsh_work_target_sim
docker rm -f -v dsh-work-target-sim-pg
git worktree remove --force ..\dsh-work-target-simulation
```

`docker rm -v` 只移除容器 `dsh-work-target-sim-pg` 的匿名数据卷。`dropdb` 只删除库 `dsh_work_target_sim`。`git worktree remove` 只删除该工作树（其中的 `.env.target-simulation` 随工作树消失）。不要 `docker volume prune`，不要递归删除父目录或其他容器。

## 证据边界

在这台 Windows 主机上，完整的 `pnpm test:m1` 不能作为本链路的证据。该套件已有与本次改动无关的失败：符号链接 `EPERM`、Unix socket `EACCES`，以及 POSIX 路径假设。本链路的证据是名称匹配 `provider-401` 与 `provider-quota-403` 的 runtime 测试。
