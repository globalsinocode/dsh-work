# 2026-11-25 后续计划：发布前修正、v2026.11.25-01 部署验收与稳定性复核

> 状态（2026-11-26 12:20 CST）：Phase 0 已合并（PR #14，main=`d19ec5fd04203a9b38b3ba048bf19d4ef7690483`，四项 CI 全绿）；`v2026.11.25-01` 已发布为 immutable/attested Release，target 同上；生产仍为 `v2026.11.24-02`，本次部署按 Phase 2/3 执行。
> 结论：Phase 0/1 完成，进入生产部署前置与验收；部署必须使用已验证 bundle 的原始 `release.sh`，不得复用旧副本。
> 本计划按 2026-10-26～2026-11-25 日志导出重新校准：区分“代码已完成待生产验收”“历史配置事件”“已经定因”“仍开放”和“证据不足”，不以“后续未出现”代替闭环证据。
> 本计划不替代部署手册、PF-07 目标环境清单和生产取证单。
> 修订记录（2026-11-25 14:50 CST）：补入 compose healthcheck 等待预算及三段等待的串行上界，要求同批更新部署手册/事件记录/定时任务，并按导出材料校正统计口径；13:20 版本的核心结论不变。
> 修订记录（2026-11-26 12:20 CST）：记录 Phase 0 合并与 `v2026.11.25-01` 发布证据（见 Phase 0/1 执行记录），关闭“等待预算待修正/Release 未发布”状态。

## 1. 证据范围与统计口径

### 1.1 本次新增证据

本次复核使用以下仓库外导出材料，原件不进入 Release 包：

- `README.md`：导出说明；
- `stats-20261125T031000Z.json`：机器可读统计；
- `server-run-last30d.log`：请求窗口内日志；
- `server-run-untimestamped-unattributable.log`：窗口前或无法归时的旧日志块。

### 1.2 可以下结论的范围

| 口径 | 校准后的事实 |
| --- | --- |
| 请求窗口 | 2026-10-26 00:00～2026-11-25 11:06 CST，共 31 个自然日 |
| 实际覆盖 | 22 天有记录，9 天无记录：11-01、11-08（周日，确实没有失败请求，不是日志丢失）与 11-17～11-23（**7 个完整自然日**日志缺口）；断档为 11-16 10:44 CST 最后一条带时间记录 → 11-24 14:16 CST 恢复，约 8 天 3 小时 30 分 |
| 原始行 | 3424 行 = 2933 条 `http.request.failed` 请求记录 + 491 行非请求行（warn/error、启动日志、Node 堆栈、MCP 审计告警与多行输出）；其中 2586 行带自身时间，838 行无自身时间 |
| 分类记录 | `byStatus` 共 2933 条（= 2932 条带数字状态 + 1 条 `-`）；不能与原始行数混作同一分母，也不能把轮询/重试放大的请求条数当成独立事故数 |
| 401 | 1993 条，占分类记录约 68%；其中 `authentication_required` 1805 条，多数是未登录或登录态过期噪声，不计入发布可用性故障 |
| 无时间记录 | 只能归入导出窗口或日志块位置，不能归到某日、某版本或本次发布，也不能据其断言“当前复发” |

口径对齐（避免把不同分母混算）：

- 31 个自然日 = 22 天有记录 + 9 天无记录（见上表）。导出 `README.md` 中的“连续 8 天”是按断档跨度口算；按完整自然日只有 11-17～11-23 共 7 天，另有 11-01、11-08 两个周日无失败记录。
- `byStatus` 的分母是 2933 条请求记录，不是 3424 行；491 行非请求行与请求数无关，不能并入错误率，也不能用 3424 行去除某个状态数。
- 11-24 06:37Z/06:39Z 的 3 条 `RUNTIME_UNAVAILABLE` 属 502/503 事件链；11-25 00:13Z/00:16Z 的 6 条属启动探针事件；二者都不是授权失败。

本导出是 `server.stderr.log`，只含失败请求与 warn/error，不是访问日志：

- 成功请求不在其中，不能计算错误率或成功率；
- DSH Worker stderr 不在其中，Run 结果以 PostgreSQL 的 `runs`、`run_attempts`、`run_events` 为准；
- 11-17～11-23 的缺口只能用数据库或外部日志补齐；
- Nginx 499/502/400 必须查 Nginx access/error log，应用 stderr 中“没有记录”不能证明边缘层没有发生；
- `authorization_denied`、`permission_denied` 不等于 `AUTHORIZATION_CHECK_UNAVAILABLE`。

## 2. 当前事实与事项重分类

| 项 | 当前结论 | 状态 |
| --- | --- | --- |
| 生产版本 | `v2026.11.24-02`，commit `7d847d41`，`DEPLOYED_AT=2026-11-24T09:24:38Z` | 事实 |
| Nginx 502 修复 | 固定 upstream `192.168.65.254:4190 max_fails=0` 后既有专项验收通过；月度应用日志中的唯一 `502 model_catalog_invalid` 是应用返回的模型目录解析错误，不是 Nginx upstream 502 | 已实施，仍须随新部署复验 |
| 启动探针 | 11-24 09:24、09:25、09:31 三次启动都只有 `attempt 1/3`；导出共 9 次 `RUNTIME_UNAVAILABLE`：11-24 06:37/06:39Z 3 次属 502/503 事件链，11-25 00:13/00:16Z 6 次属启动探针事件；00:17:41 人工重启后出现 toolchain | 生产缺陷确证 |
| 11-25-01 代码 | `9406dfbf` 修正 retry deadline 与 `/health/ready` 门禁；`d19ec5fd` 补齐启动等待预算并已发布 `v2026.11.25-01` | 已完成（Phase 0/1 记录） |
| 部署等待预算 | 远端 `9406dfbf` 的启动到可服务前有三段独立等待：compose web healthcheck（约 110 秒）、公网 `/health`（约 180 秒）、`/health/ready`（30 次）。探针串行上界约 21–22 分钟，三段等待都小于该上界，compose 会在约 110 秒先失败。已按 Phase 0 改为 nginx 静态存活 + `release-wait.mjs`（main `d19ec5fd`，四项 CI 全绿） | **已修复** |
| 任务线程 `/runs/session-*` | session→runs 误探测的代码修复已在 `v2026.11.24-02`；导出中没有字面 `/runs/session-*`，但路径已模板化，84 条 `run_not_found` 也包含其他合法 404 | 代码完成，生产浏览器验收仍开放 |
| “任务不存在”文案 | `project_task_not_found` 是独立分支，月度 stderr 不能证明是否仍对用户误报 | 仍开放 |
| 00:00 两条无 Attempt/Event 的 failed Run | 两条均为 automation task，在 `AttemptDispatcher.submit/dispatch` 前因 `ExecutionCapabilityUnavailableError` 失败并走 `failUndispatchedRun` | **已定因，关闭未知创建路径调查** |
| 授权复核 | 仅见一条 11-24 08:18:52Z 的 `slow=5148ms`，早于 11-24-02 部署；未见结构化 timeout/error，但 stderr 不能替代数据库双口径 SQL | 热修观察继续，不能由该日志宣称完成 |
| 两笔 Nginx 400 | 两份导出中 HTTP 400 为 0，与“应用无日志”一致，但不能否定 Nginx 曾返回 400 | 保留条件性复现 |
| `RUN_TIMEOUT` | stderr 导出中没有 `RUN_TIMEOUT` 字样（11-24 吴军那次业务 Run 超时记录在数据库/事件记录，不落此文件）；启动 preflight 的 30 秒 timeout 不是业务 Run timeout | 保留观察，不与启动故障混算 |
| 模型路由拒绝 | 9 条无时间 `MODEL_ROUTE_NOT_READY` 均因默认路由所属 Provider 被停用 | 历史配置事件，需当前配置快照/成功 Run 证明闭环 |
| Unicode 500 | 17 条无时间 `operation_failed: unsupported Unicode escape sequence`，均发生在创建 Run 的入口 | 仍开放，证据不足，不能写已修 |
| 通知服务 503 | 48 条有时间 `push/config` 503，集中在 10-30～11-02；之后未观察到，但存在七日日志缺口且无配置恢复证据 | 历史配置/能力事件，不阻塞本补丁 |
| 数据库 504 | 11-12、11-13 各一条 `CONNECT_TIMEOUT 127.0.0.1:5434` | P2 运维观察 |
| 知识库/WeKnora | 有未配置 embedding、知识库服务不可用及 WeKnora timeout 记录 | 独立依赖降级观察 |
| watcher | `AUTO_DEPLOY_ENABLED=false`，此前核实 launchctl watcher not found | 继续关闭 |
| 迁移账本 | 生产 179 / Release 129；生产独有 50 条已登记偏离，生产操作人尚未签署 | 部署前门禁 |

### 2.1 人工恢复后的短窗只能作为辅助事实

00:17:41 toolchain 恢复后至 03:03:16，带时间 HTTP 记录中没有 5xx；00:18:32～00:18:33 的 110 条 `/session` 请求全部返回 401。该短窗只能说明应用明确拒绝未登录请求且未产生应用 5xx，不能证明：

- Nginx 499/502 为 0；
- Run 链路成功；
- 修复后的 retry 分支有效；
- 持续稳定性已达到一天或一周。

### 2.2 启动等待预算的三段构成

`9406dfbf` 的启动顺序是：launchd 启动服务端（先跑能力探针，全部结束后才 `server.listen`），`release.sh` 再等 compose web 容器与公网 `/health`，最后断言 `/health/ready`（以下为远端 `9406dfbf` 的现状；Phase 0 修正后的结构见本节末）。三段等待分别是：

1. **compose web healthcheck**：[deploy/compose.yaml](../../deploy/compose.yaml#L54-L59) 中 web 的 healthcheck 为 `wget … /health/live`，`start_period 10 s`、`interval 5 s`、`retries 20`，容忍窗口约 `10 + 20×5 = 110 s`；[release.sh](../../scripts/deploy/release.sh#L265-L268) 用 `docker compose up -d --wait --force-recreate web` 等待它。服务端未监听时该检查持续失败，超过约 110 秒容器被判 `unhealthy`，compose `--wait` 以失败退出并进入 `fail_after_migration`——**早于 release.sh 的 `/health` 循环，180 秒在此不生效**。
2. **公网 `/health`**：[release.sh](../../scripts/deploy/release.sh#L272-L287) 90 次 × 2 秒，约 180 秒。
3. **`/health/ready`**：[release.sh](../../scripts/deploy/release.sh#L289-L324) 30 次；能力项状态在监听后已固定，重试不会让能力恢复，只有 database 检查可能随重试恢复。

真实串行上界（按代码超时上限粗算，Phase 0 需精确化并写入手册与脚本注释）：

- DSH 探针：3 × 30 秒 + 2 × 2 秒延迟 ≈ 94 秒；
- execution-container 每次尝试：镜像检查 15 秒 + 工具链探测 60 秒 + Python 包 60 秒 + Python 模块 60 秒 + Docker 特性 15 秒 + 遗留容器清理（并行查询 15 秒 + 删除 15 秒 ≈ 30 秒）+ 叠加层 preflight 30 秒 + 工具目录发现最长 120 秒 ≈ 390–400 秒；3 次加间隔约 20 分钟，加上 DSH 探针约 94 秒，总计约 21–22 分钟。

因此 Phase 0 必须同时处理 compose healthcheck，否则只改 `release.sh` 的等待时间仍会提前回滚；同时要决定是否收紧昂贵探针的超时，避免把失败检测拉长到 20 分钟以上。

**Phase 0 实施结果（已完成：main `d19ec5fd`，四项 CI 全绿）**：web healthcheck 已改为静态 `/nginx-health`（[deploy/nginx/default.conf.template](../../deploy/nginx/default.conf.template) 与 [deploy/compose.yaml](../../deploy/compose.yaml)），`up -d --wait web` 只等 Nginx 存活，不再等宿主探针；公网 `/health` 等待（1500 s，约每 30 s 打印一次进度）与 `/health/ready` 断言迁入 [scripts/deploy/release-wait.mjs](../../scripts/deploy/release-wait.mjs)，能力缺失立即失败、仅 database 503 重试。上表“compose ≈110 秒先失败”的约束随之解除，剩余约束是 `release-wait.mjs` 的 1500 s 预算（覆盖约 21–22 分钟探针上界并留余量）。

## 3. 完成定义（DoD）

1. 修正**部署启动等待预算**，同时覆盖 compose web healthcheck 的 `up -d --wait`、公网 `/health`、`/health/ready` 三段，使三段都大于 DSH 与 execution-container 两组串行重试的真实有界上界；增加脚本回归，覆盖“超过当前 180 秒但仍在合法预算内恢复时不提前回滚”（含 compose 失败路径）；把精确上界回填部署手册 8.4、启动探针事件记录并更新 `release.sh` 注释；修正后的 main 四项 CI 全绿。
2. `v2026.11.25-01` 发布为 immutable/attested Release，target 等于 dispatch 前固定的修正后 main 完整 40 位 SHA；Release、CI、部署是三个独立事实。
3. 使用已验证 Release bundle 中的原始 `scripts/deploy/release.sh` 执行部署，不复用旧副本，不以单个 `grep health/ready` 代替脚本完整性验证。
4. 部署脚本创建一次权威发布前异机备份；本机 `SHA256SUMS` 校验通过、`database.dump` 的 `pg_restore -l` 人工附加校验通过（经 postgres 容器从 stdin 执行，输出非空）、异机 `.sha256` 与 `.verified.json` 一致；命令与输出写入部署记录。
5. 部署日志出现 `release readiness check passed`；本次启动窗口内出现 `execution container toolchain: …`，无需人工 kickstart。
6. `/health/ready` 中 `dsh`、`executionContainer` 均为 `available`，`python` 有明确状态；公网 `/health` 中 `executionContainer.diskLow` 不为 `true`。
7. 部署后 Nginx `[fdc…]`、`no live upstreams` 为 0；499、502 无新增（出现 499 时按“上游故障延续 / 客户端主动断开”归因）；60 次顺序 + 50 次并发仅作为网络冒烟，不替代真实 Run。
8. 以新 `DEPLOYED_AT` 为下界，`run_attempts.error_code='AUTHORIZATION_CHECK_UNAVAILABLE'` 的 `created_at` 与 `ended_at` 两种口径均为 0，以 `ended_at` 为主口径。
9. 任务对话的浏览器网络面板确认 `/runs/session-*` 为 0；业务侧单独确认错误场景下是否仍误报“任务不存在”。
10. 完成 PF-07 目标环境部署验收：版本与 Runtime 身份、真实身份/OIDC、模型路由与数据防护、真实执行容器任务及成果、取消、适用 MCP、员工与管理员撤权、异机备份均有证据和验收人结论。
11. 迁移偏离在部署前重新核对四项硬门禁（`only_in_release=0`、公共 `(version, checksum)` 0 处不符、`NULL` checksum 0、`only_in_ledger` 集合与登记一致）及 migration blobs 一致性，并由生产操作人签署。
12. watcher 正式恢复决策只能在 `DEPLOYED_AT + 168h` 之后作出；2026-12-01 09:00 的定时任务按实际 `DEPLOYED_AT` 判定，不足 168 小时只作中期复核、不作 watcher 决定，并在记录 `DEPLOYED_AT` 后登记/创建正式一周复核任务；该定时任务的 prompt 已按本计划更新为 11-25-01 口径。

## 4. 阶段计划

### Phase 0：发布前修正与放行

**当前结论：不 dispatch `9406dfbf`。**

1. 修正**部署启动等待预算（三段一起改）**：
   - 先核对 `docker compose up -d --wait web` 在 web 容器 healthcheck 超窗时的失败语义（建议在 CI/一次性 Linux 夹具里用“延迟变为 healthy”的服务复现），据结果决定：提高 compose healthcheck 的 `start_period`/`retries`，或改为 `up -d` 后由 `release.sh` 统一轮询；
   - 不再用“3×30 秒约 95 秒”估算完整服务启动；按 §2.2 精确计算并记录 DSH 三次探针与 execution-container 三次探针的串行上界（含镜像检查、Python 包/模块、Docker 特性与遗留容器清理、叠加层 preflight、工具目录发现），写入脚本注释与手册；
   - `release.sh` 的 `/health` 等待与 `/health/ready` 断言按该上界设定，并明确“能力项一次性断言、仅 database 项重试”，避免把就绪重试误当作能力恢复；
   - 就绪失败仍调用既有 `fail_after_migration`，不放宽 fail-closed。
2. 增加部署脚本回归：模拟“超过当前 180 秒但仍在合法预算内恢复”时不会提前回滚（覆盖 compose `--wait` 路径）；再覆盖最终超时会失败。实现上可抽出等待函数或注入 PATH 假 `curl`/`docker`/`launchctl`，沿用 `scripts/ci/deployment-safety.test.mjs` 的 fixture 做法。
3. 同批更新文档与断言：部署手册 8.4、启动探针事件记录 §4 已在本计划修订中按“180 秒不是完整预算”更新，Phase 0 修正完成后回填精确上界与实际等待值；更新 `release.sh` 注释，并同步 `scripts/ci/deploy.sh` 中对 `release.sh`/手册的 grep 断言（第 96、100–102 行附近）。
4. 运行相关单测、`bash scripts/ci/deploy.sh`、`bash -n` 和四项 CI；全部成功后合并 main。
5. 确认执行环境能从 `globalsinocode/dsh-work` fetch `main` 并具备推送权限；若执行环境的 HEAD/`origin/main` 引用不在 `9406dfbf`（例如离线工作区或引用过期），先同步/干净检出再开分支，不要基于旧历史提交。
6. dispatch 前固定：
   - 按 `git fetch origin main` 后的 `git rev-parse origin/main` 取完整 40 位值，作为 `TARGET_SHA`；
   - `server/package.json.releaseVersion=2026.11.25-01`；
   - 四项 CI 均属于同一个 `TARGET_SHA`；
   - `v2026.11.25-01` 的 Release 和 tag 均不存在。

若在修正完成前已经有人发布 `v2026.11.25-01`，不得覆盖或删除；递增版本号、形成新 commit 并重跑四项 CI。

### Phase 0 实施记录（2026-11-26 已合并：PR #14 → `d19ec5fd`，四项 CI 全绿）

1. **等待预算**
   - `scripts/deploy/release-wait.mjs`（新增，随发布包交付）：公网 `/health` 等待预算 1500 s、每 2 s 轮询、单次请求 10 s 超时、约每 30 s 打印进度；`/health/ready` 返回 200 后一次性断言 `dsh` 与 `executionContainer`，缺失立即失败；仅 database 503 重试（30 次 × 2 s）；`python` 不可用只告警。失败输出沿用 `release health check failed` / `release readiness check failed` 文案，`release.sh` 仍走 `fail_after_migration`。
   - `scripts/deploy/release.sh`：删除原来的 90 次 `/health` 循环与 30 次内联就绪循环，改为调用该脚本，并更新注释与等待说明。
   - `deploy/compose.yaml` 的 web healthcheck 改为静态 `/nginx-health`；`deploy/nginx/default.conf.template` 在 8443/8444 增加只返回 200 的存活端点。
2. **回归与断言**
   - `scripts/ci/release-wait.test.mjs`（新增）：覆盖“等待超过旧 90 次/180 s 仍继续”、预算耗尽失败、能力缺失立即失败、database/502/504 重试、CLI 参数、HTTP 请求与 symlink 入口识别等 13 个用例。
   - `scripts/ci/deployment-safety.test.mjs`：新增“release.sh 必须委托 release-wait.mjs、web healthcheck 不得依赖宿主、发布包必须包含 helper”等静态断言。
   - compose `--wait` 的提前失败路径通过“healthcheck 改为静态存活 + `deploy.sh` 禁止 `/health/live` 回归 + nginx 模板校验”消除，不再依赖慢启动计时夹具。
   - `scripts/ci/deploy.sh`：新增 `release-wait.mjs` 测试执行，以及 `/nginx-health`、`release-wait.mjs` 与“旧循环不得回归”的 grep 断言。
   - `scripts/release/build-release.sh`：把 `release-wait.mjs` 加入发布包脚本清单。
3. **文档**：部署手册 8.3/8.4、启动探针事件记录、上线后 502/503 事件记录同步更新；验收口径改为记录 `release health check passed after …s`、`release readiness check passed` 与 compose web healthy 时长。
4. **本机验证（2026-11-25，Windows 工作区）**
   - `bash -n`：release.sh、ci/deploy.sh、build-release.sh、preflight.sh、restore.sh、rollback.sh 通过；
   - `node --test scripts/ci/release-wait.test.mjs`：13/13 通过；
   - 渲染端点覆盖后 `docker compose config` 通过；用固定 nginx 镜像对模板执行 `nginx -t`，`host.docker.internal` 与固定 IPv4 两种 upstream 均通过；
   - 复跑 deployment-safety 新增静态断言与 ci/deploy.sh 新增 grep 断言通过。
   - 受本机 Windows CRLF 与 POSIX 路径影响，完整的 `node scripts/ci/deployment-safety.test.mjs` 与 `bash scripts/ci/deploy.sh` 只能在 Linux CI 运行，视为待 CI 验证。
5. **合并与 CI（已完成）**：PR #14 于 2026-11-26T03:58Z 合并为 `d19ec5fd04203a9b38b3ba048bf19d4ef7690483`；该 commit 四项 CI（Static / Unit / PostgreSQL integration / Browser，run `45752238471`）全绿；发布前 `v2026.11.25-01` 的 tag 与 Release 均不存在。
6. **变更文件（相对 `9406dfbf`）**：`scripts/deploy/release-wait.mjs`（新）、`scripts/deploy/release.sh`、`deploy/compose.yaml`、`deploy/nginx/default.conf.template`、`scripts/release/build-release.sh`、`scripts/ci/deploy.sh`、`scripts/ci/release-wait.test.mjs`（新）、`scripts/ci/deployment-safety.test.mjs`、`scripts/checks/checks.test.mjs`（文档链接夹具）、`docs/release/mac-mini-deployment-runbook.md`、`docs/release/incident-2026-11-24-startup-probe-retry-outage.md`、`docs/release/incident-2026-11-24-post-deploy-502-503.md`、`docs/release/followup-plan-2026-11-25.md`（新）、`docs/release/acceptance-2026-11-24-evidence.md`（新）。本工作区 HEAD 不是 `9406dfbf`，不要从本地 HEAD 直接提交；请把上述文件应用到基于 `9406dfbf` 的干净克隆（其余本地改动已与该 commit 一致）。

### Phase 1：发布

1. dispatch 前再核对一次远端：`git fetch origin main` 后用 `git ls-remote origin refs/heads/main` 确认 main HEAD 等于 `TARGET_SHA`（不要用可能过期的本地 `origin/main` 引用），并确认 `v2026.11.25-01` 的 tag 与 Release 均不存在。
2. 执行：

   ```bash
   gh workflow run release.yml --ref main -f version=2026.11.25-01
   ```

3. 按 dispatch 时间捕获唯一 Workflow run，保存 database ID、URL、head SHA；head SHA 不等于 `TARGET_SHA` 时**先 `gh run cancel <run-id>` 阻止其继续发布**，再按下方“Release 是否已产生”的失败语义处理。
4. `gh run watch <run-id> --exit-status`。
5. 验证 Release：tag、完整 target SHA、immutable、非 draft/prerelease、作者、两项资产、tar SHA256、asset attestation 和 GitHub Release attestation。
6. 交付 Release URL、Workflow URL、资产名、SHA256、target commit。

**失败语义必须分两种：**

- 正式 Release/tag 尚未产生：修复后可以重新 dispatch 同版本；
- Release 已转正式后 immutability/attestation 验证失败：冻结该 tag，watcher 保持关闭，不删除、不覆盖；递增版本、创建新 commit、重跑 CI 后发布新 tag。

### Phase 1 执行记录（2026-11-26）

- 触发：`gh workflow run release.yml --ref main -f version=2026.11.25-01` → run [45753725184](https://github.com/globalsinocode/dsh-work/actions/runs/45753725184)，head SHA `d19ec5fd`，success。
- Release：`v2026.11.25-01`，immutable、非 draft/prerelease、作者 `github-actions[bot]`、target `d19ec5fd04203a9b38b3ba048bf19d4ef7690483`、两项资产（tar.gz + sha256）。
- 资产校验：tar SHA-256 `75f7684e8220b1f6187fdfad27e7c4df38caae034824c7cb6f781902339e93d6`；`gh release verify`、`gh release verify-asset`、`gh attestation verify --source-digest d19ec5fd… --deny-self-hosted-runners` 均通过。
- bundle 检查：`release.json` version=`2026.11.25-01`、commit=`d19ec5fd`、1652 个文件；含 `scripts/deploy/release-wait.mjs`，`release.sh` 已调用 helper，compose/nginx 为 `/nginx-health`。
- 结论：Phase 0/1 完成；生产部署待 Phase 2/3，watcher 保持关闭。

### Phase 2：生产部署前置

1. watcher 已停，`automation/.watch.lock`、`.release.lock` 均不存在，`AUTO_DEPLOY_ENABLED=false`。
2. 重新执行迁移偏离门禁：
   - `only_in_release=0`；
   - 公共 `(version, checksum)` 0 处不符；
   - NULL checksum 0；
   - `only_in_ledger` 仍为已登记 50 条集合，或变化已经重新裁决；
   - 本次 Release 与当前已部署版本的 migration blobs 一致，或差异已单独评审。
3. 生产操作人在部署前签署偏离记录；任一条件不满足即停止。
4. 重新验证固定 IPv4：
   - `runtime.env` 中 `DSH_WORK_UPSTREAM_HOST=192.168.65.254`；
   - Web 容器到该 IPv4:4190 可达；
   - 实际渲染后的 Nginx upstream 是该 IPv4 且 `max_fails=0`。
5. 只做备份设施预检：异机目录已挂载、可写、与部署根目录位于不同文件系统、空间足够、当前无运行中任务。不要先人工跑一份“等值备份”再让 Release 脚本重复备份。
6. 完成 Release bundle 的元数据、SHA256、资产和 attestation 验证；归档 bundle manifest 与 bundle 内 `release.sh` 的 SHA。
7. 原样使用按部署手册第 6 节完成 Release/资产/attestation 校验并解压得到的 `DWP_BUNDLE` 中的部署脚本。`DWP_BUNDLE` 是独立的已验证暂存目录，不是尚未激活的 `releases/v…` 目标目录；部署根路径已通过第二参数传入，不复制到 `deviations/`：

   ```bash
   # 沿用部署手册第 6 节已赋值并验证的 DWP_BUNDLE、DWP_VERSION、DWP_ROOT。
   # 示例形态：DWP_BUNDLE="${DWP_BOOTSTRAP}/dsh-work-v${DWP_VERSION}"
   DEPLOY_LOG="$DWP_ROOT/logs/deploy-v$DWP_VERSION-$(date -u +%Y%m%dT%H%M%SZ).log"

   set -o pipefail
   bash "$DWP_BUNDLE/scripts/deploy/release.sh" "$DWP_VERSION" "$DWP_ROOT" 2>&1 | tee "$DEPLOY_LOG"
   ```

如现场制度强制 deviation，必须用受审的版本化 patch、`patch --fuzz=0`、`bash -n`、源/patch/结果 SHA、完整 `diff -u` 和第二人批准；禁止人工自由编辑，禁止仅用 `grep health/ready` 放行。

### Phase 3：部署即时验收

部署前记录服务 PID 和 stderr/stdout/Nginx 日志 offset；部署后只读取本次 offset 之后且不早于部署开始时间的日志，避免误取 11-24 人工恢复的旧 toolchain 行。

| 检查 | 通过标准 |
| --- | --- |
| 版本 | `active-release`、`current`、`release.json` 均指向目标版本和 `TARGET_SHA` |
| `DEPLOYED_AT` | 使用 `date -u -r "$DWP_ROOT/active-release" '+%Y-%m-%dT%H:%M:%SZ'`，同时归档 `release activated` 日志 |
| 权威备份 | 部署日志有 `backup created:` 和 `verified off-host backup receipt:`；本机 `shasum -a 256 -c SHA256SUMS`、`database.dump` 的 `pg_restore -l`（经 postgres 容器从 stdin 执行，输出非空）、异机 `.sha256` 校验、`.verified.json` 的 backup ID 与摘要和归档一致，命令输出写入部署记录 |
| 启动 | 本次窗口有 toolchain；无人工 kickstart；compose web 容器秒级 healthy（静态 `/nginx-health`）；部署日志有 `release health check passed after …s`；如首尝试成功则写“正常路径通过，重试分支未在生产触发” |
| readiness | `dsh`、`executionContainer` available；`python` 状态记录 |
| 动态执行条件 | `/health` 中 `executionContainer.diskLow` 不为 true |
| Nginx | since `DEPLOYED_AT` 的 `[fdc…]`、`no live upstreams` 为 0；499、502 无新增（499 按“上游故障延续 / 客户端主动断开”归因） |
| 110 次网络冒烟 | 60 顺序 + 50 并发；记录状态分布；未登录 401 可接受但不算业务 Run 成功 |
| 授权 SQL | `AUTHORIZATION_CHECK_UNAVAILABLE` 的 created_at、ended_at 双口径均为 0 |
| 授权日志 | stderr/warn 与 stdout/info 两路统计 slow、recovered、late_success、late_error、timeout、error、denied；异常按 run/attempt/phase 解释 |
| 任务线程 | 浏览器网络 `/runs/session-*` 0 次；从最近执行进入 `/thread/run-*` 正常；单独确认用户文案 |
| Run/Attempt | 真实 `run_id`、`attempt_id`；Run 与 Attempt 均 succeeded、error_code NULL；事件按序含 `run.started`、至少一个 `assistant.delta`、`assistant.completed`、`run.completed` |
| 执行容器 | 真实容器命令和成果登记成功；另起一个任务验证取消生效 |
| 重启恢复 | 记录 `service restart recovery completed` 的 failed/resumedQueued；每条均有解释，无静默遗留 |

生产如首尝试成功，不主动制造故障。retry 分支另在使用相同 DSH Lock 和执行镜像的非生产环境留一次 transient failure → recovered 证据。

### Phase 4：PF-07 目标环境验收与归档

每次发布必须完成 `docs/development/pf07-platform-acceptance.md#目标环境部署验收`：

1. 记录应用版本/commit、DSH version/commit、Adapter/launch mode、ACP protocol、默认模型路由、执行镜像摘要，并与 Runtime Lock 和参考基线比对；
2. 使用实际身份来源完成普通员工链路，验证普通员工访问管理端被拒；OIDC 环境完成 OIDC Run、上游停用与目录同步后的拒绝；
3. 验证默认模型路由、数据遮盖和用量记录；
4. 验证真实执行容器任务、成果与取消；
5. 适用时验证 MCP 发现、只读调用与审计；写工具未验收时只开放只读；
6. 验证员工撤权、第二位管理员撤权；验证后恢复或清理验收账号；
7. 归档异机备份回执；恢复演练只在隔离环境执行；
8. 每项记录身份、时间、Run/Attempt、证据位置、适用性和验收人结论。

清单未完成不得把 Phase 3/4 或 DoD 标为通过，也不得开放本版本新增能力；失败时回滚或停用相关能力。

### Phase 5：24 小时观察与正式一周复核

**24 小时观察：**

- `RUNTIME_UNAVAILABLE`、Nginx 499/502、`no live upstreams` 无复发；
- 无第二次人工 kickstart；
- 授权失败双 SQL 口径为 0；
- `authorization.check` 无未解释的 timeout/error/late_error；
- 保存日志增量，避免滚动日志在一周后丢失。

**2026-12-01 09:00 定时任务：**

- 任务确已存在，且 prompt 已更新为 11-25-01 口径（版本、实际 `DEPLOYED_AT`、168 小时判定与延期分支）；
- 若执行时尚未达到 `DEPLOYED_AT + 168h`：只作中期复核，不作 watcher 恢复决定，并当场确认正式一周复核任务已登记/创建；
- 若已达 `DEPLOYED_AT + 168h`：按正式一周复核执行。

**正式一周复核：**

- 由记录 `DEPLOYED_AT` 时登记的定时任务执行，执行时刻必须不早于 `DEPLOYED_AT + 168h`；
- 使用部署时基线和每日保存的增量，不能用一周后的当前滚动日志“0 条”证明完整七天为 0；
- 授权失败为 0，无未解释的授权 timeout/error；
- Nginx 499/502、`[fdc…]`、`no live upstreams` 无复发；
- 首启/重启后未再次出现 `UnavailableRuntime`；
- 干净满 168 小时后才按手册决定 watcher 是否恢复；否则保持关闭并转相应 P1。

## 5. 遗留清单（按证据状态）

### 5.1 已定因/可关闭未知调查

- 11-25T00:00Z 两条无 Attempt/Event 的 failed Run：已确认是 Runtime outage 下 automation dispatch 前 fail-closed；并入启动故障事件，不再查未知创建路径。
- `authorization.check` 两路日志查询写入手册：文档工作已完成；部署后的实际运行验证仍属于 Phase 3/5。

### 5.2 代码已完成、待生产验收

- 任务线程 session 目标不再先探测 `/runs/<sessionId>`；以浏览器网络面板验收，不能用月度 84 条泛化 `run_not_found` 总量验收。
- 启动 retry deadline 与 `/health/ready` 门禁代码已进入 `9406dfbf`；等待预算已在工作区实施（见 Phase 0 实施记录），待提交、CI 与整体发布验收。

### 5.3 P1：保持开放

- 启动能力持续不可用时的自动恢复：后台周期重探并提升 Runtime，或 fail-fast 交 launchd 重启；单独评审。
- 部署侧 preflight 与 `~/.dsh/profiles/acp` 竞争：临时 `DSH_HOME` 隔离或严格串行化，先在 Mac mini 演练。
- 用户可见“任务不存在”文案：按 `project_task_not_found` 的真实错误场景定因，不与 session→runs 探测混为一项。
- 两笔 Nginx 400（5 字节、应用无日志）：需要时临时开启 Nginx `error_log info` 复现；不并入应用 HTTP 汇总。
- 17 条 `unsupported Unicode escape sequence`：先用数据库/trace 关联输入和受影响 Run，复现持久化或解析边界；修复后返回类型化 4xx 或正常接受合法输入，并补回归测试。因全部无时间，未确认当前版本仍复发前不阻塞 11-25 Runtime 补丁。
- 9 条 `MODEL_ROUTE_NOT_READY`：核对当前默认 route/provider 快照，并用一次成功 Run 证明当前配置闭环；补模型/Provider 停用前影响检查。因全部无时间，不宣称 11-25 复发。
- 吴军首次 `RUN_TIMEOUT`（2m21s）：该次是业务 Run 超时（数据库记录），stderr 导出中没有该字符串；本日志集未再复现，继续作为业务 Run 观察项，不与启动 preflight 的 30 秒 timeout 合并。

### 5.4 P2：运维与历史配置观察

- 部署脚本直接落 `DEPLOYED_AT` 证据文件；当前先用 `active-release` mtime。
- 授权失败主统计固定为 `ended_at`，同时保留 `created_at` 辅助口径。
- 建立跨发布日志保留或数据库月报，避免 11-17～11-23 这类七日缺口；月度 Run 报表使用 `runs/run_attempts/run_events`，不要用 stderr 当分母。
- 通知 `push/config` 503 历史簇：核对通知能力是否按设计未启用；只有配置快照或端点实测可将其标为已闭环。
- 两次 PostgreSQL `CONNECT_TIMEOUT` 504：纳入数据库连接与宿主资源观察。
- WeKnora/知识库依赖降级：按能力启用状态和依赖健康单独跟踪。
- `model_catalog_invalid` 502：属于厂商模型目录解析兼容问题，不计入 Nginx upstream 502。
- 受控 6～8 秒授权注入为可选；已有真实慢样本不替代本次部署后的数据库失败统计。

无时间的旧 OIDC、MCP、Skill 索引错误只进入“需版本/时间核对”清单，不因其出现在导出文件中就升级为当前生产事故。

## 6. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 当前 `9406dfbf` 的启动等待预算小于真实上界（compose ≈110 秒、`/health` 180 秒，探针约 21–22 分钟） | 不 dispatch；先修三段等待、回归和 CI，再更新 target SHA |
| compose web healthcheck（≈110 秒）先判 unhealthy，`up -d --wait` 提前失败 | Phase 0 先核对 `--wait` 失败语义并纳入回归；必要时调整 healthcheck 预算或改等待方式，部署记录失败原因 |
| 部署误用旧脚本副本 | 只执行已验证 bundle 原始脚本；归档脚本 SHA；不以 grep 单字符串放行 |
| 3 次探针最终全部失败 | readiness 门禁失败并按 `fail_after_migration` 回滚/停止；保留每次 attempt 和 ready 输出；不 kickstart 掩盖 |
| 回滚后旧版本也能力不可用 | 按手册处理；人工核对旧版本 `/health/ready`，继续 fail-closed |
| Release Workflow 在正式发布后才验证失败 | 冻结已发布 tag，不删除/覆盖；递增版本并以新 commit/CI 发布 |
| 固定 IPv4 变化 | 部署前从容器重测可达性并核对实际 Nginx 渲染；不可达时停止并重新确定宿主网关 |
| 迁移差异扩大 | 停止发布并重新裁决；不写库、不改账本、不补 dev 历史迁移 |
| 日志滚动导致一周证据不完整 | 部署时保存基线，每日归档增量；以数据库和 Nginx 日志补足，不用当前 0 条倒推完整窗口 |
| 5xx 总量误导 | 按 code、端点、时间和依赖拆分；不把模型目录 502、通知 503、Runtime 503混为同一事故 |

## 7. 时间表（相对）

| 时间 | 动作 |
| --- | --- |
| T-发布 | 修正三段启动等待预算、补脚本回归、同步文档，合并并等待四项 CI（已完成：PR #14 → `d19ec5fd`） |
| T+0 | 固定 `TARGET_SHA=d19ec5fd04203a9b38b3ba048bf19d4ef7690483`，dispatch 并验证 Release（已完成：run `45753725184`） |
| T+10 min | 迁移门禁与签署、备份设施/IPv4/锁预检 |
| T+20 min | 使用 verified bundle 原始脚本部署；以实际启动预算（compose ≈110 秒起、探针上界约 21–22 分钟）安排维护窗口，不再承诺固定 30 分钟 |
| 部署完成后 | 记录 `DEPLOYED_AT`、权威 backup ID、readiness、日志 offsets；登记/创建正式一周复核任务（不早于 `DEPLOYED_AT + 168h`） |
| T+1～3 h | 专项验收、真实 Run/Attempt、任务线程、授权 SQL、Nginx 与 PF-07 |
| T+24 h | 稳定性观察和日志增量归档 |
| 2026-12-01 09:00 | 中期或正式复核；是否满 168 小时以实际 `DEPLOYED_AT` 判断 |
| `DEPLOYED_AT+168h` 后 | watcher 正式恢复决策 |

## 8. 证据与记录

- 部署记录：`deploy-record-v2026.11.25-01-<date>.md`（仓库外）；
- 部署脚本回归：`scripts/ci/release-wait.test.mjs` 与 `scripts/ci/deployment-safety.test.mjs` 中的启动等待断言（CI 运行），本机验证记录见 §4 Phase 0 实施记录；
- 11-25 专用取证副本/附录：所有命令统一使用本次 `DEPLOYED_AT`，不沿用 11-24 硬编码时间；
- PF-07 目标环境验收记录：版本、身份、Run/Attempt、证据位置和验收人；
- 月度日志导出四件套：`stats-20261125T031000Z.json`、`server-run-last30d.log`、`server-run-untimestamped-unattributable.log`、`README.md`（仓库外；本次复核副本在本机 `Downloads`，归档后以其受控路径为准）；只作历史分类和基线，不作为发布成功率或完整月度可用性证明；
- 事件记录：[启动探针重试失效](incident-2026-11-24-startup-probe-retry-outage.md)、[上线后 502/503](incident-2026-11-24-post-deploy-502-503.md)、[授权复核超时](incident-2026-11-24-authorization-timeout.md)；
- 现场取证单：[2026-11-24 授权热修上线取证（回填）](acceptance-2026-11-24-evidence.md)；
- 迁移偏离：[migration-ledger-deviation-2026-11-24.md](migration-ledger-deviation-2026-11-24.md)；
- 手册：[8.4 启动重试与部署就绪门禁](mac-mini-deployment-runbook.md#84-20261125-01-补充启动重试与部署就绪门禁)。

## 9. 不做什么

- 不在三段等待预算未修正、compose `--wait` 判定未核对时 dispatch 当前 `9406dfbf`；
- 不把 `/health` 的 180 秒当作完整启动预算（compose healthcheck 约 110 秒、探针上界约 21–22 分钟）；
- 不把导出 `README.md` 的“连续 8 天”与统计的“7 个完整自然日 + 2 个无失败周日”混算天数或分母；
- 不把 stderr 的请求条数当错误率、独立事故数或成功请求分母；
- 不用“后续未出现”关闭存在七日日志缺口或无时间戳的事项；
- 不写库、不删改 `schema_migrations`、不把 dev 历史迁移补进 Release；
- 不跳过 watcher 停止、锁检查、迁移裁决和异机备份；
- 不用人工 kickstart 代替部署门禁验证；
- 不复用旧 `release.sh` 副本，不自由编辑 deviation；
- 不用普通文本 Run 替代执行容器、成果、取消和 PF-07 验收；
- 不复用已发布 tag，不删除或覆盖不可变 Release。
