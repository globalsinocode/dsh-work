# 授权复核超时事件记录（2026-11-24）

## 1. 事件摘要

- 用户吴军的 Run `run-289b7c5c-fda9-4f29-95d6-ef8ce8999a28` 在 `AUTHORIZATION_CHECK_UNAVAILABLE` 下失败，
  根因是平台授权复核的**晚到成功**：授权查询在 **5.76 秒**返回成功，而 Adapter 的硬超时是 5 秒，
  用户在结果返回前已被判死。
- 影响范围：14 次失败 / 7 名用户；其中 11-23 单日 10 次。
- 结论：撤销语义本身正确（fail-closed），问题是单次授权查询的**超时预算过紧**且缺少慢调用证据。

## 2. 根因与失败链路

1. `DshAcpRuntimeAdapter` 对每次复核使用固定 `5000ms` 的 `Promise.race`，超时即
   `AUTHORIZATION_CHECK_UNAVAILABLE`；本次查询实际 5.76 秒返回成功，属于“晚到成功被提前判死”。
2. `run.failed` 事件没有授权 phase、实际耗时与超时预算，事后无法区分“慢”与“真不可用”。
3. DSH 工具侧对每次工具调用的授权探测另有固定 6 秒客户端超时，且每次工具调用前后各探测一次；
   它与 App 侧预算互相独立，任何一侧过紧都会先判死。
4. 服务端文本日志没有时间戳，磁盘上缺少可关联的慢调用证据。

## 3. 变更（版本 `2026.11.24-01`）

- 硬超时 `5s → 10s`：5 秒不再 reject，只写慢日志并继续等待同一个 Promise；10 秒才进入原有
  fail-closed 路径。不重试，避免叠加并发授权查询。
- 新增 `authorization.check` 结构化日志（`slow` / `recovered` / `late_success` / `late_error` /
  `timeout` / `error` / `denied`），只记录慢、恢复、超时、晚到与错误，不逐次记录快速成功。
- `run.failed` 增加 `authorization_phase` / `authorization_check_ms` / `authorization_slow_ms` /
  `authorization_timeout_ms` / `authorization_outcome`。
- 授权复核 phase 覆盖 `setup` / `pre_start` / `tool` / `permission` / `post_prompt` / `post_collect` / `scheduled`。
- 取消/超时/关闭优先于授权硬超时：Run 快速收敛，不等待挂死的授权查询，也不把取消误记成授权超时。
- DSH 工具侧探测预算由 Adapter 注入：`授权硬超时 + 5000ms`（3 秒容器静止 + 2 秒 IPC 余量），默认 15 秒。
- `console` 输出规范化为单行 ISO 时间戳；带有效 ISO `at` 的单参数 JSON 日志保持原样（`http.request.failed`
  也补了 `at`）。
- 周期复核（2 秒间隔）从 Worker 初始化前移到 `run.started` 之后；初始化窗口由 `pre_start` 检查兜底。
- **无 schema 变更、无 UI 变更、无公共 API 变更**；回滚只需恢复代码版本。

## 4. 发布前门禁

发布前必须证明没有 schema 变更、也不会有不兼容迁移：

1. release 迁移文件集合与生产 `schema_migrations` 账本的完整 `(version, checksum)` 集合一致
   （`diff` 无输出、无 NULL）；命令见[部署手册 8.1 节](mac-mini-deployment-runbook.md#81-发布前门禁迁移账本一致与自动部署已停止)。
2. 自动部署 watcher 已 `launchctl bootout`，且 `automation/.watch.lock` 与 `.release.lock` 均无活动 PID。
3. 合并 commit 的四项 CI（Static / Unit / Integration / Browser）全部通过；`Manual release` 由该 commit 手动触发。
4. Release 的 target commit、`isImmutable`、作者与 attestation 断言通过后才交给生产部署。

## 5. 验证 SQL 与日志证据

以部署时间 `DEPLOYED_AT`（UTC）为下界，排除部署前旧版本故障：

```sql
select count(*) from run_attempts
 where error_code = 'AUTHORIZATION_CHECK_UNAVAILABLE'
   and created_at >= :'deployed_at'::timestamptz;

select occurred_at, safe_metadata from run_events
 where event_type = 'run.failed'
   and safe_metadata->>'error_code' = 'AUTHORIZATION_CHECK_UNAVAILABLE'
   and occurred_at >= :'deployed_at'::timestamptz
 order by occurred_at desc limit 20;
```

期望：自部署截点起 0 次；若有，每条事件必须带 `authorization_phase`、`authorization_check_ms`、
`authorization_timeout_ms`、`authorization_outcome`，并与同一 `run_id` / `attempt_id` / `phase` 的
`authorization.check` 日志（`server.stderr.log`）可关联。

受控 6–8 秒慢授权验收见[部署手册 8.2 节](mac-mini-deployment-runbook.md#82-授权复核超时热修20261124-01的观测与验收)；
普通快速成功 Run 不能替代该窗口的验证。

## 6. 回滚

- 本次不新增迁移，回滚只需按现有流程恢复代码版本（回退 `v2026.11.16-01`）。
- Release 工作流失败时不会产生可用 Release；修复后重新 dispatch，不复用 tag。
- 发布前门禁失败时停止，不产生生产变更。
- 回滚后如仍偶发超时，保留慢日志/事件证据并在 P1 决策是否放宽或改为事件驱动复核，不无限放宽。

## 7. 临时参数记录

`DSH_WORK_AUTHORIZATION_CHECK_TIMEOUT_MS=10000` 为本次发布引入的可配置硬超时（默认即 10000，
生产只接受 7000–30000 的无外围空白整数）；文档位置：

- 开发模板：`.env.example`；
- 生产模板：`deploy/runtime.env.example`；
- 本地说明：[开发与测试](../development/development.md#开发环境)。

R2 / P-A 接管时，应把该值与周期复核间隔、工具探测预算一起纳入 Capacity Profile，而不是继续散落在环境变量里。

## 8. P1 / P2（不纳入本次热修）

**P1**

- 周期复核 2 秒→5/10 秒并加 jitter，评估事件驱动替代轮询；
- 授权指标 p50/p95/p99、超时计数、按空间类型/phase 分组；
- 成功授权审计写入节流（失败/授权变化必写）；
- 合并/缓存授权查询（单次复核内 memo、revision 缓存、单条 CTE）；
- 工具探测预算与 DSH 默认 30 秒工具超时的叠加观测（每次工具调用 before/after 两次探测）；
- 项目任务 `execution_failed` 事件（新迁移）与 UI“可直接重试”；
- `pg_stat_statements`、连接池/索引复核；
- `runtimes.last_heartbeat_at` 修复。

**P2**

- 退避重试状态机、用户可见“正在重试”、新错误码/一键重试；
- R2 Capacity Profile 纳入 auth timeout/interval/retry；
- 多 Run 并发授权风暴压测；
- 七天观察基线与容量验证。

## 9. 上线结果与遗留（2026-11-24）

- 发布：`v2026.11.24-01`，`Manual release` run `45337256940` success，target
  `8d8f77a0a9186dead346ff47d6a1353982db7f4b`，immutable，2026-11-24T06:01:32Z published；
  四项 CI（Static / Unit / Integration / Browser）success。
- 部署：2026-11-24T06:14–06:16Z 完成，`active-release` 切换到 `v2026.11.24-01`，
  `/health` 200，日志已带 ISO 时间戳（`console-timestamps` 生效），迁移全部 skipped、零 DDL。
- 授权观测：以部署截点 `DEPLOYED_AT=2026-11-24T06:16:13Z`（UTC）为下界查询
  `AUTHORIZATION_CHECK_UNAVAILABLE`（命令见[部署手册 8.2](mac-mini-deployment-runbook.md#82-授权复核超时热修20261124-01的观测与验收)）：
  按 `created_at` 与 `ended_at` 两种口径均为 **0**；部署后 6 次 attempt 的 `error_code` 全空。
- 慢授权真实样本：`run-84c01904-53d0-443b-9683-fb4fedd73a79` 在 `scheduled` phase 出现
  `authorization.check` `slow`（5148 ms，stderr/warn）→ `recovered`（8636 ms，stdout/info），
  同一 run/attempt/phase，Run 最终 succeeded。该样本**非受控注入**，作为“真实生产慢样本”验收；
  受控 6–8 秒注入仍是可选的后续补证，不再作为阻塞项。注意 `recovered` 走 stdout，排查时两路日志都要查。
- 吴军重跑：2026-11-24T08:13–08:20Z 在员工端重跑 5 次，4 次 succeeded；主证据
  `run-84c01904` 的 `run.started` / `assistant.delta` / `assistant.completed` / `run.completed`
  齐全、`error_code` 空。另 1 次 `RUN_TIMEOUT`（2m21s，08:07）作为观察项，不是授权失败。
  同次重跑暴露任务线程对 Session 目标先探测 `/runs` 的前端缺陷，已在 `2026.11.24-02` 一并修复，
  见[上线后 502/503 事件记录](incident-2026-11-24-post-deploy-502-503.md#5-任务线程目标探测缺陷重跑暴露20261124-02-一并修复)。
- 上线后另发现两个与本热修无关的故障（Nginx 双栈上游 502、启动探针 503），已单独立项修复，
  见[上线后 502/503 事件记录](incident-2026-11-24-post-deploy-502-503.md)；对应版本
  `2026.11.24-02` 的部署与验收见手册 8.3。
- 自动部署 watcher 在本轮验收与一周复核完成前保持关闭（`DSH_WORK_AUTO_DEPLOY_ENABLED=false`，
  且无 launchd job），复核结论明确后再按手册第 10 节决定是否恢复。
