# 2026-11-24 上线后 502 / 503 事件记录

## 1. 摘要

`v2026.11.24-01`（授权复核超时热修）于 2026-11-24T06:14–06:16Z 部署后，员工端出现两类相互独立的故障：

1. **502 `no live upstreams`**：Nginx 上游把 `host.docker.internal` 解析成不可达的 IPv6 ULA
   与可用 IPv4；并发请求下两个地址先后被标记 down，接口 502，`/api/workbench/v1/session`
   先出现 499（客户端超时断开），前端白屏。
2. **503 `RUNTIME_UNAVAILABLE`**：服务启动时执行能力探针偶发失败，随后以
   `UnavailableRuntime` 运行，所有创建任务的请求被拒，直到人工重启服务才恢复。

两者都不改变授权语义，也不涉及 schema、UI 或公共 API。

## 2. 时间线（2026-11-24，UTC+8）

| 时间 | 现象 | 处置 |
| --- | --- | --- |
| 14:32–14:33 | `/workbench` 200，但 `/api/workbench/v1/session` 连续 499 | 排除前端包问题（无头浏览器可正常渲染登录页） |
| 14:37:31 | 登录成功后 `/workspaces`、`/artifacts`、`/agents`、`/knowledge/status`、`/tasks` 五个接口 502 | Nginx `no live upstreams`：上游同时解析到 IPv6 `fdc4:f303:9324::254`（不可达）与 IPv4 `192.168.65.254`（可用） |
| 14:37:45 / 14:39:12 | 两次 `POST /sessions/:id/runs` 503 `RUNTIME_UNAVAILABLE` | 14:41 `launchctl kickstart -k` 重启服务；新启动日志出现 `execution container toolchain: …`，能力恢复 |
| 14:44 | 按运维要求只重启 web 容器 | 随后 110 次请求（60 顺序 + 50 并发）0 个 502；但 2 分钟内仍有 15 次 IPv6 connect 失败，根因未除 |

## 3. 根因一：Nginx 双栈上游与失败标记放大

`deploy/nginx/default.conf.template` 的 upstream 为：

```nginx
upstream dsh_work_server {
  server host.docker.internal:${DSH_WORK_SERVER_PORT};
  keepalive 32;
}
```

Docker Desktop 上该名字会同时解析出 IPv6 ULA 与 IPv4。Nginx 对 IPv6 地址的连接必然失败，
默认 `max_fails=1` 会把该地址标记 down；并发请求继续落在失败地址上，唯一可用地址也在此期间
被标记时，整个 upstream 变成 `no live upstreams`，表现为 502。`session` 接口的 499 是同一
上游问题在浏览器侧的先行表现。

**修复（`2026.11.24-02`）**：upstream 改为显式 `DSH_WORK_UPSTREAM_HOST`（默认
`host.docker.internal`，生产可固定为宿主网关 IPv4），并设 `max_fails=0` 禁止“一次失败标记
down 十秒”的放大；CI 用同一 nginx 镜像渲染模板并执行 `nginx -t`，同时校验默认名与固定 IPv4
两种取值。

## 4. 根因二：启动 DSH 能力探针单次失败

`server/src/main.ts` 启动时先探测 DSH，再探测执行容器（执行镜像/工具链/DSH 叠加层/独占调度），
任一失败即把 Runtime 设为 `UnavailableRuntime`（fail-closed，不降级到宿主执行）。本次启动
DSH 探针失败后没有重试，服务虽然健康监听，但所有 Run 在创建前被拒。

2026-11-24 首启日志（`logs/server.stderr.log:4276`）的第一条带时间戳记录是下游的
`DSH built-in tool catalog check skipped: ExecutionCapabilityUnavailableError: DSH 执行能力不可用`，
说明失败发生在**DSH 能力探针**（不是执行容器）；旧代码对该探针的失败没有 `onFailure` 日志，
因此真正的失败原因在日志里缺失。06:41:27Z 人工 `kickstart -k` 后同一镜像的 toolchain 探针一次
通过，排除执行镜像问题；部署侧首次尝试曾出现 `~/.dsh/profiles/acp/cordis.yml` 的 EPERM，
profile 竞争仍是首要怀疑，需要本版本新增的逐次日志确认。

**修复（`2026.11.24-02`）**：DSH 与执行容器启动探针最多 3 次、间隔 2 秒，逐次记录脱敏日志，
并为 DSH 探针补最终失败日志；预算耗尽仍 fail-closed。重试只消化部署/启动瞬间的竞争性失败，
不放宽能力判定，也不改变“执行容器不可用时拒绝所有 Run”的边界。

**2026-11-24 部署实测（`v2026.11.24-02`）**：该重试因 `deadlineMs=20 s` 小于单次 preflight 的
30 s 超时未生效，首启仍不可用约 15 小时，直到人工 `kickstart -k` 才恢复；部署门禁也只看了
`/health`，把能力不可用判为成功。`v2026.11.25-01` 已修并加入 `/health/ready` 就绪断言，详见
[启动探针重试失效事件](incident-2026-11-24-startup-probe-retry-outage.md)。

## 5. 任务线程目标探测缺陷（重跑暴露，`2026.11.24-02` 一并修复）

**现象**：吴军 08:13–08:20Z 重跑成功、答案正常显示，但任务线程页对任务/Run 报“不存在”。

**证据**：线程页地址为 `/workspaces/<ws>/tasks/<task>/thread/session-…`；前端据此先请求
`GET /api/workbench/v1/runs/session-…`，服务端 404 `run_not_found`（08:07–08:17 共 5 次）；
同时 `GET /api/workbench/v1/sessions/session-…` 返回 200，正文靠 session 兜底渲染。

**根因**：任务线程路由第三段兼容 Run ID 与 Session ID，但语义不同——Run ID 进入单次执行详情，
Session ID 进入任务对话。`ConversationView.loadConversationTarget()` 对任何目标都先
`refreshRun(id)`，于是 Session 目标必然先打一次 `/runs/<sessionId>` 404，再回退 Session；
请求噪声之外，也让目标类型判断和错误提示绕了一圈。

**修复**：`ProjectTaskPanel.threadPath()` **保持传 Session ID**（任务对话不能用 Run ID，否则会
进入执行详情）；`ConversationView.loadConversationTarget()` 对 `session-` 前缀的目标直接加载
Session，不再探测 `/runs`。`/thread/run-…` 继续用于“最近执行”/执行详情，旧链接仍兼容。

**验收**：任务对话 URL 仍为 `/thread/session-…`；打开任务对话时网络面板不再出现
`/runs/<sessionId>` 404；从“最近执行”进入 `/thread/run-…` 正常；页面不再因该 404 误报“不存在”。

## 6. 验收

部署与验收步骤见[部署手册 8.3 节](mac-mini-deployment-runbook.md#83-20261124-02-补充nginx-宿主后端与启动探针)；
核心断言：

- 首次启动日志出现 `execution container toolchain: …`，不需要人工 kickstart；
- 110 次请求 0 个 502/499（仅冒烟）；Nginx 日志 0 条 `no live upstreams`、0 条
  `connect() to [fdc…]`；
- 以新 `DEPLOYED_AT` 为下界的授权失败计数为 0（命令见 8.2 第 4 步，created_at 与 ended_at 两种口径）；
- 吴军重跑成功且 `run_attempts.error_code` 为空；任务对话使用 Session ID，打开时不再出现
  `/runs/<sessionId>` 404 或“不存在”误报。

## 7. P1（不纳入本版本）

- DSH profile 隔离：部署侧 preflight 使用临时 `DSH_HOME`（复制所需 profile 依赖）或把 preflight
  与启动串行化，先在 Mac mini 演练通过再合并；
- 探针指标：启动探针次数、失败原因、恢复次数进入可观测面板；
- Nginx upstream 健康与 502 计数告警，覆盖“后端真实不可用”与“解析到不可达地址”两种情形；
- 两笔未定因 400（5 字节响应、应用无日志）：开 Nginx `error_log … info` 复现后定因。

## 8. 证据位置

- 部署记录：`2026-11-24-v2026.11.24-01-deploy.md`（仓库外，运维记录）；
- 线上日志：`logs/server.stderr.log`、`logs/server.stdout.log`（`recovered` 在 stdout）、
  web 容器 Nginx 日志；
- 授权热修背景：[授权复核超时事件记录](incident-2026-11-24-authorization-timeout.md)。
