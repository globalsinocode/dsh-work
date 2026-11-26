# 2026-11-24 授权热修上线取证单（生产回填）

> **用途**：v2026.11.24-01 授权复核超时热修已部署；本单用于补齐验收证据，并作为 v2026.11.24-02
> （Nginx 上游 IPv4 + 启动探针重试）发布前门禁与部署验收的回填记录。
>
> **填写**：生产运维（Mac mini，`deploy` 用户）。**复核**：发布负责人。
> **回传**：填好的本文件 + 证据文件（见第 8 节）。**禁止**粘贴 `runtime.env` 全文、密钥、证书私钥；
> 日志先脱敏。
>
> **原则**：全部命令只读；不写库、不手工改 `current`、不手改迁移账本、不跳过 watcher 停止。
> 任何一步与期望不一致，先停止并记录，不为了通过而绕过。

## 0. 基础信息

| 项 | 回填 |
| --- | --- |
| 环境 / 主机 | `<FILL: 生产 Mac mini 192.168.1.99>` |
| 部署根目录 `DWP_ROOT` | `/Users/deploy/services/dsh-work` |
| 操作人 / 时间（UTC） | `<FILL>` |
| 当前 `active-release` | `<FILL>` |
| 当前 `current` 指向 | `<FILL>` |
| 当前版本 `release.json`（version / commit） | `<FILL>` |
| 本次 `DEPLOYED_AT`（UTC） | `<FILL>` |

```bash
DWP_ROOT=/Users/deploy/services/dsh-work
cat "$DWP_ROOT/active-release"
readlink "$DWP_ROOT/current"
# release.json 含约 1600 条文件清单（数百 KB），只读 version/commit，不要整份 cat。
node -e "const r=require(process.argv[1]); console.log(r.version, r.commit)" "$DWP_ROOT/current/release.json"
# macOS BSD stat 没有 -u；取 UTC 用 date -u -r。
date -u -r "$DWP_ROOT/active-release" '+%Y-%m-%dT%H:%M:%SZ'
```

---

## 1. 立即回传（最小集，先发这一节）

发布 v2026.11.24-02 前必须先拿到这一节。请直接贴以下格式，缺项写“未做/阻塞”：

```text
[gate] active-release = <v2026.11.24-01 或待发布版本>
[gate] ledger diff: (空输出，exit 0) / (附 diff)
[gate] ledger NULL 检查: 无 NULL / 有
[gate] launchctl print watcher: not found / running
[gate] automation/.watch.lock: absent / 存在（PID）
[gate] .release.lock: absent / 存在（PID）
[gate] DSH_WORK_AUTO_DEPLOY_ENABLED=false / true
```

### 1.1 迁移账本一致（发布手册 8.1）

按[部署手册 8.1 节](mac-mini-deployment-runbook.md)的完整代码块执行，**不要只比文件名**。
事后复核 v2026.11.24-01 时 `RELEASE_DIR="$DWP_ROOT/current"`；发布 v2026.11.24-02 前必须换成
**目标 merge commit 的干净检出**（不要用 `current`）。

回填：

| 检查 | 结果 |
| --- | --- |
| release 迁移条数 | `<FILL>` |
| 生产账本条数 | `<FILL>` |
| `grep -q $'\tNULL$'` | `<FILL: 无 / 有，附行>` |
| `diff -u` 输出 | `<FILL: empty / 附完整输出>` |
| `diff` 退出码 | `<FILL>` |

### 1.2 watcher 已停止、无活动锁

```bash
DWP_ROOT=/Users/deploy/services/dsh-work
LABEL=com.company.dsh-work.release-watcher
TARGET="gui/$(id -u)/$LABEL"

grep -E '^(DSH_WORK_GITHUB_REPOSITORY|DSH_WORK_AUTO_DEPLOY_ENABLED)=' "$DWP_ROOT/runtime.env"

launchctl bootout "$TARGET" 2>/dev/null || true
if launchctl print "$TARGET" >/dev/null 2>&1; then
  echo "release watcher 仍在运行，停止发布" >&2
fi

for lock in "$DWP_ROOT/automation/.watch.lock" "$DWP_ROOT/.release.lock"; do
  if [[ -r "$lock/pid" ]]; then
    pid=$(<"$lock/pid")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      echo "存在活动部署锁：$lock (PID $pid)" >&2
    else
      echo "存在陈旧锁：$lock（先按手册调查，不自动删除）" >&2
    fi
  elif [[ -e "$lock" ]]; then
    echo "存在无法判定的锁：$lock" >&2
  else
    echo "lock absent: $lock"
  fi
done
```

回填：watcher `not found`；两个 lock 均 `absent`；`AUTO_DEPLOY=false`；
若 watcher 原本在跑，请记录 `bootout` 时间与执行人。

### 1.3 生产独有版本裁决（发布负责人填写）

本生产库由 dev 分支历史迁移与 upstream release 合并而来，**账本会比 release 多出既有的历史版本**。
此时“diff 为空”不可达，门禁按以下四项裁决，不得直接跳过：

| 项 | 结果 |
| --- | --- |
| `only_in_release`（待应用） | `<FILL: 必须为 0>` |
| 公共版本 `(version, checksum)` 不符 | `<FILL: 必须为 0>` |
| `NULL` checksum | `<FILL: 必须为 0>` |
| `only_in_ledger`（生产独有） | `<FILL: 条数 + 清单文件>` |
| 生产独有版本是否为既有历史（非本次引入） | `<FILL: 11-16/11-24 部署日志均为 skipped、零 DDL；或时间戳/备份证据>` |
| 本次 release 的迁移集合是否与当前已部署版本一致 | `<FILL: 129/129 blob 哈希一致，或附差异>` |
| **裁决** | `<FILL: 放行并登记偏离 / 停止>` |

裁决为“放行并登记偏离”时，必须在部署记录与事件记录里写明：差异条数、清单位置、判定依据、
放行人、日期；不得写库、不得删除账本行、不得把 dev 历史迁移补进 release。

---

## 2. 部署时间与授权观测（v2026.11.24-01）

### 2.1 `DEPLOYED_AT`

优先使用部署时记录：

```bash
cat "$DWP_ROOT/release-evidence-v2026.11.24-01-times.txt" 2>/dev/null || true
# macOS BSD stat 没有 -u；UTC 用 date -u -r。
date -u -r "$DWP_ROOT/active-release" '+%Y-%m-%dT%H:%M:%SZ'
grep -h 'release activated' "$DWP_ROOT"/logs/release-2026.11.24-01-deploy-*.log | tail -5
```

回填 `DEPLOYED_AT`：`<FILL>`（UTC；不要用滚动 24 小时窗口）。

### 2.2 授权失败 SQL（期望 0）

```bash
DEPLOYED_AT='<FILL: 2.1 的值>'
(
  set -a
  # shellcheck disable=SC1090
  source "$DWP_ROOT/runtime.env"
  set +a
  # psql -c 不做 :'var' 插值，必须走 stdin；同时给 created_at 与 ended_at 两种口径。
  docker compose --env-file "$DWP_ROOT/runtime.env" \
    -f "$DWP_ROOT/current/deploy/compose.yaml" \
    -f "$DWP_ROOT/generated/compose.endpoints.yaml" exec -T postgres \
    psql -U "$DSH_WORK_POSTGRES_USER" -d "$DSH_WORK_POSTGRES_DB" \
    -v deployed_at="$DEPLOYED_AT" <<'SQL'
select count(*) as auth_unavailable_created_after_deploy from run_attempts
 where error_code = 'AUTHORIZATION_CHECK_UNAVAILABLE'
   and created_at >= :'deployed_at'::timestamptz;

select count(*) as auth_unavailable_ended_after_deploy from run_attempts
 where error_code = 'AUTHORIZATION_CHECK_UNAVAILABLE'
   and ended_at >= :'deployed_at'::timestamptz;

select occurred_at, safe_metadata from run_events
 where event_type = 'run.failed'
   and safe_metadata->>'error_code' = 'AUTHORIZATION_CHECK_UNAVAILABLE'
   and occurred_at >= :'deployed_at'::timestamptz
 order by occurred_at desc limit 20;
SQL
)
```

回填：

| 项 | 结果 |
| --- | --- |
| `auth_unavailable_created_after_deploy` | `<FILL: 0 / N>` |
| `auth_unavailable_ended_after_deploy` | `<FILL: 0 / N>`（更正确的“发生后”口径） |
| 失败事件明细 | `<FILL: 无 / 每条带 authorization_phase/check_ms/slow_ms/timeout_ms/outcome>` |
| 能否与 slow/timeout/late 日志关联 | `<FILL>` |

### 2.3 授权慢日志

```bash
# warn（slow/timeout/error）在 stderr；info（recovered）在 stdout，两路都要查。
for file in "$DWP_ROOT/logs/server.stderr.log" "$DWP_ROOT/logs/server.stdout.log"; do
  echo "== $file"
  grep -c '"event":"authorization.check"' "$file" || true
  grep '"event":"authorization.check"' "$file" \
    | grep -E '"outcome":"(slow|recovered|late_success|late_error|timeout|error|denied)"' | tail -20
done
```

回填：各文件条数 `<FILL>`；slow/recovered/timeout/error 各 `<FILL>`；附最近 20 条（脱敏）。
注意：`slow` 与 `recovered` 往往分别落在 stderr 与 stdout，只看一个文件会误判为“无慢样本”。

---

## 3. 启动探针与重启恢复（503 定因）

```bash
grep -n -E '2026-11-24T06:1[4-9]' "$DWP_ROOT/logs/server.stderr.log" \
  | grep -E 'execution container|DSH ACP preflight|toolchain|service restart recovery|Unavailable' | tail -60
```

回填：

| 项 | 结果 |
| --- | --- |
| 启动探针失败日志（原文，脱敏） | `<FILL: 无 / ...>` |
| 失败原因归类 | `<FILL: Docker/执行镜像 / DSH ACP preflight / profile 竞争 / 未知>` |
| 是否出现 `execution container toolchain: …` | `<FILL: 是 / 否>` |
| `service restart recovery completed` 计数 | `<FILL: failed=N, resumedQueued=N>` |
| 未恢复的 run / attempt id | `<FILL>` |
| 是否人工 kickstart 才恢复 | `<FILL: 是（时间）/ 否>` |

---

## 4. 吴军重跑（v2026.11.24-01）

操作：在 QA 协同「会议到任务」手动重跑一次，记录新 run/attempt。SQL 校验：

```bash
(
  set -a
  # shellcheck disable=SC1090
  source "$DWP_ROOT/runtime.env"
  set +a
  docker compose --env-file "$DWP_ROOT/runtime.env" \
    -f "$DWP_ROOT/current/deploy/compose.yaml" \
    -f "$DWP_ROOT/generated/compose.endpoints.yaml" exec -T postgres \
    psql -U "$DSH_WORK_POSTGRES_USER" -d "$DSH_WORK_POSTGRES_DB" -c "
select r.id as run_id, r.status as run_status,
       a.id as attempt_id, a.status as attempt_status, a.error_code, a.started_at, a.ended_at
  from runs r
  join run_attempts a on a.tenant_id = r.tenant_id and a.run_id = r.id
 where r.id = '<FILL: 新 run id>';"
)
```

回填：

| 项 | 结果 |
| --- | --- |
| 新 run id / attempt id | `<FILL>` |
| `run.started` | `<FILL: 有/无>` |
| `assistant.delta` | `<FILL: 有/无>` |
| `assistant.completed` | `<FILL: 有/无>` |
| `run.completed` | `<FILL: 有/无>` |
| `run_attempts.error_code` | `<FILL: 空 / 值>` |
| 用户可见结果 | `<FILL>` |

---

## 5. 502 / 503 现场与修复验证

### 5.1 上游解析与配置（当前版本）

```bash
docker compose --env-file "$DWP_ROOT/runtime.env" \
  -f "$DWP_ROOT/current/deploy/compose.yaml" \
  -f "$DWP_ROOT/generated/compose.endpoints.yaml" exec -T web sh -c \
  'cat /etc/hosts; nslookup host.docker.internal 127.0.0.11 || true; sed -n "/upstream dsh_work_server/,/}/p" /etc/nginx/conf.d/default.conf'

docker compose --env-file "$DWP_ROOT/runtime.env" \
  -f "$DWP_ROOT/current/deploy/compose.yaml" \
  -f "$DWP_ROOT/generated/compose.endpoints.yaml" logs --since 2026-11-24T06:15:00Z web 2>&1 \
  | grep -E 'no live upstreams|connect\(\) to \[fdc|upstream timed out' | tail -20
```

回填：

| 项 | 结果 |
| --- | --- |
| `/etc/hosts` 中 `host.docker.internal` 行 | `<FILL>` |
| `nslookup` 返回地址 | `<FILL: 含 fdc4… / 仅 192.168.65.254 / 其他>` |
| nginx upstream 段（脱敏） | `<FILL>` |
| Nginx 日志 IPv6 connect 失败条数 | `<FILL>` |
| `no live upstreams` 条数 | `<FILL>` |

### 5.2 110 次请求（60 顺序 + 50 并发）

```bash
ORIGIN='https://<FILL: 员工端 Origin，如 192.168.1.99:4174>'
CA="$DWP_ROOT/certs/root-ca.crt"
for i in $(seq 1 60); do
  curl -s -o /dev/null -w '%{http_code}\n' --cacert "$CA" "$ORIGIN/api/workbench/v1/session"
done | sort | uniq -c
seq 1 50 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  --cacert "$CA" "$ORIGIN/api/workbench/v1/session" | sort | uniq -c
```

期望：全部 401（或 200），**0 个 502/499**。回填：`<FILL: 各状态码计数>`。

> **注意**：110 次探测只是冒烟，**不能**证明 502 根因已除。11-24-01 的实测就出现过
> “探测全 401、同期 Nginx 仍 397 次 IPv6 connect 失败 + 24 次 no live upstreams”的情况。
> 修复验收必须同时看部署后 Nginx 日志（见 7.3）：`[fdc…]` 与 `no live upstreams` 必须为 0，
> 且 `docker logs` 是滚动缓冲，只能作为下限。

### 5.3 503 复查

```bash
grep -c 'RUNTIME_UNAVAILABLE' "$DWP_ROOT/logs/server.stderr.log" 2>/dev/null || true
grep -n 'RUNTIME_UNAVAILABLE' "$DWP_ROOT/logs/server.stderr.log" | tail -10
```

回填：部署截点后 503 条数 `<FILL>`；发生时间/run id `<FILL>`。

---

## 6. 受控 6–8 秒慢授权（Task 9 Step 3）

按实际勾选并填写：

- [ ] **已执行**（隔离/受控环境，一次 `setup` 或 `scheduled` 授权稳定延迟 6～8 秒且最终成功）
  - 证据：Run 成功 `<FILL>`；`authorization.check` 先 `slow` 后 `recovered` `<FILL>`；
    同一 run/attempt/phase 可关联 `<FILL>`；未出现第二个并发授权重试 `<FILL>`；
    工具侧未被旧 6 秒预算判死 `<FILL>`。
- [ ] **真实生产样本**（非受控注入，但满足 slow→recovered、同一 run/attempt/phase、Run 成功）：
  - run/attempt/phase `<FILL>`；slow 耗时 `<FILL>`（stderr）；recovered 耗时 `<FILL>`（stdout）；
    是否超过 8 秒 `<FILL>`；是否出现第二个并发授权重试 `<FILL>`。
- [ ] **环境阻塞**（没有可安全使用的受控延迟设施）：原因 `<FILL>`；计划补齐时间 `<FILL>`。
  不得用普通快速 Run 替代，不得用单测替代本项。

---

## 7. v2026.11.24-02 补丁部署验收（发布后填）

> 与 11-24-01 相同项目不重复贴命令，按对应节重跑即可。**注意区分**：
> `DSH_WORK_SERVER_HOST=127.0.0.1` 是服务自身监听地址，**不要动**；
> Nginx 上游用新增的 `DSH_WORK_UPSTREAM_HOST`。

### 7.1 部署前：固定 Nginx 上游 IPv4

```bash
docker compose --env-file "$DWP_ROOT/runtime.env" \
  -f "$DWP_ROOT/current/deploy/compose.yaml" \
  -f "$DWP_ROOT/generated/compose.endpoints.yaml" exec -T web sh -c \
  'cat /etc/hosts; nslookup host.docker.internal 127.0.0.11 || true'
```

回填：

| 项 | 结果 |
| --- | --- |
| 容器内解析结果 | `<FILL>` |
| 选定 `DSH_WORK_UPSTREAM_HOST` | `<FILL: 如 192.168.65.254>` |
| 写入 `runtime.env` 的时间/执行人 | `<FILL>` |
| 写入后 `grep '^DSH_WORK_UPSTREAM_HOST='` | `<FILL: 值>` |

### 7.2 部署后事实

| 项 | 结果 |
| --- | --- |
| `active-release` | `<FILL: v2026.11.24-02>` |
| `current` / `release.json` commit | `<FILL>` |
| 新 `DEPLOYED_AT`（UTC） | `<FILL>` |
| 公网 `/health` 200 | `<FILL>` |
| 部署等待日志 | `<FILL: release health check passed after …s；或 release health check failed 并回滚>` |
| compose web 容器 healthcheck | `<FILL: 秒级 healthy（静态 /nginx-health）；如曾被判 unhealthy 记录时间>` |
| 宿主 `127.0.0.1:4190/health/ready` | `<FILL>` |
| `executionCapabilities.dsh` / `executionContainer` | `<FILL: 均 available；python 状态>` |
| 部署脚本就绪门禁 | `<FILL: 出现 release readiness check passed / failed 并回滚>` |
| 首启日志 `execution container toolchain: …` | `<FILL: 有/无（时间）>` |
| 是否需要人工 kickstart | `<FILL: 否 / 是>` |
| `service restart recovery completed` | `<FILL: failed=N, resumedQueued=N>` |

### 7.3 修复验证

| 项 | 结果 |
| --- | --- |
| 110 次请求 502/499 计数（重跑 5.2） | `<FILL: 0 个 / N 个>`（仅冒烟） |
| Nginx 日志 `no live upstreams` / `[fdc…]`（重跑 5.1） | `<FILL: 0 条 / N 条>`（**硬阈值：部署后 0 条 `[fdc…]`、0 条 `no live upstreams`**；按 since 部署时间统计） |
| 部署后 1 小时内真实用户 499/502 是否新增 | `<FILL: 0 / N，末次时间>` |
| 新 `DEPLOYED_AT` 起授权失败计数（重跑 2.2） | `<FILL: 0 / N>` |
| 吴军重跑（重跑第 4 节） | `<FILL: 成功 / 失败>` |
| 任务对话打开时不再出现 `/runs/<sessionId>` 404 或“不存在”误报 | `<FILL: 是 / 否>` |
| 受控 6–8 秒（重跑第 6 节） | `<FILL: 通过 / 环境阻塞>` |

### 7.4 结论

- [ ] 通过，可进入一周复核
- [ ] 不通过 / 部分通过：`<FILL: 原因与回滚决定>`

## 8. 回传材料清单

- [ ] 第 0、1 节回填与本单文件
- [ ] 8.1 门禁命令输出（release migrations / ledger / diff / NULL）
- [ ] SQL 查询原始输出（文本即可）
- [ ] `server.stderr.log` 片段（启动探针、authorization.check、restart recovery，脱敏）
- [ ] Nginx 日志片段与 upstream 段（脱敏）
- [ ] 110 次请求探测输出
- [ ] 吴军新 run id + 结果截图/事件清单
- [ ] 受控 6–8 秒证据，或阻塞说明
- [ ] 证据文件命名：`evidence-2026-11-24-<节号>-<UTC时间>.txt`

---

## 9. 结论与遗留（复核人填写）

| 项 | 结论 |
| --- | --- |
| v2026.11.24-01 授权观测（SQL 0？） | `<FILL>` |
| 吴军重跑 | `<FILL>` |
| 502 根因与修复验证 | `<FILL>` |
| 503 根因（启动探针日志） | `<FILL>` |
| 受控 6–8 秒窗口 | `<FILL: 通过 / 环境阻塞>` |
| 是否可以进入 v2026.11.24-02 发布 | `<FILL: 是 / 否，原因>` |
| 自动部署 watcher | `<FILL: 继续关闭（默认）/ 已恢复（时间、执行人）>` |

**遗留问题 / 后续动作**：

```text
<FILL>
```

**签字**：生产操作人 `<FILL>`　复核人 `<FILL>`　时间（UTC）`<FILL>`
