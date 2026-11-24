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

## 4. 根因二：启动执行能力探针单次失败

`server/src/main.ts` 启动时先探测 DSH，再探测执行容器（执行镜像/工具链/DSH 叠加层/独占调度），
任一失败即把 Runtime 设为 `UnavailableRuntime`（fail-closed，不降级到宿主执行）。本次启动
探针偶发失败后没有重试，服务虽然健康监听，但所有 Run 在创建前被拒。

具体失败原因以 `logs/server.stderr.log` 中 06:16Z 前后的
`execution container unavailable` / `DSH ACP preflight failed` / `startup probe …` 行为准；
事件记录不臆断。已知 DSH 每次 boot 都会重写 `$DSH_HOME/profiles/acp/cordis.yml`，部署侧
preflight 与启动同时触碰该 profile 是可疑竞争源，需要日志确认。

**修复（`2026.11.24-02`）**：启动探针最多 3 次、间隔 2 秒、总预算 20 秒，逐次记录脱敏日志；
预算耗尽仍 fail-closed。重试只消化部署/启动瞬间的竞争性失败，不放宽能力判定，也不改变
“执行容器不可用时拒绝所有 Run”的边界。

## 5. 验收

部署与验收步骤见[部署手册 8.3 节](mac-mini-deployment-runbook.md#83-20261124-02-补充nginx-宿主后端与启动探针)；
核心断言：

- 首次启动日志出现 `execution container toolchain: …`，不需要人工 kickstart；
- 110 次请求 0 个 502/499，Nginx 日志无 `no live upstreams`，无 `connect() to [fdc…]`；
- 以新 `DEPLOYED_AT` 为下界的授权失败计数为 0（命令见 8.2 第 4 步）；
- 吴军重跑成功且 `run_attempts.error_code` 为空。

## 6. P1（不纳入本版本）

- DSH profile 隔离：部署侧 preflight 使用临时 `DSH_HOME`（复制所需 profile 依赖）或把 preflight
  与启动串行化，先在 Mac mini 演练通过再合并；
- 探针指标：启动探针次数、失败原因、恢复次数进入可观测面板；
- Nginx upstream 健康与 502 计数告警，覆盖“后端真实不可用”与“解析到不可达地址”两种情形。

## 7. 证据位置

- 部署记录：`2026-11-24-v2026.11.24-01-deploy.md`（仓库外，运维记录）；
- 线上日志：`logs/server.stderr.log`、web 容器 Nginx 日志；
- 授权热修背景：[授权复核超时事件记录](incident-2026-11-24-authorization-timeout.md)。
