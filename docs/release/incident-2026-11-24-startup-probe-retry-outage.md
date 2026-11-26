# 2026-11-24 启动探针重试失效事件（约 15 小时能力不可用）

## 1. 事件摘要

`v2026.11.24-02` 于 2026-11-24T09:24:38Z 部署。Nginx 502 修复立即生效，但首次启动的
DSH 能力探针超时后，**有界重试实际退化为一次尝试**：服务以 `UnavailableRuntime` 运行，
`/health` 仍 200，所有创建任务返回 503。直到 **2026-11-25T00:17:28Z 人工 `launchctl kickstart -k`**
才恢复（本次探针 13.7 s 通过），期间约 15 小时、6 次 `RUNTIME_UNAVAILABLE`。

- 影响：Agent 任务无法创建；已有内容与只读/管理接口在服务进程存活期间仍可用；无数据丢失、无 schema 变更。
- 与 502 修复无关：Nginx 上游固定 IPv4 + `max_fails=0` 的验证通过（`[fdc…]` 与
  `no live upstreams` 均为 0 条）。

## 2. 时间线（UTC）

| 时间 | 现象 |
| --- | --- |
| 11-24 09:24:38Z | `active-release` 切到 `v2026.11.24-02`；首启 DSH 探针在 30 s 处超时 |
| 09:24:27Z | `DSH runtime unavailable … DSH ACP preflight timed out after 30000 ms` |
| 09:25:59Z / 09:31:53Z | 两次重启同样只出现 `startup probe dsh attempt 1/3 failed`，随后直接 unavailable；**从未出现 `2/3`、`3/3`** |
| 11-24 09:24Z–11-25 00:17Z | 服务以 `UnavailableRuntime` 运行；6 次 `RUNTIME_UNAVAILABLE`（00:13/00:16Z 各 3 次） |
| 11-25 00:17:28Z | 人工 `launchctl kickstart -k`；00:17:41Z 出现 `execution container toolchain: …`，能力恢复 |
| 00:19:29Z | `/health/ready` 的 `dsh` / `python` / `executionContainer` 均为 `available` |

证据：`deploy-record-v2026.11.24-02-2026-11-25.md`（仓库外）、
`attachments/11-deploy-1124-02-verification.txt`（仓库外）。

## 3. 根因

1. `main.ts` 的 `startupProbeRetry` 配置为 `attempts: 3, delayMs: 2000, deadlineMs: 20000`，
   而单次 `preflightDshRuntime()` 的超时是 **30 000 ms**。第一次尝试在 30 s 超时后，
   `performance.now() - startedAt >= 20000` 已成立，重试循环直接进入失败分支，
   `attempt 2/3` 与 `3/3` 永远不会执行。
2. 部署脚本的健康门禁只检查 `/health`。服务以 `UnavailableRuntime` 启动时 `/health` 仍返回 200，
   因此“能力不可用”的部署被判定成功，没有回滚或告警。
3. 服务没有“启动失败后自动恢复”的路径：`UnavailableRuntime` 会一直保持到人工重启。

## 4. 修复（`v2026.11.25-01`）

- **重试预算**：启动探针不再使用总 `deadlineMs`，由尝试次数约束（3 次、间隔 2 s）。
  单次 preflight 仍为 30 s；DSH 探针最坏约 3×30 s + 2×2 s ≈ 94 s（仅 DSH，不含
  execution-container 探针）。
  新增 `onRecovered` 日志（第 2/3 或 3/3 次成功时输出），并补“慢尝试仍会重试”的单测。
- **健康等待与启动预算**：web 容器 healthcheck 改为静态 `/nginx-health`（Nginx 存活探针，
  秒级 healthy，不再依赖宿主服务端探针，移除了旧的约 110 s 后端依赖窗口）；`release.sh`
  改为调用 `scripts/deploy/release-wait.mjs`：公网 `/health` 等待预算 1500 s（25 分钟，
  覆盖 DSH 约 94 s + execution-container 三次探针约 21–22 分钟），超时输出
  `release health check failed: …` 并按 `fail_after_migration` 回滚。
- **部署门禁**：`/health/ready` 返回 200 后一次性断言
  `executionCapabilities.dsh.status` 与 `executionCapabilities.executionContainer.status`
  均为 `available`，缺失时立即输出
  `release readiness check failed: required execution capabilities unavailable (…)` 并回滚，
  不再把能力不可用判为部署成功；只有 database 检查会重试（30 次 × 2 s、单次 10 s 超时）；
  `python` 不可用时只告警（`python_execute` 会被拒绝，核心运行不受影响）。
- **CI**：部署配置检查新增 `release-wait.mjs`、`/nginx-health` 与“web healthcheck 不得依赖
  宿主服务端”的断言，并运行 `scripts/ci/release-wait.test.mjs`；`release.sh` 继续通过
  `bash -n` 与现有部署安全检查。

## 5. 验收

- 首次启动（不人工 kickstart）日志出现 `execution container toolchain: …`；
- 部署日志出现 `release health check passed after …s` 与 `release readiness check passed`；
  若启动超时或能力不可用，必须以 `release health check failed` /
  `release readiness check failed` 失败并回滚，而不是只写 `release activated`；
- `/health/ready` 的 `dsh` 与 `executionContainer` 为 `available`，`python` 有明确状态；
- compose web 容器在秒级 healthy（静态 `/nginx-health`），部署记录其从启动到 healthy 的时长；
- 3 次启动探针均失败时，服务仍 fail-closed（不降级到宿主执行），但部署不得报告成功；
- 502 验收保持：部署后 Nginx `[fdc…]` 与 `no live upstreams` 均为 0 条。

## 6. 遗留

- P1：启动能力持续不可用时的**自动恢复**（后台周期重探并提升 Runtime，或 fail-fast 交给 launchd
  重启）。本版本只修预算与部署门禁，不改变“核心 API 保持可用”的现有设计；需单独决策。
- P1：部署侧 preflight 与 launchd 启动的 `~/.dsh/profiles/acp` 竞争仍未消除，需在 Mac mini 演练
  临时 `DSH_HOME` 隔离。
- P2：任务线程 404 噪声已修，但用户可见的“任务不存在”文案（`project_task_not_found` 分支）
  是否仍在，需业务侧实测确认。
- P2：两笔未定因 400；11-25T00:00Z 两条无 attempt/events 的 failed run，需单独排查。
- 迁移账本 50 条生产独有历史版本的处理见
  [迁移账本偏离记录](migration-ledger-deviation-2026-11-24.md)。
