# v2026.10.19-01 修复问题分类

记录日期：2026-10-19。分类依据是目标机诊断问卷第 14–16 节，以及已安装 Release `v2026.10.19-01`（`ee90ad8`）中的修复。生产活动版本从 2026-10-19 10:22 起就是这一版。

## 1. 已修复并已在生产运行

这些是本次候选要消除的未分类失败和日志缺口。P2 已在目标机专用测试 Agent 上复核，没有重放生产业务 Agent。

### 1.1 Agent 创建返回未分类 500

客户端再次使用已存在的 Agent ID 时，PostgreSQL 返回 `23505` / `agents_pkey`。服务只在 `createAgent` 的事务周围把这一约束映射为 409 `state_conflict`，消息为「Agent 标识已存在，请刷新列表后重新创建」。

P2：专用 Agent 首次创建 201，审计 `agent.create` / `success` 一条；同一 ID 再次创建 409，`agents` 与 `agent_versions` 仍各 1 行。

### 1.2 草稿保存返回未分类 500

草稿 PATCH 在校验类型之前对字段调用 `.trim()` 或 `unique()`。非法 JSON 因此变成 500。解析器现在对错误字段返回 422 `invalid_request`，消息只说明字段名和期望类型。空白字符串仍交给原有的规范化逻辑。`delegationPolicy` 在出现且不是 `null` 时必须是对象，`allowedAgentVersionIds` 必须是字符串数组，避免在业务校验前抛出 TypeError。

P2：去掉 `welcomeMessage` 的 PATCH 返回 422，revision 和版本数不变，没有新的 `agent.draft.update` / `success` 审计。

### 1.3 发布试运行的冲突语义

当前入口是 `POST /api/admin/v1/agents/:agentId/release/case-trials`。前置条件不满足时返回 409 `state_conflict`，不创建 trial、Run、Attempt。没有 `trialId` 的旧入口 `POST .../release/trials` 保持 404 `route_not_found`。

P2：禁用执行身份后的 case-trials 返回 409，三张表行数都是 0；旧入口返回 404。

### 1.4 供应商拒绝被误读成另一类故障

目标机历史失败 Attempt 的主因是供应商 401、少量额度 403，以及畸形提示词。没有 usage/tool 证据时，既有审计收尾会打出一条 `mcp invocation audit failed`。这条告警不改写主失败，也不把错误码改成 MCP 认证或可用性错误。

本次用合成 Worker 锁住两条标记：消息分别是 `Invalid token` 和 `quota is not enough`，类别是 `provider`，错误码保持 `RUNTIME_EXECUTION_FAILED`。生产适配器不识别测试标记。目标机 P2 没有用真实密钥重放 401/403。真实 DSH 的正常 Attempt 终态为 `succeeded`，有 usage 记录，工具调用数为 0。

### 1.5 504 无法跨层对齐，且建连失败等待过长

请求号只接受 32 位十六进制 `X-Request-Id`，否则由服务生成。响应头返回该值。`traceId` 仍是 `trace-http-` 加 UUID，不与请求号合并。失败日志增加 ISO 时间和 `requestId`，不记录原始 URL、查询串、Cookie 或密钥。

Nginx 每个 server 使用 JSON 访问日志，并覆盖镜像自带的 `main` 格式，避免查询串进入 `access.log`。`proxy_connect_timeout` 为 5 秒。`/api/` 的读写超时仍是 3600 秒。

P2：探测请求的 Nginx `request_id` 与应用 `requestId` 一致，`uri` 不含查询串。观察窗口 10:22–10:55 有 1 条启动期 `/health/live` 504，建连时间为 `"-"`，响应时间 5.006 秒；业务请求的建连时间最长 0.038 秒。

## 2. 已定位，只做了失败加速，没有根治

Docker 里的 Nginx 连接 `host.docker.internal:4190` 会间歇超时。诊断阶段 23 小时内有 6 次 504，与业务请求无关。5 秒建连上限只让这种失败更快出现。继续出现时按 Runbook 第 14 节记录，不能写成拓扑已经修好。P2 窗口里的那条 504 属于启动期健康探测。

## 3. 本次之前已经处理，只作为回归边界

诊断问卷把下列项列为历史缺陷，不在 `v2026.10.19-01` 里重新修复：

- `duplicate loader entry id: mcp-skillhive`
- `MCP_CREDENTIAL_STORE_UNAVAILABLE`
- 白名单漏 `skillhive`。2026-10-19 复查已发布版本的连接器白名单为 0 行遗漏
- `~/.dsh/settings.yaml` 缺少 ACP 路由
- 工具绑定漂移造成的 403。处置是重新发布，不是改库
- 2026-10-16 的管理端回车提交热修已在 2026-10-17 回滚。两条 500 的时间窗口早于该热修，不能归因于它

两条 500 也不在同一个 Release 区段：草稿 `trim` 落在 `v2026.10.09-03` 期间，重复主键落在 `v2026.10.09-03` 末期或 `v2026.10.16-01` 启动后的前几分钟。

## 4. 发布和验收过程中暴露的缺口

这些不是应用代码缺陷。它们决定这次安装能不能写成无偏差正式验收，以及以后的 Release 会不会自动装上。

| 类别 | 现象 | 当前处置 |
| --- | --- | --- |
| 异机备份 | `/Volumes/dsh-work-backups` 不存在。两个已挂载部门共享对 `deploy` 不可写，且不是批准的备份目标 | 2026-10-19 14:24 决定不重装。缺口保留。自动升级保持关闭 |
| 安装偏差 | 因备份闸门缺失，使用已授权的 S1 偏差包切换到 `v2026.10.19-01`。包字节和来源证明未改 | 升级前备份留在 `backups/preupgrade-20261019T020916Z`。回滚未演练，回滚目标是 `v2026.10.16-01` |
| 模型凭据 | P2 第 5 项使用当时提供的测试密钥 `globalsino-deepseek` / `deepseek-flash` | 密钥失效后，新的模型 Attempt 会在供应商认证处失败。已落库证据不改写。第 1–4、6–7 项不依赖该密钥 |
| 会话中断 | 验收中管理员会话曾返回 `401 session_expired` | 更换会话后完成第 4、6、7 项。未把 Cookie 写入回填 |
| 预检记账 | 仓库内 pnpm 是 `11.7.0`，快照写的全局 pnpm 是 `11.24.0`。候选提交必然不同于基线 `667b00e` | 这两项不算测试失败。生产运行不使用 pnpm |
| 证据边界 | Windows 全量套件有既有环境失败。目标机沙箱里 `/bin/ps` 出现 `spawn EPERM`。浏览器旅程未在目标机重跑 | 不把这些失败当成 `v2026.10.19-01` 的回归 |
| 仓库分叉 | 生产仓库是 `globalsinocode/dsh-work`。`tonycc/dsh-work` 的 `main` 仍是 `e846ac3`，没有这个 Release | 后续发布只走 `globalsinocode`。不要从另一个远程发版覆盖目标机 |
| 已安装版本与 `main` 的差距 | `main` 现为 `719d5d9`，比 `ee90ad8` 多 3 个提交：团队空间快捷键、Windows 本地 DSH 路径、一次合并。`releaseVersion` 仍是 `2026.10.19-01` | 修复还在 `main` 上。这 3 个提交尚未发布。现有门禁不能用同一版本号再发一次 |

## 5. 分类结论

应用侧本次要修的未分类 500、试运行冲突、供应商拒绝分类和请求关联，已经在 `v2026.10.19-01` 上运行，并由第 16.2 节逐项通过。

仍开放的是三类运维边界：异机备份目录缺失、自动升级关闭、504 的宿主机连接拓扑未根治。2026-10-19 14:24 已经选择保持当前安装，不因备份缺口回滚这版修复。
