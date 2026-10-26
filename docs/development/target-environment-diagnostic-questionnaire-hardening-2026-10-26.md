# 目标机环境与最近错误采集问卷

**用途：** 将本文件交给目标机上的智能体执行。目标机智能体需要识别实际部署方式，完成只读诊断，把脱敏后的答案填写到本文件末尾的“最终回答”中，再将完整回答带回本地开发环境，用于模拟目标机并复现“本地正常、目标机报错”的问题。

**采集日期：** 2026-10-17  
**默认错误窗口：** 最近 24 小时；若 24 小时没有错误，则扩展到最近 7 天。  
**适用部署：** macOS/launchd、Linux/systemd、Windows 服务或手工进程、Docker Compose、源码直接启动。

---

## 1. 给目标机智能体的任务

请在目标机上完成以下工作：

1. 先阅读目标机当前版本仓库中的 `AGENTS.md`。若存在以下文档，也只读核对：
   - `docs/development/development.md`
   - `docs/development/overview.md`
   - `docs/development/internal-ports.md`
   - `docs/release/mac-mini-deployment-runbook.md`
   - `docs/release/dsh-runtime-delivery.md`
2. 判断目标机的操作系统、应用版本、部署方式、进程管理器、数据库位置和 DSH Runtime 位置。不要先假定它是 Mac mini。
3. 只执行本文件允许的只读检查。命令不适用或不存在时，不要安装工具或修改机器；记录“未执行”、原因和替代证据。
4. 采集目标机最近的运行错误，并尽量关联 `traceId`、`runId`、`attemptId`、错误时间、错误码和触发操作。
5. 对照目标机实际运行版本，而不是对照另一台机器、历史目录或未启用的 checkout。
6. 将结果整理到第 12 节的固定模板中。不要只返回命令输出；必须给出环境差异判断和最可能的复现条件。

### 完成标准

最终回答必须能够让本地开发者明确知道：

- 目标机实际上运行哪个 Release/Commit；
- 服务进程实际使用哪个 Node、配置文件和 DSH checkout；
- PostgreSQL 已应用到哪个迁移；
- 最近一次错误何时发生、出现在哪一层、对应什么请求或 Run；
- 本地为了复现应匹配哪些版本、环境变量状态、路径、权限和依赖；
- 哪些条件无法在本地安全模拟，仍需目标机验证。

---

## 2. 严格安全边界

### 允许

- 读取版本、状态、进程、端口、文件路径、非敏感配置、证书元数据和日志；
- 调用 `/health/live`、`/health/ready`、`/health` 等只读健康接口；
- 对 PostgreSQL 执行本文件给出的 `SELECT` 查询；
- 读取日志后在输出前脱敏；
- 读取 `runtime.env` 或 `.env` 以判断配置状态，但只能按第 7 节输出。

### 禁止

- 不得重启、停止或重新加载服务、容器、数据库、Docker Desktop 或整机；
- 不得运行迁移、发布、回滚、恢复、备份、安装依赖、构建或自动修复命令；
- 不得运行 `docker compose down`、`docker compose up`、`launchctl kickstart`、`systemctl restart`、`pnpm install`、`pnpm dev`、`db:migrate`；
- 不得修改 `runtime.env`、`.env`、数据库、证书、权限、软链接或当前 Release；
- 不得运行后粘贴 `env`、`printenv`、`set`、`set -x`、`docker compose config` 或完整服务定义；
- 不得输出密码、数据库完整连接串、API Key、Token、Cookie、Session Secret、OIDC Client Secret、Bearer 凭据、私钥、模型凭据或完整员工/业务数据；
- 不得为了“验证”重新触发生产 Agent 任务。只分析已有错误；如果需要复现，仅描述步骤并等待人工批准。

发现秘密时统一替换为：

```text
<REDACTED:配置键名，SET/EMPTY/MISSING>
```

内部域名/IP 如果不允许离开目标环境，替换为 `<INTERNAL_HOST>`；保留端口、协议和路径结构。日志中的员工姓名、文件名、业务正文、模型输入输出也必须脱敏。

---

## 3. 第一步：识别主机与部署方式

先运行适用于当前系统的命令。不要把不同系统的命令全部执行一遍。

### 3.1 macOS 或 Linux

```bash
date -u '+UTC %Y-%m-%dT%H:%M:%SZ'
date '+LOCAL %Y-%m-%dT%H:%M:%S%z %Z'
uname -a
id
pwd
```

macOS 追加：

```bash
sw_vers
uname -m
sysctl -n machdep.cpu.brand_string 2>/dev/null || true
sysctl -n hw.memsize 2>/dev/null || true
launchctl list | grep -E 'dsh-work|deepseek|ai-hub' || true
```

Linux 追加：

```bash
cat /etc/os-release
uname -m
nproc
free -h
systemctl list-units --type=service --all | grep -E 'dsh-work|deepseek|ai-hub' || true
```

### 3.2 Windows PowerShell

```powershell
(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
Get-CimInstance Win32_Processor | Select-Object Name,Architecture,NumberOfCores,NumberOfLogicalProcessors
Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
Get-Location
Get-Service | Where-Object { $_.Name -match 'dsh|deepseek|ai.?hub' -or $_.DisplayName -match 'dsh|deepseek|ai.?hub' } | Select-Object Name,DisplayName,Status,StartType
```

### 3.3 判断结果

从下列选项中选择所有实际存在的方式，并给出证据：

- [x] macOS LaunchAgent/launchd 管理 dsh-work 后端 — `~/Library/LaunchAgents/com.company.dsh-work.server.plist`（`RunAtLoad=true`、`KeepAlive={SuccessfulExit=false}`、`WorkingDirectory=<DEPLOY_ROOT>/current`、`ProgramArguments=[<DEPLOY_ROOT>/current/scripts/deploy/run-server.sh, <DEPLOY_ROOT>]`）；`launchctl print gui/502/com.company.dsh-work.server` → `state = running`、`pid = 77334`
- [ ] Linux systemd 管理 dsh-work 后端 — 不适用（Darwin 25.6.0 / macOS 26.6.2）
- [ ] Windows Service/任务计划管理 dsh-work 后端 — 不适用
- [ ] PM2 或其他进程管理器 — `pm2` 未安装（`command -v pm2` 无结果）；除 launchd 外无其它后端进程管理器
- [x] Docker Compose 管理 PostgreSQL/Nginx — 同项目 `dsh-work`：`dsh-work-postgres-1`（postgres:17.11-alpine，healthy，Up 2 weeks）、`dsh-work-web-1`（nginx:1.30.4-alpine，healthy，Up 23 hours）
- [ ] Docker Compose 同时管理后端 — 后端不在容器内，无 server 容器（`docker ps -a` 中无 dsh-work 后端容器）
- [ ] 源码目录中手工运行 `node`/`pnpm` — 否；launchd 调用 Release 内 `scripts/deploy/run-server.sh`，脚本 `source runtime.env` 后 `cd current && exec ${DSH_WORK_NODE_BIN} server/dist/main.js`
- [x] GitHub Release 解包部署，存在 `active-release` 和 `current` — `active-release` = `v2026.10.16-01`；`current` → `releases/v2026.10.16-01`；`previous` → `releases/v2026.10.10-01`
- [x] 其他：源码 checkout `/Users/deploy/services/dsh-work-src`（main@667b00e，`server/package.json` releaseVersion=2026.10.16-01）存在但**不直接运行**，仅用于构建/发版；未加载 `com.company.dsh-work.release-watcher`（`launchctl print` 返回 Could not find service），`DSH_WORK_AUTO_DEPLOY_ENABLED=false`

命中的部署根目录：`<DEPLOY_ROOT>` = `/Users/deploy/services/dsh-work`。以下文件全部存在：`runtime.env`、`active-release`、`current`（软链）、`current/deploy/compose.yaml`、`generated/compose.endpoints.yaml`、`logs/server.stderr.log`、`current/server/config/dsh/runtime-lock.json`。

如果部署根目录未知，可用进程命令行、服务定义的程序路径、Compose 项目标签和以下常见文件名定位。只输出命中的路径，不输出文件内容：

```text
runtime.env
active-release
current
deploy/compose.yaml
generated/compose.endpoints.yaml
logs/server.stderr.log
server/config/dsh/runtime-lock.json
```

---

## 4. 主机差异与资源

记录以下值。命令不存在时说明原因：

### macOS/Linux

```bash
umask
locale
ulimit -a
df -h
command -v node || true
command -v pnpm || true
command -v git || true
command -v docker || true
node --version 2>&1 || true
pnpm --version 2>&1 || true
git --version 2>&1 || true
docker version --format 'Docker client={{.Client.Version}} server={{.Server.Version}}' 2>&1 || true
docker compose version 2>&1 || true
```

### Windows PowerShell

```powershell
Get-Culture
Get-TimeZone
Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free,Root
Get-Command node,pnpm,git,docker -ErrorAction SilentlyContinue | Select-Object Name,Source,Version
node --version
pnpm --version
git --version
docker version --format 'Docker client={{.Client.Version}} server={{.Server.Version}}'
docker compose version
```

另外回答：

- 文件系统是否区分大小写；
- 服务账号是否与当前诊断账号相同；
- 目标机时区、区域设置和默认编码；
- 可用磁盘是否低于 5 GiB；
- 是否存在内存压力、Swap 压力或容器资源限制；
- 是否存在 HTTP/HTTPS 代理、企业根证书或出站网络限制。代理只报告“有/无”和代理主机是否可达，不输出带凭据的 URL。

---

## 5. 应用代码、Release 与构建产物

### 5.1 Release 部署

若存在部署根目录，记为 `<DEPLOY_ROOT>`，执行只读检查：

```bash
cat <DEPLOY_ROOT>/active-release 2>/dev/null || true
readlink <DEPLOY_ROOT>/current 2>/dev/null || true
test -r <DEPLOY_ROOT>/current/release.json && \
  node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({version:r.version,commit:r.commit,platform:r.platform,nodeRuntime:r.nodeRuntime,dshRuntime:r.dshRuntime,createdAt:r.createdAt},null,2))' \
  <DEPLOY_ROOT>/current/release.json
node -e 'const p=require(process.argv[1]); console.log(JSON.stringify({version:p.version,releaseVersion:p.releaseVersion},null,2))' \
  <DEPLOY_ROOT>/current/server/package.json 2>/dev/null || true
```

检查 `current/apps/*/dist` 和 `current/server/dist` 是否存在，只报告存在性、所有者、权限和修改时间，不列出业务数据目录。

### 5.2 Git checkout 或源码启动

在实际运行的仓库目录执行：

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git branch --show-current
git status --short --untracked-files=no
git remote get-url origin | sed -E \
  -e 's#(https?://)[^/@]+:[^/@]+@#\1<REDACTED>@#' \
  -e 's#(https?://)[^/@]+@#\1<REDACTED>@#'
node -e 'const p=require("./server/package.json"); console.log(JSON.stringify({version:p.version,releaseVersion:p.releaseVersion},null,2))'
```

远端 URL 中若含用户名或 Token 必须脱敏。工作区若不干净，仅列文件路径和状态，不粘贴 diff。

### 5.3 必须回答

- 活动 Release/Commit：`v2026.10.16-01 / af0faca9a86ab8fdecb937286c69199572232e3a`（`release.json`：platform=darwin-arm64、nodeRuntime=host-managed、dshRuntime=host-managed-locked-checkout、createdAt=2026-10-16T02:49:07.186Z）
- 当前目录是否与活动 Release 指向同一份代码：`是（运行代码即该 Release）`。`<DEPLOY_ROOT>` 不是 Git 仓库（无 `.git`），因此以“服务进程 cwd + launchd 工作目录 + current 软链”三重一致判定：`lsof -p 77334` 的 cwd = `<DEPLOY_ROOT>/releases/v2026.10.16-01`，plist WorkingDirectory = `<DEPLOY_ROOT>/current`，`current` → 同一 Release 目录。
- 是否存在“代码已更新但服务仍运行旧 Release”：`是`。源码 checkout `/Users/deploy/services/dsh-work-src` 位于 `main@667b00e`（提交信息 `fix(web): 弹窗内 el-form 拦截原生提交…`），比运行中的 release commit `af0faca`（`chore(release): prepare 2026.10.16-01`）领先 1 个提交；`DSH_WORK_AUTO_DEPLOY_ENABLED=false` 且未加载 dsh-work release-watcher，因此不会自动跟进。（未发现服务运行在 `previous` Release。）
- 前后端构建时间是否一致：`一致`。`current/server/dist`、`current/apps/workbench-web/dist`、`current/apps/admin-web/dist` 的 mtime 均为 `2026-10-16T10:49:06+0800`，与 `release.json.createdAt` 同一分钟内。
- 目标机版本相对本地需要复现的精确基线：`macOS 26.6.2 (25G83) arm64 Apple M4 / 10 核 / 24 GiB → Node v26.8.1（服务进程用 /opt/homebrew/Cellar/node/26.8.1/bin/node，DSH_WORK_NODE_BIN=/opt/homebrew/bin/node 为同一二进制）→ pnpm 11.24.0 → Docker 29.7.2 + Compose v5.5.1（Docker Desktop，VM 10 CPU / 8.32 GB）→ PostgreSQL 17.11-alpine（127.0.0.1:5434/dsh_work，迁移至 0081_knowledge_chunks.sql）→ DSH 0.1.2-rc.1 @ 76fda729799fe9b3848dbe2c211d4b231032b81e（/Users/deploy/services/deepseek-harness）→ dsh-work v2026.10.16-01 @ af0faca`。若要复现“目标机最新代码”需用 `dsh-work-src@667b00e`。

---

## 6. 服务进程、端口、容器与健康

### 6.1 进程实际运行信息

macOS/Linux：

```bash
ps -axo pid,ppid,user,lstart,command | grep -E '[d]sh-work|[d]ist/main.js|[s]rc/main.ts|[d]eepseek-harness'
```

Windows PowerShell：

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh-work|dist/main.js|src/main.ts|deepseek-harness' } | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine
```

重点确认“服务进程的 Node 可执行文件路径”，它可能与交互终端中的 `node` 不同。

如果是 launchd，只摘取状态字段，不粘贴完整环境：

```bash
launchctl print "gui/$(id -u)/com.company.dsh-work.server" 2>&1 | \
  grep -E '^\s*(state|pid|last exit code|program|path) =|Could not find service' || true
launchctl print "gui/$(id -u)/com.company.dsh-work.release-watcher" 2>&1 | \
  grep -E '^\s*(state|pid|last exit code|program|path) =|Could not find service' || true
```

如果是 systemd，替换实际服务名：

```bash
systemctl show <SERVICE_NAME> \
  -p ActiveState -p SubState -p ExecMainPID -p ExecMainStatus -p FragmentPath -p User
```

### 6.2 监听端口

macOS：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(4174|4180|4190|5434)\b' || true
```

Linux：

```bash
ss -ltnp | grep -E ':(4174|4180|4190|5434)\b' || true
```

Windows PowerShell：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4174,4180,4190,5434 } | Select-Object LocalAddress,LocalPort,OwningProcess
```

### 6.3 Docker Compose

如果实际部署使用 Compose，使用目标机真实的 `runtime.env`、基础 Compose 文件和 endpoint overlay，只运行：

```bash
docker compose --env-file <DEPLOY_ROOT>/runtime.env \
  -f <DEPLOY_ROOT>/current/deploy/compose.yaml \
  -f <DEPLOY_ROOT>/generated/compose.endpoints.yaml ps
```

不要省略 endpoint overlay，也不要运行会展开完整配置和秘密的 `docker compose config`。

### 6.4 健康接口

优先从目标机回环访问，记录 HTTP 状态码和脱敏后的 JSON：

```bash
curl --silent --show-error --max-time 15 -w '\nHTTP %{http_code}\n' http://127.0.0.1:4190/health/live
curl --silent --show-error --max-time 15 -w '\nHTTP %{http_code}\n' http://127.0.0.1:4190/health/ready
curl --silent --show-error --max-time 15 -w '\nHTTP %{http_code}\n' http://127.0.0.1:4190/health
```

如只能通过 HTTPS 入口访问，使用目标机已配置的 CA 和实际入口，但不要使用 `-k` 绕过证书验证。分别说明：

- `/health/live` 是否存活；
- `/health/ready` 是否因数据库而失败；
- `/health` 中 database、DSH、Python 能力状态；
- 回环正常但 HTTPS 失败时，是否为 Nginx、证书、Host/Origin 或 `host.docker.internal` 问题。

---

## 7. 配置差异（只输出安全摘要）

确定服务实际读取的是哪个文件：生产通常是 `<DEPLOY_ROOT>/runtime.env`，开发通常是仓库根 `.env`。不要假定二者可以互换。

### 7.1 可以输出实际值的配置

仅在确认不含凭据后输出以下键的值；内部主机可按安全要求脱敏，但保留协议和端口：

```text
NODE_ENV
DSH_WORK_DEPLOY_ROOT
DSH_WORK_NODE_BIN
DSH_WORK_AUTO_DEPLOY_ENABLED
DSH_WORK_RELEASE_POLL_INTERVAL_SECONDS
DSH_WORK_SERVER_HOST
DSH_WORK_SERVER_PORT
DSH_WORK_BIND_ADDRESSES
DSH_WORK_BIND_ADDRESS
DSH_WORK_WORKBENCH_PORT
DSH_WORK_ADMIN_PORT
DSH_WORK_POSTGRES_PORT
DSH_WORK_POSTGRES_DB
DSH_WORK_POSTGRES_USER
DSH_WORK_DATA_ROOT
DSH_WORK_DSH_SESSIONS_ROOT
DSH_RUNTIME_HOME
DSH_EXPECTED_VERSION
DSH_EXPECTED_COMMIT
DSH_RUNTIME_COMPATIBILITY
DSH_HOME
DSH_WORK_PUBLIC_HOST
DSH_WORK_TLS_CERT_FILE
DSH_WORK_CA_CERT_FILE
NODE_EXTRA_CA_CERTS
DSH_WORK_COOKIE_SECURE
DSH_WORK_SESSION_TTL_SECONDS
DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS
AI_HUB_PLATFORM_URL
AI_HUB_APPLICATION_ID
AI_HUB_ENVIRONMENT
AI_HUB_OIDC_ISSUER
AI_HUB_OIDC_AUDIENCE
AI_HUB_WORKBENCH_PORTAL_URL
AI_HUB_WORKBENCH_REDIRECT_URI
AI_HUB_ADMIN_PORTAL_URL
AI_HUB_ADMIN_REDIRECT_URI
DSH_WORK_WORKBENCH_ORIGINS
DSH_WORK_ADMIN_ORIGINS
DSH_WORK_WORKBENCH_DEFAULT_ORIGIN
DSH_WORK_ADMIN_DEFAULT_ORIGIN
DSH_WORK_ADMIN_BOOTSTRAP_ENABLED
```

### 7.2 只能输出状态的配置

以下键只能回答 `SET`、`EMPTY` 或 `MISSING`，禁止输出值：

```text
DSH_WORK_POSTGRES_PASSWORD
DSH_WORK_DATABASE_URL
DSH_CREDENTIAL_MASTER_KEY
DSH_CREDENTIAL_MASTER_KEY_ID
DSH_WORK_TLS_KEY_FILE
DSH_WORK_SESSION_SECRET
AI_HUB_CLIENT_ID
AI_HUB_CLIENT_SECRET
```

DSH 模型凭据可能位于独立 `DSH_HOME`。只回答“凭据提供器可解析/不可解析/未检查”，不得列目录内容或凭据正文。

### 7.3 配置异常专项检查

必须明确回答：

- 是否残留已经移除的 `DSH_WORK_AUTH_MODE=prototype`；
- 生产环境是否错误设置了 `DSH_RUNTIME_COMPATIBILITY`；
- 是否有重复环境变量；
- 路径是否存在、是否为绝对路径、服务账号是否可读/可写；
- Cookie Secure、OIDC Issuer/Audience、回调 URI、前端 Origin 是否匹配实际 HTTPS 入口；
- 数据库 URL 指向的主机/端口/数据库名是否与当前 Compose 一致（只报告一致性）；
- 服务启动环境中的 `PATH` 是否包含 `DSH_WORK_NODE_BIN` 和 DSH 所需工具；
- 本地交互 Shell 的环境与 launchd/systemd/Windows Service 环境是否不同。

---

## 8. DSH Runtime 与执行链

从活动 Release 读取锁：

```bash
node -e 'const x=require(process.argv[1]); console.log(JSON.stringify(x,null,2))' \
  <ACTIVE_RELEASE>/server/config/dsh/runtime-lock.json
```

对 `DSH_RUNTIME_HOME` 指向的实际 checkout 执行：

```bash
git -C <DSH_RUNTIME_HOME> rev-parse HEAD
git -C <DSH_RUNTIME_HOME> status --short --untracked-files=no
node -p 'require(process.argv[1]).version' <DSH_RUNTIME_HOME>/package.json
test -r <DSH_RUNTIME_HOME>/apps/cli/src/bin.ts; echo "cli-src=$?"
test -r <DSH_RUNTIME_HOME>/apps/cli/lib/bin.js; echo "cli-build=$?"
test -r <DSH_RUNTIME_HOME>/packages/bundle/acp-app/cordis.patch.yml; echo "acp-profile=$?"
test -d <DSH_RUNTIME_HOME>/node_modules/tsx; echo "tsx-dependency=$?"
```

不得在目标机运行 `git pull`、切分支、安装依赖或重建 DSH。比较并回答：

- Release Lock version/commit；
- `runtime.env` expected version/commit；
- 实际 DSH package version/Git commit；
- 三者是否完全一致；
- DSH tracked files 是否干净；
- ACP profile、构建产物和依赖是否存在；
- `DSH_HOME` 与 Session 日志目录是否存在、权限是否归服务账号；
- 最近错误属于启动预检、ACP 握手、模型调用、工具调用、取消/超时，还是成果收集。

不要把 ACP Session JSONL 原文整体贴回；只摘取与报错相关且已脱敏的时间、事件类型和错误信息。

---

## 9. PostgreSQL 与迁移状态

### 9.1 版本与连通性

若 PostgreSQL 在 Compose 中，使用实际 Compose 文件执行只读命令：

```bash
docker compose --env-file <DEPLOY_ROOT>/runtime.env \
  -f <DEPLOY_ROOT>/current/deploy/compose.yaml \
  -f <DEPLOY_ROOT>/generated/compose.endpoints.yaml \
  exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -c "select version();"'
```

### 9.2 迁移清单

```sql
select version, applied_at, checksum
from schema_migrations
order by version desc
limit 15;
```

若旧记录不存在 `checksum` 列，记录实际错误，不修改表；改用：

```sql
select version, applied_at
from schema_migrations
order by version desc
limit 15;
```

同时比较活动 Release 的 `server/migrations/*.sql`：

- Release 中最新迁移文件名；
- 数据库中最新已应用迁移；
- 是否有缺失、超前、重复或 checksum 不一致迹象；
- 服务日志是否出现 migration checksum、基线前置条件、锁等待或权限错误。

### 9.3 最近失败 Attempt（只读）

下面查询不读取 Prompt、Manifest、模型正文或文件内容：

```sql
select
  ra.id as attempt_id,
  ra.run_id,
  ra.attempt_no,
  ra.runtime_id,
  ra.status,
  ra.error_code,
  ra.created_at,
  ra.started_at,
  ra.ended_at
from run_attempts ra
where ra.status in ('failed', 'cancelled')
order by coalesce(ra.ended_at, ra.created_at) desc
limit 20;
```

取最相关的 `runId/attemptId` 后，再查询安全事件投影：

```sql
select
  event_type,
  display_message,
  trace_id,
  occurred_at
from run_events
where run_id = '<RUN_ID>' and attempt_id = '<ATTEMPT_ID>'
order by sequence;
```

即使字段名为 `display_message`，输出前仍需检查并脱敏业务内容。不要查询或输出 `manifest`、`model_route_snapshot`、用户消息、文件正文、Secret 或原始模型轨迹。

---

## 10. 最近运行错误采集

统一采集最近 24 小时；无法按时间过滤的文件日志，取最新 300 行并标注文件修改时间。24 小时无错误时再扩展到 7 天。禁止为了制造日志而重启或重新执行任务。

### 10.1 Mac mini/Release 部署日志

```bash
stat -f '%Sm %N' -t '%Y-%m-%dT%H:%M:%S%z' <DEPLOY_ROOT>/logs/*.log 2>/dev/null || true
tail -n 300 <DEPLOY_ROOT>/logs/server.stderr.log 2>/dev/null || true
tail -n 300 <DEPLOY_ROOT>/logs/server.stdout.log 2>/dev/null || true
tail -n 300 <DEPLOY_ROOT>/logs/release-watcher.stderr.log 2>/dev/null || true
tail -n 300 <DEPLOY_ROOT>/logs/release-watcher.stdout.log 2>/dev/null || true
```

### 10.2 systemd 日志

替换实际服务名：

```bash
journalctl -u <SERVICE_NAME> --since '24 hours ago' --no-pager -n 500
```

### 10.3 Docker 日志

```bash
docker compose --env-file <DEPLOY_ROOT>/runtime.env \
  -f <DEPLOY_ROOT>/current/deploy/compose.yaml \
  -f <DEPLOY_ROOT>/generated/compose.endpoints.yaml \
  logs --since 24h --tail 500 postgres web
```

如果后端也在容器内，加入它的实际 service 名。只读查看容器状态和退出码：

```bash
docker ps -a --filter label=com.docker.compose.project=dsh-work \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

### 10.4 Windows 日志

如果应用由 Windows Service 管理，先确认服务名，再读取对应时间窗；不要导出整个事件日志：

```powershell
$since = (Get-Date).AddHours(-24)
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$since} -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -match 'dsh|node|docker' -or $_.Message -match 'dsh-work|deepseek-harness' } |
  Select-Object -First 300 TimeCreated,LevelDisplayName,ProviderName,Id,Message
```

如通过文件日志运行，则报告文件绝对路径、修改时间并读取最后 300 行。

### 10.5 错误归类

对每条有代表性的错误填写：

| 时间（含时区） | 层级 | 操作/入口 | HTTP/错误码 | traceId | runId | attemptId | 脱敏错误摘要 | 是否重复 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `[填写]` | 配置/启动/前端/Nginx/API/认证/数据库/迁移/DSH/模型/工具/文件/权限 | `[填写]` | `[填写]` | `[填写]` | `[填写]` | `[填写]` | `[填写]` | `[填写]` |

不要只搜索字符串 `error`。同时关注：

```text
fatal, failed, failure, exception, rejected, denied, forbidden, unauthorized,
timeout, cancelled, ECONNREFUSED, ENOENT, EACCES, EPERM, 401, 403, 404,
409, 422, 429, 500, 502, 503, migration, checksum, runtime lock, ACP,
worker exited, model, tool, artifact, origin, issuer, audience, certificate
```

区分“根因错误”和后续连锁错误。例如 Nginx 502 可能只是后端启动失败的结果；Run failed 可能只是 DSH Lock 不一致的投影。

---

## 11. 最小复现与本地模拟建议

从已有日志、页面报错和数据库失败记录中选择最近且最稳定的一次问题，回答：

1. 用户角色与入口：员工端、管理端、自动任务或系统启动；
2. 操作前置条件：Agent/Skill/Tool 版本、工作空间、文件类型、权限、认证方式；
3. 最少操作步骤；
4. 预期结果；
5. 实际结果；
6. 首次异常时间和最近异常时间；
7. 是否每次发生；若非必现，估计频率；
8. 对应的 HTTP 状态、错误码、traceId、runId、attemptId；
9. 是否只在冷启动、升级后、长时间运行、并发、特定文件或特定用户下发生；
10. 目标机智能体判断的前三个可能原因，每个原因必须附证据和反证。

将环境项分为三类：

- **本地必须精确匹配：** 代码 Commit、Node 主版本、数据库迁移、DSH version/commit、相关 Agent/Skill/Tool 精确版本；
- **本地可等价模拟：** 操作系统路径、端口、Host/Origin、文件权限、时区、代理故障、数据库/Runtime 不可用；
- **只能目标机验收：** 真实 OIDC、多账号收权、生产证书、真实企业 Connector、真实模型凭据、宿主机 Docker/launchd 恢复行为。

若判断错误与真实数据有关，只描述数据形状、大小、字符集、MIME、行数和权限特征，不复制业务数据。建议构造最小合成数据复现。

---

## 12. 目标机智能体最终回答模板

请复制以下结构并填写。所有结论都要注明证据来源；未检查项写“未检查”，不要猜测。

```markdown
# 目标机诊断回答

## A. 执行摘要

- 采集时间（UTC/本地）：
- 诊断账号与服务账号是否相同：
- 操作系统/架构：
- 实际部署方式：
- 部署根目录：
- 活动 Release/Commit：
- 当前整体状态：健康 / 部分降级 / 不可用
- 最近错误一句话摘要：
- 最可能造成本地与目标机差异的三项：

## B. 版本矩阵

| 项目 | 实际值 | 来源 | 状态 |
| --- | --- | --- | --- |
| dsh-work Release |  |  |  |
| dsh-work Commit |  |  |  |
| Node（服务进程） |  |  |  |
| Node（交互终端） |  |  |  |
| pnpm |  |  |  |
| Docker/Compose |  |  |  |
| PostgreSQL |  |  |  |
| 最新迁移 |  |  |  |
| DSH Lock version/commit |  |  |  |
| DSH 实际 version/commit |  |  |  |

## C. 主机与资源

- CPU/内存：
- 时区/Locale/编码：
- 文件系统大小写与权限特点：
- 磁盘可用量：
- 容器资源限制：
- 代理/企业 CA/网络限制：

## D. 服务与健康

- 进程管理器及服务状态：
- 服务进程 Node 路径：
- 4174/4180/4190/5434 监听情况：
- Docker services 状态：
- /health/live：
- /health/ready：
- /health：
- 回环与 HTTPS 是否一致：

## E. 安全配置摘要

### 可公开配置

（填写第 7.1 节的实际值或 MISSING）

### 敏感配置状态

（只填写第 7.2 节各键的 SET/EMPTY/MISSING）

### 配置异常

- 旧 prototype 配置：
- 生产 compatibility 配置：
- 重复变量：
- 路径与权限：
- OIDC/Origin/回调一致性：
- 服务环境与交互 Shell 差异：

## F. DSH 执行链

- Release Lock、环境期望值、实际 checkout 是否一致：
- checkout 是否干净：
- ACP/构建产物/依赖：
- DSH_HOME/Session 目录权限：
- 模型凭据提供器状态（不得输出值）：
- 最近执行错误阶段：

## G. 数据库与迁移

- PostgreSQL 版本：
- Release 最新迁移：
- 数据库最新迁移：
- 缺失/超前/checksum 异常：
- 最近失败 Attempt 表（最多 20 条，禁止 Manifest/Prompt）：

## H. 最近错误时间线

| 时间（含时区） | 层级 | 操作 | 错误码 | traceId/runId/attemptId | 脱敏摘要 | 根因或连锁 |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

## I. 最小复现

- 入口与角色：
- 前置条件：
- 步骤：
- 预期结果：
- 实际结果：
- 必现频率：
- 关联标识：
- 最近一次发生时间：

## J. 原因排序

1. 原因：
   - 支持证据：
   - 反证/不确定点：
2. 原因：
   - 支持证据：
   - 反证/不确定点：
3. 原因：
   - 支持证据：
   - 反证/不确定点：

## K. 本地模拟清单

### 必须精确匹配

- 

### 可以等价模拟

- 

### 无法本地替代，需目标机复验

- 

## L. 未完成检查

| 检查项 | 未完成原因 | 需要的人或权限 |
| --- | --- | --- |
|  |  |  |

## M. 脱敏声明

- 是否确认未包含密码、Token、Cookie、私钥、完整数据库 URL、模型凭据和业务正文：是/否
- 额外脱敏说明：
```

---

# 目标机诊断回答（本次实际填写，2026-10-17）

> 由目标机上的只读诊断代理填写。全程仅执行读取、`ps`-替代枚举（受沙箱限制，见 L）、`curl` 健康接口、`docker compose ps/logs/exec` 只读命令与 `SELECT` 查询；**未**重启/停止任何服务或容器，**未**运行迁移、发布、安装或修复命令，**未**修改 `runtime.env`、证书、权限或 Release。未输出任何密码、Token、Cookie、私钥、完整数据库 URL、模型凭据或业务正文。

## A. 执行摘要

- 采集时间（UTC/本地）：`2026-10-17T01:51Z / 2026-10-17T09:51+0800（Asia/Shanghai）`
- 诊断账号与服务账号是否相同：`相同`——同为 `uid=502(deploy)`；launchd LaunchAgent 位于 `gui/502`，`runtime.env` 属主 `deploy:staff` mode 600，`/opt/homebrew` 与 DSH checkout 均由 deploy 可读。
- 操作系统/架构：`macOS 26.6.2 (Build 25G83)`，`Darwin gdskhwdeMac-mini.local 25.6.0 … RELEASE_ARM64_T8132`，`arm64`，Apple M4（10 核，24 GiB）
- 实际部署方式：`macOS launchd LaunchAgent 常驻后端（GitHub Release 解包 + active-release/current 软链） + Docker Compose 运行 Nginx 反代与 PostgreSQL`；后端为宿主机 Node 直接运行，不在容器内。
- 部署根目录：`/Users/deploy/services/dsh-work`（`DSH_WORK_DEPLOY_ROOT`）
- 活动 Release/Commit：`v2026.10.16-01 / af0faca9a86ab8fdecb937286c69199572232e3a`
- 当前整体状态：`健康（运行时）；存在间歇性反代 504 与若干管理端流程性报错`
- 最近错误一句话摘要：`最近 24 小时内 Nginx 容器 6 次无法在 60s 内连上宿主网关 host.docker.internal(192.168.65.254):4190，返回 504（4 次打健康检查、2 次打管理 API）；最近一次真实功能错误是 2026-10-17 06:41:43+0800 的 /health/live 504。`
- 最可能造成本地与目标机差异的三项：
  1. **版本错位**：本地 `dsh-work-src` 在 `667b00e`，目标机运行的是 Release `af0faca`（自动部署已关闭、release-watcher 未加载），相差 1 个提交。
  2. **网络拓扑差异**：目标机前端走“容器内 Nginx → `host.docker.internal` → 宿主机 Node:4190”，Docker Desktop 的 host-gateway 路径会间歇性连接超时（本地常见为直连 4190，不存在这一跳）。
  3. **外部 MCP 依赖差异**：每次 Attempt 会以 `failOnStartupError: true` 拉起 `192.168.1.95:8848`、`192.168.1.95:8765`、`https://skill.globalsino.com.cn/mcp` 三个 MCP 客户端；目标机历史上出现过 `duplicate loader entry id: mcp-skillhive` 的 ACP profile 装载失败，以及 MCP 发现超时/认证失败，直接决定 Run 成败与工具可用性。

## B. 版本矩阵

| 项目 | 实际值 | 来源 | 状态 |
| --- | --- | --- | --- |
| dsh-work Release | `2026.10.16-01`（`server/package.json` 亦为 releaseVersion=2026.10.16-01、version=0.1.1） | `active-release`、`current/release.json`、`current/server/package.json` | 活动 |
| dsh-work Commit | `af0faca9a86ab8fdecb937286c69199572232e3a` | `current/release.json` | 与 Release 对应 |
| Node（服务进程） | `v26.8.1`，`/opt/homebrew/Cellar/node/26.8.1/bin/node` | `lsof -p 77334` 的 `txt` 条目；`DSH_WORK_NODE_BIN=/opt/homebrew/bin/node`（同一二进制） | 与交互终端一致 |
| Node（交互终端） | `v26.8.1`（`/opt/homebrew/bin/node`） | `node --version` | 一致 |
| pnpm | `11.24.0`（`/opt/homebrew/bin/pnpm`） | `pnpm --version` | — |
| Docker/Compose | `client=29.7.2 server=29.7.2`；Compose `v5.5.1`（Docker Desktop，VM 10 CPU / 8.32 GB） | `docker version`、`docker info` | 运行中 |
| PostgreSQL | `PostgreSQL 17.11 on aarch64-unknown-linux-musl`（镜像 postgres:17.11-alpine） | 容器内 `select version()` | healthy |
| 最新迁移 | `0081_knowledge_chunks.sql`（Release 共 82 个 `.sql`；DB `schema_migrations` 共 82 行，applied_at=2026-10-16 02:58:21.951626+00） | `current/server/migrations/`、`schema_migrations` | 一致，无缺失/超前 |
| DSH Lock version/commit | `0.1.2-rc.1 / 76fda729799fe9b3848dbe2c211d4b231032b81e`（protocolVersion=1、adapter=official-acp-profile，另含 `legacy-0.1.1-rc.2`/`legacy-acp-demo` 的 development 兼容段） | `current/server/config/dsh/runtime-lock.json` | 与运行环境期望值一致 |
| DSH 实际 version/commit | `0.1.2-rc.1 / 76fda729799fe9b3848dbe2c211d4b231032b81e`（分支 master，工作区干净） | `git -C /Users/deploy/services/deepseek-harness rev-parse HEAD`、`package.json` | 三者完全一致 |

## C. 主机与资源

- CPU/内存：`Apple M4，10 核（hw.ncpu=10），物理内存 25,769,803,776 B ≈ 24 GiB`；Docker VM 上限 10 CPU / 8,319,504,384 B ≈ 7.75 GiB。
- 时区/Locale/编码：`CST +0800（Asia/Shanghai）`；`LANG=LC_*=zh_CN.UTF-8`，`LC_ALL` 为空；文件编码按 UTF-8。
- 文件系统大小写与权限特点：`APFS（/ 为 sealed/read-only 系统卷，Data 卷可写）`；`diskutil info -plist /` 未出现 `CaseSensitive` 键，按 APFS 默认判定为**大小写不敏感**（只读约束下未做写测试，标为推断）；服务目录 mode 多为 700/600，属主 `deploy:staff`。
- 磁盘可用量：`/ 可用 254 GiB（5% 已用）`，Data 卷 185 GiB 已用/254 GiB 可用（43%）；SMB 网络卷 `/Volumes/品质保管部`、`/Volumes/MDGROUP3 N` 挂载中。未低于 5 GiB 阈值。
- 容器资源限制：`docker inspect` 显示两个 dsh-work 容器 `Memory=0、NanoCpus=0`（无限制），`RestartPolicy=unless-stopped`；`vm.swapusage total=0.00M`，`memory_pressure` 报 free 69%（无内存/Swap 压力）。`ulimit -n=1048575`，`umask 0022`（服务脚本内部另设 `umask 077`）。
- 代理/企业 CA/网络限制：环境变量中**无** `*_proxy`；`scutil --proxy` 未配置 HTTP/HTTPS 代理（仅有 ExceptionsList `*.local`、`169.254/16`），未做代理连通性测试（无代理可测）。企业根证书为 `<DEPLOY_ROOT>/certs/root-ca.crt`（自建 `AI Hub Intranet Root CA`，有效期至 2036-08-31），通过 `NODE_EXTRA_CA_CERTS` 注入 Node，并被 `curl --cacert` 验证可用。出站依赖：内网 `192.168.1.95:8848/8765`、`192.168.1.99:8443`（OIDC issuer，实测 `.well-known` 返回 200）、公网域名 `skill.globalsino.com.cn`。

## D. 服务与健康

- 进程管理器及服务状态：`launchd LaunchAgent com.company.dsh-work.server` → `state = running`、`pid = 77334`、`path = /Users/deploy/Library/LaunchAgents/com.company.dsh-work.server.plist`、`program = <DEPLOY_ROOT>/current/scripts/deploy/run-server.sh`、日志重定向到 `<DEPLOY_ROOT>/logs/server.{stdout,stderr}.log`。`com.company.dsh-work.release-watcher` 未加载（Could not find service）。
- 服务进程 Node 路径：`/opt/homebrew/Cellar/node/26.8.1/bin/node`（由 `lsof -p 77334` 的 txt 段取得）；进程 cwd = `<DEPLOY_ROOT>/releases/v2026.10.16-01`。`server.stdout.log` 全为 `dsh-work server listening on http://127.0.0.1:4190`（29 行，最后写入 2026-10-16 10:58）。
- 4174/4180/4190/5434 监听情况：`node 77334 → 127.0.0.1:4190`；`com.docke 57198 → 192.168.1.99:4174 与 192.168.1.99:4180`（nginx 容器端口映射 8443/8444）；`com.docke 57198 → 127.0.0.1:5434`（postgres）。另有其它无关服务：`node:3080`（本诊断 GUI）、`node:3097`。
- Docker services 状态：`dsh-work-web-1 Up 23 hours (healthy)`、`dsh-work-postgres-1 Up 2 weeks (healthy)`；`docker compose ps` 显示 `postgres` 5 weeks ago 创建、`web` 23 hours ago。宿主机上另有 `ai-hub-production-*`、`WeKnora-*` 项目容器（与 dsh-work 无关）。
- `/health/live`：`HTTP 200 {"status":"ok","service":"dsh-work","version":"0.1.1"}`
- `/health/ready`：`HTTP 200 {"status":"ready","core":true,"executionCapabilities":{"dsh":{"status":"available"},"python":{"status":"not-configured"}}}`
- `/health`：`HTTP 200 status=ok, dshRuntime=healthy, database=ok, adapter=postgres, timestamp=2026-10-17T01:52:00.768Z`
- 回环与 HTTPS 是否一致：**一致**。`http://127.0.0.1:4190`、`https://192.168.1.99:4174`（工作台）、`https://192.168.1.99:4180`（管理端）用 `certs/root-ca.crt` 校验均返回 200；明文 `http://192.168.1.99:4174` 返回 400（nginx 明确拒绝明文）。**但容器内 Nginx 到宿主机的那一跳不稳定**：最近 23 小时内 6 次 `upstream timed out (110) while connecting to upstream → http://192.168.65.254:4190/...`，全部返回 504（详见 H）。

## E. 安全配置摘要

### 可公开配置（来源：`<DEPLOY_ROOT>/runtime.env`，mode 600，属主 deploy；第 7.1 节列表）

| 键 | 实际值 |
| --- | --- |
| NODE_ENV | `production` |
| DSH_WORK_DEPLOY_ROOT | `/Users/deploy/services/dsh-work` |
| DSH_WORK_NODE_BIN | `/opt/homebrew/bin/node` |
| DSH_WORK_AUTO_DEPLOY_ENABLED | `false` |
| DSH_WORK_RELEASE_POLL_INTERVAL_SECONDS | `300` |
| DSH_WORK_SERVER_HOST | `127.0.0.1` |
| DSH_WORK_SERVER_PORT | `4190` |
| DSH_WORK_BIND_ADDRESSES / DSH_WORK_BIND_ADDRESS | `192.168.1.99` / `192.168.1.99` |
| DSH_WORK_WORKBENCH_PORT / DSH_WORK_ADMIN_PORT / DSH_WORK_POSTGRES_PORT | `4174` / `4180` / `5434` |
| DSH_WORK_POSTGRES_DB / DSH_WORK_POSTGRES_USER | `dsh_work` / `dsh_work` |
| DSH_WORK_DATA_ROOT | `/Users/deploy/services/dsh-work/data` |
| DSH_WORK_DSH_SESSIONS_ROOT | `/Users/deploy/services/dsh-work/data/dsh-sessions` |
| DSH_RUNTIME_HOME | `/Users/deploy/services/deepseek-harness` |
| DSH_EXPECTED_VERSION / DSH_EXPECTED_COMMIT | `0.1.2-rc.1` / `76fda729799fe9b3848dbe2c211d4b231032b81e` |
| DSH_RUNTIME_COMPATIBILITY | `MISSING`（未设置，符合生产要求） |
| DSH_HOME | `/Users/deploy/.dsh` |
| DSH_WORK_PUBLIC_HOST | `192.168.1.99` |
| DSH_WORK_TLS_CERT_FILE / DSH_WORK_CA_CERT_FILE / NODE_EXTRA_CA_CERTS | `/Users/deploy/services/dsh-work/certs/server.crt` / `…/certs/root-ca.crt` / `…/certs/root-ca.crt` |
| DSH_WORK_COOKIE_SECURE | `true` |
| DSH_WORK_SESSION_TTL_SECONDS | `28800` |
| DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS | `900` |
| AI_HUB_PLATFORM_URL | `https://192.168.1.99` |
| AI_HUB_APPLICATION_ID / AI_HUB_ENVIRONMENT | `dsh-work` / `production` |
| AI_HUB_OIDC_ISSUER | `https://192.168.1.99:8443/application/o/ai-hub-dsh-work-production-v1/` |
| AI_HUB_OIDC_AUDIENCE | `dsh-work__production__v1` |
| AI_HUB_WORKBENCH_PORTAL_URL / REDIRECT_URI | `https://192.168.1.99:4174` / `https://192.168.1.99:4174/auth/workbench/callback` |
| AI_HUB_ADMIN_PORTAL_URL / REDIRECT_URI | `https://192.168.1.99:4180` / `https://192.168.1.99:4180/auth/admin/callback` |
| DSH_WORK_WORKBENCH_ORIGINS / ADMIN_ORIGINS | `https://192.168.1.99:4174` / `https://192.168.1.99:4180` |
| DSH_WORK_WORKBENCH_DEFAULT_ORIGIN / ADMIN_DEFAULT_ORIGIN | `https://192.168.1.99:4174` / `https://192.168.1.99:4180` |
| DSH_WORK_ADMIN_BOOTSTRAP_ENABLED | `MISSING` |
| 列表外但仍属非敏感项：DSH_WORK_AUTH_MODE | `oidc` |
| 列表外：DSH_WORK_ACP_PROVIDER / DSH_WORK_ACP_MODEL | `globalsino-deepseek` / `deepseek-flash` |
| 列表外：DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS | `connector-dsh-workspace,connector-mes-gateway,connector-plm,connector-skillhive` |
| 列表外：DSH_WORK_GITHUB_REPOSITORY | `globalsinocode/dsh-work` |
| 列表外：DSH_WORK_OFF_HOST_BACKUP_DIRECTORY | `/Volumes/dsh-work-backups`（**该路径当前不存在**，见“配置异常”） |
| 列表外：PATH | `/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin` |

### 敏感配置状态（只报状态，未输出值）

| 键 | 状态 |
| --- | --- |
| DSH_WORK_POSTGRES_PASSWORD | `SET` |
| DSH_WORK_DATABASE_URL | `SET` |
| DSH_CREDENTIAL_MASTER_KEY | `SET` |
| DSH_CREDENTIAL_MASTER_KEY_ID | `SET` |
| DSH_WORK_TLS_KEY_FILE | `SET`（`certs/server.key` mode 600） |
| DSH_WORK_SESSION_SECRET | `SET` |
| AI_HUB_CLIENT_ID | `SET` |
| AI_HUB_CLIENT_SECRET | `SET` |

### 配置异常

- 旧 prototype 配置：**无残留**。`DSH_WORK_AUTH_MODE=oidc`，不存在 `=prototype`。
- 生产 compatibility 配置：**未设置**（`DSH_RUNTIME_COMPATIBILITY` = MISSING），符合要求；兼容段只存在于 Release 的 `runtime-lock.json` 内（`legacy-0.1.1-rc.2`，scope=development）。
- 重复变量：**无**（逐行解析后无同名键重复）。
- 路径与权限：`DSH_WORK_DEPLOY_ROOT`、`DSH_WORK_DATA_ROOT`、`DSH_WORK_DSH_SESSIONS_ROOT`、`DSH_RUNTIME_HOME`、`DSH_HOME`、两个证书文件、`DSH_WORK_NODE_BIN` 全部存在且为绝对路径，服务账号（deploy）可读，数据/会话/证书目录可写；**唯一缺失项：`DSH_WORK_OFF_HOST_BACKUP_DIRECTORY=/Volumes/dsh-work-backups` 不存在**（离机备份卷未挂载 → 备份/恢复路径在目标机不可用，与本次运行错误无关，但本地模拟时不可假设存在）。
- OIDC/Origin/回调一致性：**一致**。`DSH_WORK_COOKIE_SECURE=true`，issuer/audience/redirect URI/前端 Origin 全部指向 `https://192.168.1.99`（4174 工作台、4180 管理端、8443 Authentik）；issuer 的 `/.well-known/openid-configuration` 实测 200。日志中确有 `unknown_request_origin`(421)、`csrf_check_failed`(403) 少量事件，属“非白名单入口/来源头不匹配”的正常拦截，不能据此判定配置错误。
- 服务环境与交互 Shell 差异：plist **没有** `EnvironmentVariables` 段，服务进程环境全部来自 `run-server.sh` 的 `source runtime.env`；因此服务侧 `PATH` 只包含 runtime.env 里那条（含 `/opt/homebrew/bin`，能解析 `DSH_WORK_NODE_BIN`），而交互 Shell 额外有 brew/pnpm/用户级路径与 `LANG=zh_CN.UTF-8`。两者 Node 版本相同（v26.8.1），但**不要假设交互 Shell 能跑通就等于 launchd 环境能跑通**。
- 数据库 URL 一致性：`DSH_WORK_DATABASE_URL` 解析出的 host/port/dbname 与 Compose 当前配置（`127.0.0.1:5434/dsh_work`）**一致**（仅比较一致性，未输出 URL）。

## F. DSH 执行链

- Release Lock、环境期望值、实际 checkout 是否一致：**完全一致**——Lock `0.1.2-rc.1/76fda72…`、`DSH_EXPECTED_VERSION/COMMIT` 同为 `0.1.2-rc.1/76fda72…`、实际 `/Users/deploy/services/deepseek-harness` `HEAD=76fda72…`、`package.json version=0.1.2-rc.1`。
- checkout 是否干净：`git status --short --untracked-files=no` 无输出 → 干净（分支 master）。
- ACP/构建产物/依赖：`apps/cli/src/bin.ts` 存在、`apps/cli/lib/bin.js` 存在、`packages/bundle/acp-app/cordis.patch.yml` 存在、`node_modules/tsx` 存在；产品侧 `current/server/config/dsh/` 含 `acp-managed-credentials.cordis.yml`、`acp-managed-credentials.legacy.cordis.yml`、`dsh-work-tool-policy.js`、`runtime-lock.json`。ACP 补丁把 session 持久化 root 指向 `DSH_SNAPSHOT_SESSIONS_ROOT ?? DSH_WORK_DSH_SESSIONS_ROOT ?? dshHomePath('sessions')`，provider/model 强制取 `DSH_WORK_ACP_PROVIDER/MODEL`（缺失会在启动期失败）。
- DSH_HOME/Session 目录权限：`DSH_HOME=/Users/deploy/.dsh`（drwx------ deploy，服务账号即 deploy）；`data/dsh-sessions` 存在、属 deploy 且**为空**——实际会话 JSONL 写在每次 Attempt 的 `data/dsh-attempts/<tenant>/<run>/<attempt>/sessions/<workspace>/<uuid>/session.jsonl`（最近一次成功 Run 的文件 244 KB，2026-10-17 09:00 本地）。`data/dsh-attempts` 下累计 2326 个 run 目录。
- 模型凭据提供器状态（不得输出值）：**可解析（间接证据）**——最近 24h 有 13 次 Run 成功、`/health` 的 `dsh=available`、MCP 调用审计最新一条 `2026-10-17T01:01:00Z result=success`；未读取 `DSH_HOME` 目录内容，未检查凭据正文。
- 最近执行错误阶段：`(1) 基础设施层：容器内 Nginx → 宿主机 4190 的连接建立阶段（60s connect timeout，504）；(2) 成果收集/审计阶段：Attempt 结束时的 finalizeMcpAudit（MCP 会话日志缺失 → 「mcp invocation audit failed」告警，不改变 Run 终态）；(3) 派发/授权阶段：2026-10-14 的 223 次 Attempt 在启动后约 4.5s 内以 RUNTIME_EXECUTION_FAILED 终止`。未见 ACP 握手成功的会话中出现模型调用超时；未见「取消/超时」以外的取消类错误（58 次 cancelled 均为人工/系统取消）。

## G. 数据库与迁移

- PostgreSQL 版本：`17.11 on aarch64-unknown-linux-musl`（容器 `dsh-work-postgres-1`，127.0.0.1:5434→5432，healthy，RestartCount=0，启动于 2026-09-29T07:06:52Z）。
- Release 最新迁移：`0081_knowledge_chunks.sql`（`current/server/migrations/` 共 82 个 `.sql`，0062…0081 连续）。
- 数据库最新迁移：`0081_knowledge_chunks.sql`，`applied_at=2026-10-16 02:58:21.951626+00`，`checksum=ce9084e3dc35b2627387fde6b248583a280c1ca807ef69ad6c49be79d300fc4a`；`schema_migrations` 共 82 行。
- 缺失/超前/checksum 异常：**无缺失、无超前**（文件数与行数均为 82，最新条目同名）；仅核对了最近 15 条的 checksum 字段存在性，未逐条比对全部 checksum（见 L）。日志中未出现 migration/checksum/锁等待/权限类报错。
- 最近失败 Attempt 表（禁止 Manifest/Prompt；7 天内共 `succeeded 1752 / failed 223 / cancelled 58`）：

| attempt_id | run_id | status | error_code | created_at (UTC) | ended_at (UTC) |
| --- | --- | --- | --- | --- | --- |
| attempt-40248ae7-1155-4e0a-a519-404883f4b7e0 | run-5f13de3a-20c0-4f79-9265-553a3ce98f61 | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:43:00.475955+00 | 2026-10-14 06:43:05.183+00 |
| attempt-b2f9c33b-1b88-4c3e-acf8-b6098190f64a | run-5c53ddeb-d9a3-4943-ac80-cc6a4c9a457b | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:42:55.891228+00 | 2026-10-14 06:42:55→06:43:00 |
| attempt-b6859fd4-0e79-4bd9-81bf-6b5219691869 | run-3ffa1f7e-83ee-44e9-95fd-a4a9f15037a7 | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:42:51.078877+00 | 2026-10-14 06:42:55.741+00 |
| attempt-60ad49fc-48b7-401a-885d-bb2a785433a2 | run-e918007c-b27d-40a3-b3f4-0c06d8acb4b1 | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:42:45.610048+00 | 2026-10-14 06:42:50.903+00 |
| attempt-ba72dd30-ee93-4211-9f17-30c075c76c6c | run-c0c4d757-f3b3-4b38-a01b-efb2e5d28c2f | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:42:45.610043+00 | 2026-10-14 06:42:50.901+00 |
| attempt-5dcd61fe-3f49-42c2-b976-6872c278ff26 | run-272e17e0-d95f-460c-a4b6-e2fca70c092b | failed | RUNTIME_EXECUTION_FAILED | 2026-10-14 06:42:45.433399+00 | 2026-10-14 06:42:50.808+00 |
| attempt-7cbb9ffc-b90c-4c95-94f6-b6092d834f0e | run-8ba9f416-f437-40fd-aacb-6c0490382348 | cancelled | （空） | 2026-10-15 00:55:04.567649+00 | 2026-10-15 00:57:34.625+00 |
| attempt-80bc0ff1-6295-45d1-9562-ad74e8c889a9 | run-2a571b0a-1f2d-4849-939f-19f756ec6670 | cancelled | （空） | 2026-10-15 00:46:26.900142+00 | 2026-10-15 00:48:57.103+00 |

（失败集中在 `2026-10-14 06:35–06:43Z`，223 次、约 33 次/分钟；`traceId` 形如 `trace-run-<runId>-trial`，即发布试运行（case trial）派发。最近 24 小时内**没有**失败 Attempt。）

代表性失败 Attempt 的安全事件投影（3 条，无 Manifest/Prompt/模型正文）：

| event_type | display_message | trace_id | occurred_at |
| --- | --- | --- | --- |
| run.queued | 任务已进入 Runtime 队列 | trace-run-5f13de3a-…-trial | 2026-10-14 06:43:00.507+00 |
| run.started | DSH Worker 已启动 | trace-run-5f13de3a-…-trial | 2026-10-14 06:43:04.853+00 |
| run.failed | 任务执行失败 | trace-run-5f13de3a-…-trial | 2026-10-14 06:43:05.154+00 |

## H. 最近错误时间线

| 时间（本地 +0800 / UTC） | 层级 | 操作/入口 | HTTP/错误码 | traceId/runId/attemptId | 脱敏摘要 | 根因或连锁 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-16 14:00:22 / 06:00:22Z | Nginx→后端 | 管理端 `GET /api/admin/v1/agents/agency-paid-media-search-query-analyst/release`（host 192.168.1.99:4180，client 192.168.65.1） | 504（upstream connect timeout） | 无 traceId（nginx 未记录） | `upstream timed out while connecting to upstream http://192.168.65.254:4190/...` | 根因：容器→宿主机 host-gateway 连接超时 |
| 2026-10-16 14:58:05 / 06:58:05Z | Nginx→后端 | 管理端 `GET /api/admin/v1/agent-release-records` | 504 | 无 | 同上（referrer `/overview`） | 同上 |
| 2026-10-16 16:27:32 / 08:27:32Z | Nginx→后端 | 容器健康检查 `GET /health/live`（client 127.0.0.1） | 504 | 无 | 同上 | 同上（连锁：容器健康检查短暂失败） |
| 2026-10-16 20:57:27 / 12:57:27Z | Nginx→后端 | 容器健康检查 `GET /health/live` | 504 | 无 | 同上 | 同上 |
| 2026-10-17 01:58:20 / 17:58:20Z | Nginx→后端 | 容器健康检查 `GET /health/live` | 504 | 无 | 同上 | 同上 |
| 2026-10-17 06:41:43 / 22:41:43Z | Nginx→后端 | 容器健康检查 `GET /health/live` | 504 | 无 | 同上 | **最近一次功能错误** |
| 2026-10-14 14:35–14:43 / 06:35–06:43Z | 应用/Runtime 派发 | 发布试运行 case trial（约 223 次） | Run `RUNTIME_EXECUTION_FAILED` | 例：`run-5f13de3a-…` / `attempt-40248ae7-…`，trace `…-trial` | 任务执行失败（启动约 4.5s 后终止） | 根因未在安全投影中给出；与 MCP 会话日志缺失同期 |
| 同上时间段的日志侧 | 应用/成果收集 | Attempt 结束 `finalizeMcpAudit` | 告警（不改终态） | 无 traceId（console.warn） | `mcp invocation audit failed DSH MCP 会话日志不可用，不能确认调用审计完整` ×222（其中 216 条连续成块，与 223 次失败 Attempt 同期同量级） | 连锁：失败 Attempt 未产出 MCP 会话证据，审计无法定稿 |
| 2026-10-16（无逐行时间戳，见 L） | 应用/配置 | 管理端「测试连接」`POST /api/admin/v1/connectors/mcp/test` | 503 `MCP_CREDENTIAL_STORE_UNAVAILABLE`（18 次）/ `MCP_CONNECTION_TEST_FAILED`（8 次：`MCP 发现超时`、`Internal error`）/ 422 `MCP_AUTHENTICATION_FAILED` | 有 traceId（如 `trace-http-aa38d3f4-…`），无 runId | `MCP 加密凭据存储不可用：请配置 DSH_CREDENTIAL_MASTER_KEY 并重启服务`；`MCP 发现失败：… profile-boot.ts:264:15)` | 早期根因（Credential Master Key 未注入进程）；当前 `DSH_CREDENTIAL_MASTER_KEY=SET`，最近一次 MCP 测试为发现超时 |
| 2026-10-16（无逐行时间戳） | 应用/发布治理 | 管理端 `PATCH /api/admin/v1/agents/draft` | 404 `resource_not_found` ×24 | 有 traceId（如 `trace-http-9723117d-…`） | `工具不存在、未发布、不可用或不符合受控运行策略：complaint_health@1.0.0` | 根因：该包内工具从未在平台注册/发布（`tools` 表无 `complaint_health`；连接器「零件投诉闭环」只同步出 `dsh-mcp__mcp_19a75595__*`） |
| 2026-10-16（无逐行时间戳） | 应用/发布治理 | 管理端 `POST /api/admin/v1/agents/:id/release/case-trials` | 409 `state_conflict` ×5 / 500 `operation_failed` | 有 traceId（如 `trace-http-5c19b97f-…`） | `试运行被阻塞：执行器与 Runtime 兼容` / `试运行被阻塞：AI 员工执行授权` | 按 `postgres-agent-release-service.js` 的检查逻辑，`runtime` 检查在「包内 Tool/Skill 候选未准入」或「授权兼容性校验失败」时置 failed；属流程性阻塞（需先完成工具准入） |
| 2026-10-16（无逐行时间戳） | 应用/工作台 | `POST /api/workbench/v1/sessions/:id/runs`、`/runs/:id/retry` | 403 `permission_denied` ×46 | 有 traceId | `Agent 发布时固定的工具绑定已失效，请重新检查并发布新版本` | 连锁：上游工具不可用/重新发布后旧绑定失效（`skillhive-search@1.0.0` 曾 403 ×10，现已 available） |
| 2026-10-16（无逐行时间戳） | 应用/入口 | `POST /api/admin/v1/agent-packages/inspect` | 421 `unknown_request_origin` ×2、401 `session_expired` | 有 traceId | `请求入口不在允许列表中` | 正常来源校验；说明存在非白名单 Origin 访问尝试 |
| 2026-10-09 09:47 / 01:47:47Z | 应用/MCP | 连接器 `skillhive` 健康检查（`connector_health_checks`） | offline | — | `MCP 发现失败：ACP process exited unexpectedly (code=1)；failed to apply loader entry include (cordis:include): duplicate loader entry id: mcp-skillhive`（栈顶 `apps/cli/src/profile-boot.ts:264:15`） | 根因：ACP profile 装载时 MCP 条目 id 冲突导致进程退出；同日 05:54 后 `零件投诉闭环` 连接器发现成功，skillhive 于 2026-10-09 15:01 本地恢复 healthy |
| 2026-10-16（无逐行时间戳） | 应用/管理端 | `POST /api/admin/v1/agents`、`PATCH …/agents/draft` | 500 `operation_failed` | 有 traceId | `duplicate key value violates unique constraint "agents_pkey"`；`Cannot read properties of undefined (reading 'trim')` | 待本地复现判定的真实缺陷（两个 500 各 1 次） |
| 2026-10-16（无逐行时间戳） | 应用/上传 | `POST /api/admin/v1/agent-packages/inspect`、`…/sessions/:id/files` | 422 `agent_package_invalid` / `skill_package_invalid` / `invalid_request` | 有 traceId | 旧扁平 `agent.yaml` 清单、ZIP 分卷不支持、Office 文件非 ZIP 容器 | 输入/格式问题（用户上传内容），非服务缺陷 |
| 全周期（噪声） | API/认证 | `GET /api/*/v1/session` 等 | 401 `authentication_required` ×137、`session_expired` ×26 | 有 traceId | `请先登录` / `登录会话不存在或已过期` | 正常会话过期轮询，**非**故障 |

> 说明：`logs/server.stderr.log` 为跨 Release 追加写入（文件头仍是 2026-09-24 之前 `releases/v2026.09.23-01` 的 `ECONNREFUSED 127.0.0.1:5434` + `TypeError: Cannot read properties of null (reading 'write')` 崩溃段，共 50 条 ECONNREFUSED，属数据库短暂不可用引发的旧事故，**不是当前状态**）。该文件除崩溃段外**不含时间戳**，因此上表中“无逐行时间戳”的条目只能依赖行序、DB 事件与容器日志交叉定位；精确时刻需改造日志格式（见 L）。

## I. 最小复现

- 入口与角色：`系统基础设施 / 管理端（唯一可稳定复现的一项）`——从内网任一台机器访问 `https://192.168.1.99:4180` 或容器自身的 `wget https://127.0.0.1:8443/health/live`。
- 前置条件：`Docker Desktop 运行中；dsh-work Compose 项目已起（web+postgres）；宿主机 dsh-work 后端监听 127.0.0.1:4190；web 容器通过 extra_hosts host.docker.internal:host-gateway 访问宿主；nginx upstream 使用 Docker DNS `127.0.0.11` + `resolve` + `ipv6=off`，未设置 proxy_connect_timeout（默认 60s）`。
- 步骤：
  1. `docker compose --env-file runtime.env -f current/deploy/compose.yaml -f generated/compose.endpoints.yaml ps` 确认 web/postgres healthy；
  2. 在宿主机 `curl --cacert certs/root-ca.crt https://192.168.1.99:4180/health/live`（预期 200）；
  3. 持续（每 5 分钟一次、≥24h）压测同一路径与 `GET /api/admin/v1/agent-release-records`；或人为让宿主网关短暂不可达（等价模拟：容器内到宿主的连接抖动/latency）。
- 预期结果：全部 200，`/health` 的 `database=ok、dshRuntime=healthy`。
- 实际结果：平均 4~5 小时出现一次 504，`error.log` 记录 `upstream timed out (110: Operation timed out) while connecting to upstream, upstream: "http://192.168.65.254:4190/..."`；23 小时内 6 次（4 次健康检查 + 2 次管理 API）。
- 必现频率：**非必现**，约 0.25 次/小时（23h/6 次），间隔 0.5–5h 不规则。
- 关联标识：nginx 未记录 traceId/runId/attemptId（容器日志只有 client IP 与请求行），无法与后端 `trace-http-*` 关联。
- 最近一次发生时间：`2026-10-17T06:41:43+0800（2026-10-16T22:41:43Z）`。
- 是否只在特定条件下：`仅在“容器内 Nginx 反代宿主机后端”这一跳出现`；宿主机直连 4190 与 HTTPS 4174/4180 均 200；与冷启动/升级无相关性（web 容器 23h 内未重启，postgres 2 周未重启，RestartCount 均为 0）。

## J. 原因排序

1. 原因：**Docker Desktop host-gateway 路径（`host.docker.internal` → 192.168.65.254）间歇不可达/建连超时，Nginx 在 60s connect timeout 后返回 504。**
   - 支持证据：6 条 nginx `[error] upstream timed out … while connecting to upstream` 全部指向 `http://192.168.65.254:4190/...`，且同一时刻宿主机 `curl http://127.0.0.1:4190/health/live` 正常；`current/deploy/nginx/default.conf.template` 顶部注释已记录同源问题（host.docker.internal 同时返回 A/AAAA，容器内 IPv6 不可达，曾导致 502），现有方案用 `resolver 127.0.0.11 + resolve + ipv6=off` 规避 IPv6，但**没有**规避“A 记录建连超时”；nginx 未配置 `proxy_connect_timeout`（默认 60s），因此一次抖动即计为 504。
   - 反证/不确定点：未在超时发生瞬间抓到 `docker exec` 内的 `getent hosts host.docker.internal` / `nc -z 192.168.65.254 4190` 证据（只读约束下无法回放历史）；未确认本次是否又走了 AAAA——若 `ipv6=off` 生效则不应有 AAAA 参与轮询。此外容器 `RestartCount=0`，排除容器自身崩溃。
2. 原因：**版本/制品错位：目标机运行 Release `af0faca`，而本地源码 checkout 在 `667b00e`（领先 1 个提交，且自动部署关闭）。**
   - 支持证据：`active-release=v2026.10.16-01`、`release.json.commit=af0faca`、`current` 软链指向该 Release；`dsh-work-src` HEAD=`667b00e`、`git log` 显示 `af0faca` 是它的父提交；`DSH_WORK_AUTO_DEPLOY_ENABLED=false`，`com.company.dsh-work.release-watcher` 未加载。
   - 反证/不确定点：`667b00e` 的提交主题是前端表单回车修复，与本次 504/MCP 类错误无直接因果关系，因此它解释的是“行为差异”，而非本次具体报错；另外未能用 `git` 校验 Release 内容（deploy 根不是 Git 仓库，仅有 `.git.init-backup-20261016` 备份目录）。
3. 原因：**外部 MCP/企业系统依赖在目标机的启动期行为与本地不同（`failOnStartupError: true`），一旦 MCP 客户端装载失败或发现超时，Attempt 直接失败并使 MCP 审计无法定稿。**
   - 支持证据：每次 Attempt 生成 `mcp.cordis.patch.yml`，注入 `mcp-mcp_95693264`(http://192.168.1.95:8848/mcp)、`mcp-mold_96e3eb30`(http://192.168.1.95:8765/mcp)、`mcp-skillhive`(https://skill.globalsino.com.cn/mcp)，均带 `failOnStartupError: true`、`reconnect.enabled: false`；`connector_health_checks` 记录了 `duplicate loader entry id: mcp-skillhive` 导致的 ACP 进程退出（2026-10-09）；`tools` 表中全部 `dsh-mcp__skillhive__*` 为 `disabled/unavailable`；日志中 MCP 审计告警 222 次与 223 次失败 Attempt 同量级同期。
   - 反证/不确定点：`skillhive-search` 等 MCP 派生工具当前为 `available/approved`（2026-10-09 07:01 起），且最近 24h 13 次 Run 成功、最新一条 MCP 审计 `result=success`——说明 MCP 路径现在**基本可用**，`duplicate loader entry id` 只出现在 2026-10-09 的历史健康检查中，本次采集未能抓到当前的 MCP 启动失败现场。

## K. 本地模拟清单

### 必须精确匹配

- 代码：`af0faca9a86ab8fdecb937286c69199572232e3a`（复现目标机现状）或 `667b00e`（复现“本地已修但要验证”的场景）；`releaseVersion=2026.10.16-01`。
- Node：`v26.8.1`（服务进程与交互终端一致）；pnpm `11.24.0`。
- 数据库：`postgres:17.11-alpine`（或同主版本 17.11），迁移链应用到 `0081_knowledge_chunks.sql`；`DSH_WORK_POSTGRES_DB/USER=dsh_work`、端口 5434。
- DSH Runtime：`0.1.2-rc.1 @ 76fda729799fe9b3848dbe2c211d4b231032b81e`，含 `packages/bundle/acp-app/cordis.patch.yml`、`node_modules/tsx`、`apps/cli/{src/bin.ts,lib/bin.js}`；`server/config/dsh/` 的 `acp-managed-credentials.cordis.yml` + `dsh-work-tool-policy.js` + `runtime-lock.json` 三件套必须与 Release 内一致。
- 非敏感环境变量：`NODE_ENV=production`、`DSH_WORK_SERVER_HOST=127.0.0.1`、`DSH_WORK_SERVER_PORT=4190`、`DSH_WORK_BIND_ADDRESS(ES)`、`4174/4180/5434`、`DSH_WORK_COOKIE_SECURE=true`、Origin/回调/issuer/audience 全套（见 E）。
- 相关 Agent/Skill/Tool 精确版本：`skillhive-search@1.0.0` 等 `skillhive-*` 版本链，`dsh-mcp__skillhive__*@1.0.0`。

### 可以等价模拟

- 操作系统路径与端口布局（4174/4180/4190/5434）、`<DEPLOY_ROOT>/…` 目录结构、`runtime.env` 的键集合与权限（600）。
- 拓扑：容器内 Nginx → `host.docker.internal:<4190>` → 宿主 Node，含 `resolver 127.0.0.11 + resolve + ipv6=off` 与**默认 60s `proxy_connect_timeout`**；用 `tc`/网络抖动或临时 iptables DROP 模拟 host-gateway 超时即可复现 504。
- 故障注入：PostgreSQL 不可用（可复现历史 `ECONNREFUSED 127.0.0.1:5434` 连锁与 `TypeError: Cannot read properties of null (reading 'write')` 崩溃）、MCP 端点不可达/返回 401（可复现 `MCP_CONNECTION_TEST_FAILED`/`MCP_AUTHENTICATION_FAILED` 与 MCP 审计告警）。
- 证书：用自建 CA 签发含 `IP:192.168.1.99` SAN 的证书（`certs/server.crt` 有效期 2026-09-08→2027-09-08），配合 `NODE_EXTRA_CA_CERTS`。
- 时区/Locale（`Asia/Shanghai`、`zh_CN.UTF-8`）、文件权限、`umask 077`、`ulimit`、磁盘/内存状态。
- 业务数据：仅以合成数据复现形状（例如工具返回的字符集/MIME/大小），不复制真实文件与模型输入输出。

### 无法本地替代，需目标机复验

- 真实 Authentik/OIDC 单点登录、多账号与权限收权（`https://192.168.1.99:8443/application/o/ai-hub-dsh-work-production-v1/`）。
- 生产证书与宿主 `launchd` 的 `KeepAlive{SuccessfulExit=false}` 重启行为、`ThrottleInterval=10`。
- 真实 MCP/企业系统：`192.168.1.95:8848`、`192.168.1.95:8765`、`https://skill.globalsino.com.cn/mcp`、`三品PLM`、`赛肯技能脱敏网关`。
- DSH_HOME 中的真实模型凭据与 provider（`globalsino-deepseek/deepseek-flash`）。
- Docker Desktop 的 host-gateway 抖动本身（可用等价故障注入近似，但真实频率只能目标机长期观测）。
- 离机备份卷 `/Volumes/dsh-work-backups`（当前不存在）。

## L. 未完成检查

| 检查项 | 未完成原因 | 需要的人或权限 |
| --- | --- | --- |
| `ps -axo pid,ppid,user,lstart,command`（进程表） | 沙箱拒绝：`/bin/ps: Operation not permitted` | 允许进程枚举的诊断会话/权限 |
| `launchctl list` 全量输出 | 该命令返回 0 行（沙箱限制），改用 `launchctl print gui/502/<label>` 与 plist 读取替代 | 同上 |
| `docker compose config` | 问卷明令禁止（会展开完整配置与秘密） | — |
| `schema_migrations` 全量 checksum 比对 | 只查了最近 15 条（`limit 15`）与其字段存在性 | — |
| `logs/server.stderr.log` 逐行时间戳 | 该日志不含时间戳（仅崩溃段异常栈与 JSON 事件） | 需要产品日志格式改造（加 ISO 时间戳）后才能精确定时 |
| 504/502 发生瞬间的容器内网络证据（`getent hosts`/`nc -z` 192.168.65.254:4190） | 只读约束，无法回放历史时刻；不可为验证而重启容器 | 目标机值守人员，在故障窗口内执行只读探测 |
| MCP 会话 JSONL 正文与 `DSH_HOME` 内容 | 问卷明令禁止（只报“提供器可解析/不可解析”） | — |
| `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY` 可用性 | `/Volumes/dsh-work-backups` 不存在 | 负责挂载离机备份卷的运维 |
| `421 unknown_request_origin` 的具体来源 Origin | 后端日志只发 traceId，不带 Origin 头；nginx 访问日志也未记录 | 需要在 nginx/后端补充脱敏的 Origin 审计字段 |
| ACP Session 日志中 MCP 启动失败现场（当前是否仍会 `duplicate loader entry id`） | `data/dsh-sessions` 为空，实际会话在按 Attempt 的 `sessions/` 下；未逐会话解析 JSONL（避免带出模型内容） | 允许只读解析 JSONL 事件类型（不读正文）的授权 |
| `/health` 的 `python: not-configured` 是否影响目标功能 | 未评估（问卷未要求触发任务） | — |

## M. 脱敏声明

- 是否确认未包含密码、Token、Cookie、私钥、完整数据库 URL、模型凭据和业务正文：**是**。所有敏感键仅报 `SET/EMPTY/MISSING`；未粘贴 `runtime.env` 值、未输出连接串、未读取 `DSH_HOME` 与 ACP Session JSONL 正文、未复制任何业务文件内容或模型输入输出。
- 额外脱敏说明：
  - 保留内网地址 `192.168.1.99`、`192.168.1.95`、`192.168.65.254/192.168.65.1`（Docker Desktop 宿主网关）与域名 `skill.globalsino.com.cn`——这是“搭等价环境”所必需，且本次交付仅在组织内部开发机之间流转；若该文件需要离开内网，请统一替换为 `<INTERNAL_HOST>`，但**必须同时保留端口/协议/路径结构**，否则 504 与 MCP 两处复现条件会失真。
  - `mcp.cordis.patch.yml` 中的 `Authorization` 仅以环境变量名（`DSH_MCP_VALUE_*`）形式出现，未出现任何 Token 值。
  - 员工姓名、业务正文、模型输出、Agent 包内的业务文件内容一律未摘录；`attempt_id/run_id/traceId` 属系统标识，予以保留以便本地关联。
  - 未执行任何写操作、重启、迁移、发布、安装或修复命令。

---

## 13. 返回本地后的使用方式

本地开发者拿到回答后，先做差异矩阵，不直接复制目标机的 `runtime.env`：

1. 以目标机活动 Release/Commit 建立本地复现基线；
2. 使用独立、可丢弃 PostgreSQL，应用相同迁移链；
3. 匹配 Node 与 DSH 精确版本，生产秘密使用测试替身；
4. 只复刻与错误相关的非敏感环境变量、路径、权限、时区和网络故障；
5. 使用合成用户、合成业务数据和受控 Runtime 重现；
6. 本地复现成功后再提出修复；本地 P0/P1 通过不能替代目标机 P2 复验；
7. 不把目标机数据库、DSH Session 原文、OIDC Token 或生产凭据复制到开发机。

本问卷的目标是获得足够证据构造等价故障条件，不是制作目标机的完整镜像。

---

## 14. 第二轮只读取证：Agent 创建/保存的两个 500

> 本节由本地开发端于 2026-10-17 追加。目标机智能体请直接在本节各项下方填写回答。
>
> 仅做只读检查：**不要**在目标机重放 `POST /api/admin/v1/agents` 或
> `PATCH /api/admin/v1/agents/draft`，不要修改日志配置、数据库、Release、Nginx 或浏览器缓存。
> 不得粘贴 Cookie、Token、Authorization、请求正文、模型输入输出、数据库连接串或个人信息。

### 14.1 已由本地代码确认的事实（无需重复检查）

- 目标 Release `v2026.10.16-01` 对应提交 `af0faca9a86ab8fdecb937286c69199572232e3a`；目标源码
  `main` 为 `667b00ea12db2db599f0966c7866c32238583018`。
- `667b00e` 相比 Release 只给 Agent 编辑器等表单增加了 `@submit.prevent`；它没有修改后端 Agent 创建、
  草稿更新、请求校验或错误分类。
- 创建接口直接使用客户端生成的 Agent ID 插入 `agents`，没有把 PostgreSQL `23505/agents_pkey`
  转成明确的冲突响应，因此相同 ID 的第二次请求会成为 500。
- 草稿更新接口只校验 `expectedRevision`，其余 JSON 字段没有运行时结构校验；服务层在校验之前直接对
  `welcomeMessage/name/description/visibility/systemPrompt/changeSummary` 调用 `.trim()`，数组元素的规范化也会
  调用 `.trim()`，因此缺字段或错误类型会成为 500。
- 当前版本前端正常路径会发送完整对象；管理助手生成的 Agent 更新计划也会补齐完整字段。尚未确认出错请求来自
  当前前端、旧缓存前端、重复操作、人工/API 调用还是其他调用方。

### 14.2 请关联两个失败请求的安全日志记录

请在 `logs/server.stderr.log` 中找到这两条 `event=http.request.failed` 记录，仅返回下列安全字段：

| 失败 | traceId | method | path（注册路由模板） | status | code | message | responseStarted | 日志行号或前后顺序 |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| `agents_pkey` | `trace-http-1a956689-1fbd-447d-9df8-7aeccf7f91b3` | `POST` | `/api/admin/v1/agents` | 500 | `operation_failed` | `duplicate key value violates unique constraint "agents_pkey"` | `false` | 第 **858** 行（文件共 940 行）；紧随第 859 行是另一路由 `POST /api/admin/v1/agents/:agentId/release/trials` 的 500（`试运行被阻塞：AI 员工执行授权`） |
| `undefined.trim` | `trace-http-692bdd2a-3c4c-40cc-b123-6f7c7ab9928c` | `PATCH` | `/api/admin/v1/agents/draft` | 500 | `operation_failed` | `Cannot read properties of undefined (reading 'trim')` | `false` | 第 **572** 行；前一行（571）为第 6 条 `mcp invocation audit failed`，后一行（573）为 `POST /api/admin/v1/connectors/mcp/test` 的 503 |

> 原文两条记录均只有 `event/traceId/method/path/status/code/message/responseStarted` 七个字段；**不含时间戳、客户端 IP、User-Agent、Referer、请求正文**（已全文检索 `"ip"`/`forwardedFor`/`clientIp`/`userAgent`，0 命中）。因此本节的时间只能靠“行序 + 其它带时间的事实”夹逼。

**1. 两条记录之间是否夹有同一路由的成功或失败记录？**

按“注册路由模板 + 方法”统计整份日志（940 行）：

| 路由 | 本文件中全部记录 | 在 572 与 858 之间 |
| --- | --- | --- |
| `POST /api/admin/v1/agents` | 仅 1 条（第 858 行，这次 500）；另有第 629 行是同路径的 **GET** 401 | 0 条 |
| `PATCH /api/admin/v1/agents/draft` | 26 条：第 572 行（500）+ 第 888–901、915–919、921–925 行（全部 404 `工具不存在、未发布、不可用或不符合受控运行策略：complaint_health@1.0.0`） | **0 条**（最近的一条同路由记录要到第 888 行） |

两条 500 **之间没有任何同路由的其它请求**；也没有任何 `POST /api/admin/v1/agents` 的第二次尝试被记录。也就是说：**日志层面看不到“同一路由连续两次提交”的直接证据**。

**2. 是否同一次进程启动、同一 Release 区段？**

**无法判断**（日志无时间戳），但可以给出有依据的夹逼区间：

- 两条记录所在的 `logs/server.stderr.log` 是 **跨多次启动的追加文件**：文件内没有启动标记，而同一个 `logs/server.stdout.log` 里累计了 **29 条** `dsh-work server listening on http://127.0.0.1:4190`，说明 stderr 的 940 行横跨多次 launchd 启动与多个 Release；两行相距 286 行，**不能假定属于同一次启动**。
- `agents_pkey`（第 858 行）的区间：
  - 下界：第 637–852 行是连续 216 条 `mcp invocation audit failed`，对应 2026-10-14 那批失败 Attempt（末次 `run.failed` = **2026-10-14 06:43:05Z**），故第 858 行晚于该时刻；
  - 上界：第 912 行是 `POST …/release/case-trials` 的 409，而 Nginx access log 中该 409 只出现在 **10-16 03:08:09Z / 05:42:46Z / 05:59:31Z / 05:59:40Z** 四个时刻，按行序 912→920→926→927 一一对应，故第 858 行早于 **2026-10-16 03:08:09Z**；
  - 即 `agents_pkey` ∈ **(2026-10-14 06:43:05Z, 2026-10-16 03:08:09Z]**。该区间跨过了 Web 容器重建时刻 **10-16 02:58:45Z**（见 14.3），所以它可能落在旧 Release（`v2026.10.09-03`）末期，也可能落在新 Release（`v2026.10.16-01`）启动后的前 9 分钟内。
- `undefined.trim`（第 572 行）的区间：
  - 下界：第 566–571 行是 6 条同样的审计告警，而全文件 222 条告警与 **223 次失败 Attempt** 同量级，失败只发生在 10-10（5 次，末次 10-10 06:46:59Z）和 10-14（218 次），故第 572 行晚于 **2026-10-10 06:46:59Z**；
  - 上界：第 637 行起的 216 条告警块对应 10-14 06:36Z 那批，故第 572 行早于 **2026-10-14 06:36Z**；
  - 即 `undefined.trim` ∈ **(2026-10-10 06:46:59Z, 2026-10-14 06:36:32Z]**。按 `automation/state/installed-releases.md` 的安装时间（10-10 09:13 本地装 `v2026.10.09-03`），该区间内运行的应仍是 **`v2026.10.09-03`**。
- 结论：两条记录**几乎可以肯定不在同一个 Release 区段**：trim 在 `v2026.10.09-03` 期间，pkey 在 `v2026.10.09-03` 末期或 `v2026.10.16-01` 初期。二者不能当成同一次会话的连锁反应。

**3. 相邻的未分类异常记录或进程崩溃？**

| 位置 | 类型 | 首行消息（原文，非堆栈） | 说明 |
| --- | --- | --- | --- |
| 566–571（trim 前 1–6 行） | `console.warn`（非 JSON） | `mcp invocation audit failed DSH MCP 会话日志不可用，不能确认调用审计完整` ×6 | 不改变 Run 终态，与 trim 无因果关系 |
| 573（trim 后 1 行） | JSON 事件 | `POST /api/admin/v1/connectors/mcp/test` → 503 `MCP_CONNECTION_TEST_FAILED`：`MCP 发现失败：MCP 发现超时` | 同一时间窗内的 MCP 连通性抖动 |
| 845–852（pkey 前 6–13 行） | `console.warn` | 同上审计告警 ×8 | 属于 216 条连续告警块的尾部 |
| 859（pkey 后 1 行） | JSON 事件 | `POST /api/admin/v1/agents/:agentId/release/trials` → **500** `试运行被阻塞：AI 员工执行授权` | 同一路由族的**状态码不一致**：`release/case-trials` 同样的阻塞返回 **409**，`release/trials` 却抛成 **500**，属独立缺陷 |
| 378（较远，早 194 行） | 未捕获异常（有堆栈） | `TypeError: Cannot read properties of null (reading 'write')`（`postgres/src/connection.js`，2026-09-24 旧 `v2026.09.23-01` 的 ECONNREFUSED 5434 段） | 与这两条 500 相隔 194/480 行，**不是同一事件**；此后日志中再未出现进程级崩溃栈 |

两条 500 附近**没有**进程崩溃或未捕获异常栈；最近的“异常类”记录都是审计告警（warning），不中断服务。

### 14.3 请用 Nginx access log 判断是否发生重复请求

在不输出 Cookie、查询参数和个人信息的前提下，查找上述错误附近的访问日志。若能关联，请填写：

| 失败 | 本地时间（含时区） | 客户端地址（可哈希/掩码） | method + path | status | response bytes | Referer 路径 | User-Agent 大类 |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| `agents_pkey` | **无法关联** | — | — | — | — | — | — |
| `undefined.trim` | **无法关联** | — | — | — | — | — | — |

**取证条件（先说清楚日志有什么、覆盖到哪）**

- Nginx 的 `access.log` 是 `/dev/stdout` 的软链，容器用**默认 `combined` 格式**（`$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"` + 结尾多一个空格字段），**时间、Referer、User-Agent 都有**；可直接 `docker logs dsh-work-web-1` 只读获取。
- 但日志随容器生命周期：Web 容器 `StartedAt = 2026-10-16T02:58:45Z`（`RestartCount=0`），因此 access log **只覆盖 2026-10-16 02:58:50Z → 2026-10-17 02:15:25Z（本地 10:58:50 → 次日 10:15:25）共 19,444 条**；此前（旧容器）的访问日志已随容器重建不可得。
- 该窗口的状态码分布：`200×19331、302×32、201×25、401×16、404×11、304×10、202×7、504×6、409×5、400×3、499×1、421×1`，**`500` 出现 0 次**。

**因此**：14.2 已把两条 500 夹逼到 `(2026-10-14 06:43Z, 10-16 03:08Z]` 与 `(10-10 06:47Z, 10-14 06:36Z]`，前者跨越 10-16 02:58:45Z 的容器重建、后者完全在重建之前。access log 里既然没有任何 500，就出现两种互斥可能，**现有证据无法区分**：

1. 请求发生在 10-16 02:58:50Z 之前 → 属于已被销毁的旧容器，**访问日志不可得**；
2. 请求发生在 02:58:50Z 之后 → 它**没有经过 Nginx**（否则必有 500 记录），最可能是宿主机直接对 `127.0.0.1:4190` 发起的调用（`curl`/脚本/隧道），而不是浏览器（浏览器走 `https://192.168.1.99:4180`，必过 Nginx）。

**1. `agents_pkey` 的 POST 前后 10 秒内是否有第二个 POST？**

不能回答（无时间戳可定位到 10 秒）。但可给出窗口内该路由的**全部**记录：`POST /api/admin/v1/agents`（精确创建路由）在 19,444 条访问日志中**只出现 1 次**——`2026-10-16T06:01:56Z`，**201**，5,073 字节级响应，Referer `https://192.168.1.99:4180/agents`，UA 为 macOS 上的 Chrome（`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Chrome/…`）。它与 `audit_events.action='agent.create'` 的 `2026-10-16 06:01:56.220793Z success` **秒级吻合**。**窗口内不存在第二次创建请求，尤其不存在连续两次 POST**，所以“浏览器双击/回车重复提交”在该窗口内没有证据。

**2. POST 前后是否有页面导航/重载迹象？**

该窗口内 `06:01:56Z` 前后只有一次成功的创建，随后是 `GET /agents` 列表类请求；**没有**在 10 秒内出现 `GET /overview`、`GET /` 或整页 `GET /assets/index-*.js` 的重载序列（重载会重新拉入口 chunk；该窗口内 `/assets/index-CHLov1cq.js` 的加载集中在 03:07、05:40、06:07、07:23、08:34 等页面首次打开时刻，与创建时刻不同）。

**3. PATCH 前后 10 秒内是否有同一路由的其他请求？**

不能回答。窗口内 `PATCH /api/admin/v1/agents/draft` 共 12 次：**404×10**（`05:40:56、05:41:08、05:41:09、05:41:10、05:41:10、05:52:04、05:53:50、05:54:57、05:55:04、05:55:26`，均为 `complaint_health@1.0.0` 不可用导致的 404）与 **200×2**（`05:59:16、05:59:37`）。没有 500，也没有 10 秒内的成对重复 PATCH。

**4. 字段缺失情况（逐项）**

| 字段 | 应用日志 `server.stderr.log` | Nginx access log |
| --- | --- | --- |
| 时间 | **不具备**（无任何时间戳，只有事件 JSON） | 具备（`$time_local`，UTC） |
| 客户端地址 | **不具备** | 具备（`192.168.65.1` 为宿主网关；`127.0.0.1` 为容器内健康检查） |
| traceId | 具备（`trace-http-…`） | **不具备** |
| Referer / User-Agent | **不具备** | 具备 |

→ **两份日志之间没有公共关联键**（无 traceId 透传、无 `X-Request-Id` 记录），只能靠时间对齐；而应用日志恰恰没有时间，所以本轮**无法把任意一条 500 与任意一条 access log 记录关联**。这不是推测，是字段层面的硬限制。

**顺带确认的其它事实**（同一窗口，可复核）：

- 6 条 504 全部是 `upstream timed out (110) while connecting to upstream http://192.168.65.254:4190/…`：`06:00:22Z`（`GET /api/admin/v1/agents/agency-paid-media-search-query-analyst/release`）、`06:58:05Z`（`GET /api/admin/v1/agent-release-records`）、`08:27:32Z`、`12:57:27Z`、`17:58:20Z`、`22:41:43Z`（后四条均为容器内 `GET /health/live`）。
- `POST …/release/case-trials` 的 4 次 **409** 出现在 `03:08:09Z、05:42:46Z、05:59:31Z、05:59:40Z`（本回答用它作为 14.2 的行序锚点）。
- 窗口内 `/assets/*` 请求 **297 次、无 404**（`304` 仅 10 次），即没有“旧 `index.html` 指向已删 chunk”的证据。

### 14.4 请确认出错浏览器加载的前端制品版本

**先回答第 4 问：两条 500 与静态资源之间的关联 = 无法关联**（原因见 14.3：应用日志无时间、无客户端标识；两条 500 的夹逼区间有一段落在旧容器，那段访问日志已随容器重建丢失）。下面给的是**窗口级**（10-16 02:58:50Z → 10-17 02:15:25Z）的静态产物事实，不冒充“出错那一刻”的证据。

**1. 窗口内加载的管理端入口资源**

| 资源 | 首次出现 | 末次出现 | 次数 | 状态 | 字节 |
| --- | --- | --- | ---: | --- | ---: |
| `/assets/index-CHLov1cq.js`（管理端入口） | 2026-10-16 03:07:04Z（11:07:04 +0800） | 2026-10-16 07:23:36Z | 9 | 200/304 | 1,083,224 |
| `/assets/index-DG-hiSag.css` | 2026-10-16 03:07:04Z | 2026-10-16 08:34:01Z | 11 | 200/304 | 386,723 |

**2. 是否存在于活动 Release `v2026.10.16-01` 的构建产物中**

**是，两者都存在**，且正是 `current/apps/admin-web/dist/index.html` 里引用的两个入口文件：

```
/assets/index-CHLov1cq.js
/assets/index-DG-hiSag.css
```

活动 Release 的整棵树已与 `release.json` 的 1380 条 `path/bytes/sha256` **逐文件校验一致（1380/1380，0 缺失、0 不符）**，所以这两个文件就是 GitHub 不可变 Release（`isImmutable=true`、`targetCommitish=af0faca…`）里的字节。

**3. 是否有 667b00e 构建产物或更旧缓存资源的证据**

| 判断 | 证据 | 结论 |
| --- | --- | --- |
| 浏览器是否加载过 **`667b00e`** 的构建产物 | `667b00e` 只存在于源码 checkout `/Users/deploy/services/dsh-work-src`（`main`），目标机**从未构建或安装过它**：`release-artifacts/` 下只有 `v2026.10.16-01` 一个当前构件，`releases/` 里没有对应版本，`active-release` 指向 `v2026.10.16-01` | **没有证据**，且从部署链路看不成立 |
| 是否加载过**更旧 Release 的缓存资源** | 窗口内 `/assets/*` 请求 297 次、**404 为 0**、仅有 10 次 `304`；Vite 产物文件名带内容哈希，旧入口引用的 chunk 若已不存在会立刻 404 | **没有证据** |
| 是否加载过**同一 Release 的另一份构建** | **有**：窗口内共出现 **107 个不同 `/assets/` 路径，其中 51 个在当前 Release 里已不存在**；`automation/local-deviations/2026-10-16-enter-submit-reload/patched-admin-web.sha256` 比 `original-admin-web.sha256` 多出 **33 个** chunk（56 → 89），且这些新增名字与访问日志缺失集合吻合。典型样本：`AboutView-DwyxQn89.js` 在窗口内**只被请求过 1 次，时间 `2026-10-16 08:34:01Z`（本地 16:34:01）**——与 `fix-enter-submit.patch` 的落盘时间（本地 10-16 16:34）同一分钟；`2026-10-17 08:19` 回滚用 `original-dist/` 覆盖后，该 chunk 已从磁盘删除（全目录 `find` 无此文件） | **是“同一 Release + 弹窗回车热修”的构建**：热修 10-16 16:34 本地生效，10-17 08:19 本地回滚。凡在这个时段打开的浏览器，加载的都是热修构建，而不是 Release 原始 dist；这与两条 500 的夹逼区间（均早于 10-16 03:08Z，即**早于热修生效**）不重叠，故不能把 500 归因于热修构建 |

**4. 结论**：无法把两个错误与具体静态资源关联；**没有任何证据**支持“`667b00e` 构建”或“旧 Release 缓存”这两种猜测。窗口内唯一被证实的“非 Release 原始产物”是 2026-10-16 16:34–2026-10-17 08:19 期间的弹窗回车热修构建，而它晚于两条 500 的发生区间。

### 14.5 请检查数据库中是否留下可关联状态（只读、聚合或脱敏）

窗口沿用 14.2 的夹逼结果：**trim 窗口 = (2026-10-10 06:46:59Z, 2026-10-14 06:36:32Z]**；**pkey 窗口 = (2026-10-14 06:43:05Z, 2026-10-16 03:08:09Z]**。ID 一律取 `sha256(id)` 前 12 位十六进制。

**1. 两个窗口内 `agents` / `agent_versions` 的新建**

| 窗口 | `agents` 新建数 | 最早 / 最晚 `created_at` | `agent_versions` 新建数 | 最早 / 最晚（版本） |
| --- | ---: | --- | ---: | --- |
| trim 窗口 | **334** | `2026-10-10 07:41:05.958513Z` / `2026-10-14 02:53:22.887888Z` | **336** | `2026-10-10 07:41:05.958513Z` / `2026-10-14 02:53:22.887888Z` |
| pkey 窗口 | **1** | `2026-10-15 00:27:49.726482Z`（`e045c6c004a4`，`status=draft`，`updated_at` 与 `created_at` **完全相同**） | **2** | `2026-10-15 00:27:49.726482Z` / `2026-10-15 05:39:36.454337Z` |

- trim 窗口的 334 个新建里，只有 1 个是**单点手工创建**（`2026-10-10 07:41:05.958513Z`，`b3efdb0257ce`，draft，`updated_at` 与 `created_at` 相同）；其余 333 个集中在 `2026-10-14 01:42:07` 与 `2026-10-14 02:53:0x–02:53:22` 两批，与同期的 `agent.release.import`（336 次）批量导入吻合，不是人工在编辑器里逐个新建。
- 全租户 `agents` 共 **340** 行，即 98% 的 Agent 是在上面那两批导入里产生的。

**2. 同期 `audit_events` 中 `agent.create` 成功记录**

全表 `action='agent.create' and result='success'` 共 **6** 条：

| 对象（哈希前 12 位） | actor | 时间 |
| --- | --- | --- |
| `587d11cf754f` | user | 2026-09-16 02:31:50.820757Z |
| `1f30384e34bc` | user | 2026-10-10 01:10:00.819840Z |
| `ac091b075582` | user | 2026-10-10 02:36:50.668308Z |
| `b3efdb0257ce` | user | 2026-10-10 07:41:05.962621Z |
| `e045c6c004a4` | user | 2026-10-15 00:27:49.731339Z |
| `937067dd9921` | user | 2026-10-16 06:01:56.220793Z |

- **trim 窗口内成功创建：1 条**（`b3efdb0257ce`，`10-10 07:41:05`）。
- **pkey 窗口内成功创建：1 条**（`e045c6c004a4`，`10-15 00:27:49`）。
- 关键补充：**`agent.draft.update` 成功记录全表只有 3 条，最早一条是 `2026-10-15 05:39:36Z`**。也就是说在 10-10 07:41 到 10-15 05:39 之间**没有任何一次草稿保存成功**——这与 trim 窗口内那次 PATCH 500 一致（失败的保存不落 `updated_at`）。

**3. 能否证明 `agents_pkey` 发生前相同 Agent ID 已成功创建？**

**证据不足**（只能证明“该 ID 在那一刻已经存在”，不能定位到创建记录）：

- 能证明的部分：`duplicate key value violates unique constraint "agents_pkey"` 本身就是“`agents.id` 主键已存在”的直接证据，说明调用方提交的 ID **必然**对应表中已有的某一行（表里现有 340 行）。
- 不能证明的部分：应用日志**不记录请求正文，也不记录 agentId**（`path` 是注册路由模板 `/api/admin/v1/agents`，不含 ID），因此无法把这次冲突落到具体某一行、某个创建时刻。
- 可缩小的范围：pkey 窗口**之前**的 2 天内，全租户只成功创建过 **1 个** Agent（`e045c6c004a4`，`2026-10-15 00:27:49Z`）。所以如果调用方复用的是一个“最近生成的 ID”，候选就是它；如果复用的是一个更早的 ID，候选是其余 339 行。**没有任何证据**显示在 500 之前数秒内有同一 ID 的成功创建（窗口内 `agent.create` 成功记录只有 1 条，且与 500 相隔约 2.5 小时以上）。

**4. `undefined.trim` 对应的 Agent 是否仍存在、是新建后编辑还是既有 Agent 编辑？**

判定：**无法判断**（置信度低）。可陈述的事实：

- trim 窗口内只有 1 个手工新建的草稿 `b3efdb0257ce`（`2026-10-10 07:41:05.958513Z`），它的 `updated_at` 与 `created_at` **完全一致**——即**从未成功保存过**，与“创建后立刻编辑、第一次保存就 500”的形态吻合；但它至今**仍存在**（`status=draft`）。
- 窗口内还有 333 个批量导入产生的 draft（`2026-10-14 01:42` / `02:53` 两批），它们同样是合法编辑对象；由于 PATCH 请求不带 ID，无法排除这次 PATCH 落在其中任意一个上。
- 因此只能给“无法判断”，不能写成“新建后编辑”。

### 14.6 目标机智能体结论

请分别给出两个问题的证据等级，不要把推测写成事实：

| 问题 | 已证实的触发条件 | 仍缺证据 | 最可能调用方 | 置信度（高/中/低） |
| --- | --- | --- | --- | --- |
| 重复主键 500 | ① 请求确实到达后端并被记为 `POST /api/admin/v1/agents` 500 `duplicate key value violates unique constraint "agents_pkey"`（第 858 行，traceId `1a956689…`）；② 说明创建路径直接把客户端生成的 ID 插入 `agents`，未把 PostgreSQL `23505` 映射为冲突响应；③ 发生区间 **(2026-10-14 06:43:05Z, 2026-10-16 03:08:09Z]**；④ Nginx 在 10-16 02:58:50Z–10-17 02:15:25Z 的 19,444 条访问记录中 **500 计数为 0**，同期该路由只成功过 1 次（06:01:56Z 201） | 请求正文与 `agentId`（应用日志不记录）；调用方身份、UA、Referer（请求未经 Nginx 或无访问日志）；精确发生时刻（日志无时间戳）；是否存在“同一 ID 连续两次提交”（无第二次请求记录） | **直连 `127.0.0.1:4190` 的 API/脚本调用（curl）**；次选：10-16 02:58:50Z 之前的旧容器时期的浏览器操作（那段访问日志已随容器重建丢失） | **中**（触发条件与代码路径=高；调用方=低） |
| `undefined.trim` 500 | ① 请求确实到达后端并被记为 `PATCH /api/admin/v1/agents/draft` 500 `Cannot read properties of undefined (reading 'trim')`（第 572 行，traceId `692bdd2a…`）；② 说明草稿更新只校验 `expectedRevision`，其余字段无运行时结构校验，而服务层在进入业务逻辑前对 `welcomeMessage/name/description/visibility/systemPrompt/changeSummary` 等直接 `.trim()`；③ 发生区间 **(2026-10-10 06:46:59Z, 2026-10-14 06:36:32Z]**；④ 同期 `agent.draft.update` 成功记录为 **0**（全表最早一条成功是 10-15 05:39:36Z） | 请求正文（无法知道是哪个字段为 `undefined`、是缺字段还是类型错）；`agentId`；调用方（该路由只有管理端会调用，但无法确认是哪个浏览器/会话） | **管理端浏览器**（`https://192.168.1.99:4180` 的 Agent 编辑器/发布流程）；该时段内既有 1 个手工新建草稿，也有 333 个批量导入草稿，无法再缩小 | **中**（触发条件=高；目标 Agent 与调用方=低） |

**补充观察（同一轮取证发现，供本地修复时一并处理，不影响上表结论）**：同一路由族的状态码不一致——`POST /api/admin/v1/agents/:agentId/release/case-trials` 在“试运行被阻塞：执行器与 Runtime 兼容”时返回 **409**（4 次，10-16 03:08:09Z / 05:42:46Z / 05:59:31Z / 05:59:40Z），而 `POST /api/admin/v1/agents/:agentId/release/trials` 在“试运行被阻塞：AI 员工执行授权”时返回 **500**（第 859 行）。同一类“业务前置条件不满足”，一个走了类型化错误（409），一个走了未捕获异常（500），属于错误分类不完整，属于本地可直接复现、也值得顺手修的一类问题。

**最后确认**：本轮**完全只读**。全部操作为 `grep/sed/awk/wc/stat/du/find`、`docker logs`、`docker exec … cat /etc/hosts|nslookup|wget`、`psql -c "select …"`、`launchctl print`、`gh release view`、`shasum`；未调用任何创建/保存/试运行接口，未重启或停止任何服务、容器、数据库，未修改日志/数据库/Release/Nginx/浏览器缓存，未清缓存、未重新构建。回答中**不含**凭据、Cookie、Token、Authorization、请求正文、数据库连接串、个人信息、模型输入输出或业务正文；Agent/对象 ID 一律用 SHA-256 前 12 位。

---

## 15. 同一轮追加取证（超出 14 节要求，但直接影响“本地正常、目标机报错”的复现）

> 以下均为本轮只读采集的补充证据，用于补上第一轮回答里“未完成检查”表和原因排序上的缺口。采集命令与 14 节相同：只读、无重启、无写入。

### 15.1 构件 provenance（补 L 节的缺口，结论：可以证明）

| 检查 | 结果 |
| --- | --- |
| `current/release.json.files` 逐文件重算 | **1380 / 1380 全部一致**，0 缺失、0 sha256 不符 |
| 安装包 | `release-artifacts/v2026.10.16-01/dsh-work-v2026.10.16-01.tar.gz`，3,909,900 B，`sha256=69ba57becd0312fc96967b72342be08ccd1de0ed418326b4524f388ff1cf794b` |
| `gh release view v2026.10.16-01`（只读） | `isImmutable=true`、`targetCommitish=af0faca9a86ab8fdecb937286c69199572232e3a`、`createdAt=2026-10-16T02:42:21Z` |
| 结论 | 运行构件 = GitHub 不可变 Release 的同一份字节，**当前无任何就地修改**；`targetCommitish` = `release.json.commit` = `active-release`，三者一致 |

→ 本地不必再怀疑“目标机跑的是被手改过的产物”。差异只可能来自**版本基线、环境变量、DSH checkout、外部依赖与网络拓扑**。

### 15.2 主因取证：模型供应商凭据/额度（解释 223 次失败 Attempt 与 222 条 MCP 告警）

取自 `run_events.safe_metadata->>'reason'`（该类字段是产品已脱敏的审计字段）：

| reason（截断） | error_code | 次数 | 首次 | 末次 |
| --- | --- | ---: | --- | --- |
| `…turn failed: 401 {…"Invalid token (request id: …)"…}` | RUNTIME_EXECUTION_FAILED | **201** | 2026-10-14 06:36:32Z | 2026-10-14 06:43:05Z |
| `…turn failed: 403 {…"token quota is not enough, token remain quota: ＄0.001258, need quota: ＄0.001760"…}` | RUNTIME_EXECUTION_FAILED | 2 | 2026-10-14 06:36:08Z | 2026-10-14 06:36:28Z |
| `…turn failed: malformed prompt variable reference "{{ … }}"` | RUNTIME_EXECUTION_FAILED | 5 / 5 / 5 | 10-10 06:46 / 10-14 04:10 / 10-14 04:37 | — |
| `…turn failed: DeepSeek request extension preparation failed` | RUNTIME_EXECUTION_FAILED | 28 | 2026-09-15 09:25:51Z | 2026-09-15 09:27:15Z |
| `Runtime execution timed out` | RUN_TIMEOUT | 23 | 2026-09-15 07:40:46Z | 2026-09-22 00:57:57Z |
| `…Authentication Fails, Your api key: ****5e37 is invalid` | RUNTIME_EXECUTION_FAILED | 7 | 2026-09-29 03:55:44Z | 2026-09-29 10:17:54Z |

- 时间形态：401 集中在 `06:36–06:43Z`，每分钟 14/33/28/33/30/33/28/2 次；`elapsed_ms` 4417–5933（均值 5351）——**单个 turn 起手即被供应商拒绝**，不是超时、不是工具、不是 MCP。
- 时序：**先 403 额度不足（06:36:08–06:36:28），随后 401 Invalid token（06:36:32 起）**，典型的供应商侧账号/密钥被限流或轮换；恢复时未重启服务，说明问题在 `DSH_HOME` 侧凭据而非进程环境。
- 密钥接线（只查存在性）：`~/.dsh/settings.yaml` 的 provider `globalsino-deepseek` 定义完整（`api=anthropic-messages`、`baseURL=https://aikey.globalsino.com.cn`、`models=[deepseek-flash]`、`apiKeyEnv=GLOBALSINO_DEEPSEEK_API_KEY`），但该变量**不在** `runtime.env`（55 键中无）、**不在** launchd 继承环境（仅 `SSH_AUTH_SOCK`）、**不在**诊断 shell。→ 密钥完全由 DSH 的 settings/credentials provider 从 `DSH_HOME` 解析（未读取正文）。**本地只复制 `runtime.env` 是拿不到模型凭据的。**

### 15.3 MCP 审计告警的真实机制（修正第一轮把它当独立故障的判断）

`current/server/dist/modules/runtime/dsh-acp-runtime-adapter.js`：

- `waitForSessionEvidence()` 只轮询 **10 次 × 50 ms ≈ 0.5 秒**；`readSessionEvidence()` **只有在会话里存在 `assistant/message.usage` 或至少一次 `tool/call` 时才返回对象**，否则返回 `undefined` → `finalizeMcpAudit()` 抛「DSH MCP 会话日志不可用，不能确认调用审计完整」→ 外层只 `console.warn`，**不改变 Run 终态**。
- 数据侧：`data/dsh-attempts` 下 **2335 个 attempt 目录、2335 个 `session.jsonl`（586 MB），覆盖率 100%**。所以告警不是“日志没写”，而是“这一次 Attempt 根本没有可审计的 usage/tool 证据”。
- 数量关系：告警 **222 条 ≈ 失败 Attempt 223 次**，且分两段（第 566–571 行 6 条、第 637–852 行 **216 条连续**），后者正对应 10-14 的 401 爆发。
- **结论：该告警是 15.2 事故的下游投影**，本地不要再当 MCP 通道问题复现。

### 15.4 本地/目标机基线差异（本轮最重要的一条）

`docs/release/dsh-runtime-delivery.md` 原文记录的“本地现有 checkout”配置：

```bash
DSH_RUNTIME_HOME=/Users/max/projects/deepseek-harness
DSH_RUNTIME_COMPATIBILITY=legacy-0.1.1-rc.2
DSH_EXPECTED_VERSION=0.1.1-rc.2
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

而目标机是 `0.1.2-rc.1 @ 76fda72…`、**`DSH_RUNTIME_COMPATIBILITY` 必须未设置**、并使用正式 `acp-app` profile（`legacy-*` 只用于本地旧版）。生产预检会**明确拒绝** compatibility 模式。

→ 本地若不切到 `0.1.2-rc.1 @ 76fda72`，测的是 `legacy-acp-demo` 适配器：会话 JSONL 结构、MCP 客户端装载、工具目录同步、审计等待逻辑都可能不同，**很多目标机现象在本地根本走不到**。

同时注意两处已知站点偏差（不是源码差异，但会制造“目标机独有”的故障）：

1. `~/.dsh/settings.yaml` 曾丢失 `agent-default-model` / `llm-pi-ai.providers` 两段 → ACP 子进程 `-32603, no adapter registered for provider "globalsino-deepseek"`；该文件由 GUI 托管，**存在再次被改写的风险**，升级后必须复核。
2. `~/.dsh/profiles/acp/cordis.patch.yml` 曾静态挂载 `mcp-skillhive`，与产品注入的 `mcp-${server_name}` 撞 id → `duplicate loader entry id: mcp-skillhive` → ACP 进程退出。已注销（现存备份 `…bak-retire-mcp-skillhive-20261009T054954Z`）；当前文件中 `mcp-skillhive` 出现 0 次。

### 15.5 容器网络与 504（补 D 节）

| 探测 | 结果 |
| --- | --- |
| 容器 `/etc/hosts` | `192.168.65.254` **与** `fdc4:f303:9324::254` 双栈映射 `host.docker.internal` |
| `nslookup host.docker.internal 127.0.0.11` | 只返回 A 记录 `192.168.65.254`（nginx `ipv6=off` 生效） |
| 容器 → `http://host.docker.internal:4190/health/live` | **200**（采集时刻这一跳正常） |
| 容器 → `https://127.0.0.1:8443/health/live`（无 Host 头） | **421 Misdirected Request** → 这就是 healthcheck 必须带 `Host: 192.168.1.99` 的原因 |
| 容器路由 | `default via 172.19.0.1`，host-gateway `192.168.65.254` **不在容器子网**（Docker Desktop 宿主代理路径） |
| nginx 超时 | 未设置 `proxy_connect_timeout`（默认 60s）、`proxy_read/send_timeout=3600s` → “连不上宿主”要等满 60s 才记 504 |
| 23h 内 504 | 共 **6** 条：06:00:22Z、06:58:05Z（管理 API）+ 08:27:32Z、12:57:27Z、17:58:20Z、22:41:43Z（容器内 `/health/live`） |
| 容器状态 | `StartedAt=2026-10-16T02:58:45Z`、`RestartCount=0`，23h 内未重启 |

### 15.6 配置与台账漂移

| 项 | 事实 |
| --- | --- |
| `runtime.env` vs `current/deploy/runtime.env.example` | 55 vs 52 键：多出 `DSH_WORK_AUTH_MODE`、`DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS`、`DSH_WORK_ACP_PROVIDER`、`DSH_WORK_ACP_MODEL`；**缺少示例里的 `DSH_WORK_ADMIN_BOOTSTRAP_ENABLED`**（本地按示例起环境会多一个开关语义） |
| 部署偏差台账 | `automation/local-deviations/` 共 **27** 条（含 `.orig/.patched`、前后 sha256、验证脚本、回滚命令）；`automation/state/installed-releases.md` 仍写“当前在跑 `v2026.10.09-03`”，**落后实际两个版本** |
| 冻结声明 | 自 2026-10-09 起 `releases/**` 只读；历史 **6 处就地修改**（均在 `v2026.09.23-01` 时代，含编译产物），已进 `2026-10-09-retire-list` |
| 异机备份 | `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY=/Volumes/dsh-work-backups` **不存在** → 每次安装都靠“手工等值备份 + 临时补丁副本”绕过；本机 `backups/` 已积累 **747 MB** |
| 未登记的偏差 | **2026-10-14 的 401 事故没有任何 `local-deviations` 记录**（10-10 与 10-16 之间是空白） |

### 15.7 白名单覆盖复查（runbook §12.1 第 1 项，只读 SQL）

用当前 `runtime.env` 的 4 个连接器作 `allowed` 集合查询“已发布版本引用到但白名单未覆盖”的连接器：**结果 0 行**。已发布版本共 15 个，引用 4 个连接器：`connector-skillhive`（5 个版本 / 30 处引用）、`connector-dsh-workspace`（8 / 14）、`connector-mes-gateway`（4 / 4）、`connector-plm`（3 / 3）。

→ 当前**不存在**“白名单漏连接器”导致的 403。日志里 `skillhive-search@1.0.0` 的 34 条 403/404 属 2026-10-09 那次偏差的历史残留；`Agent 发布时固定的工具绑定已失效` 的 46 条属 runbook §12.1 第 2 类**绑定漂移**，处置是重新发布，不是改库。

### 15.8 原因排序修正（覆盖第一轮 J 节）

1. **模型供应商凭据/额度**（201 × 401 + 2 × 403，10-14 06:36–06:43Z）——同时解释 223 次失败 Attempt 与 222 条 MCP 审计告警；
2. **Docker host-gateway 间歇建连超时**（6 × 504 / 23h，最近 2026-10-17 06:41:43 +0800）——独立存在、频次稳定、与业务无关；
3. **版本基线错位**（运行 `af0faca`，本地源码 `667b00e`；DSH 更是 `0.1.2-rc.1@76fda72` vs 本地 `0.1.1-rc.2@b150a55`）；
4. **历史缺陷（已修复，仅作回归项）**：`duplicate loader entry id: mcp-skillhive`、`MCP_CREDENTIAL_STORE_UNAVAILABLE`、白名单漏 `skillhive`、`~/.dsh/settings.yaml` 丢 ACP 路由。

**本地最小复现顺序建议**：① 先复现 504（纯拓扑，不需要模型凭据）；② 再把 provider 指向无效/额度不足的密钥复现 401，并验证 `mcp invocation audit failed` 是否随之出现（一次验证 15.2→15.3 的因果链）；③ 最后做业务语义复现（包内工具未准入、`试运行被阻塞`、绑定漂移 403、以及 14 节的两个 500）。

## 15.1 候选提交 8dd87e0 的目标机隔离仿真（非 P2）

- 执行提交：`8dd87e0`。远端分支 tip `6814b4a` 上的 `target-environment-candidate-handoff.md` 本次未执行。
- 环境：独立 clone `/tmp/dsh-work-repo`；Node `26.8.1`；仓库内 pnpm `11.7.0`；全局 pnpm `11.24.0`；DSH `0.1.2-rc.1 @ 76fda729799fe9b3848dbe2c211d4b231032b81e`；profile `acp-app`；`DSH_RUNTIME_COMPATIBILITY` 未设置；一次性 PostgreSQL `17.11`，`127.0.0.1:55432`，无宿主挂载；迁移到 `0081`。
- 预检 exit 1：`node`、DSH 版本、DSH commit、profile、compatibility、migration `0081` 匹配；pnpm 期望 `11.24.0`、实际 `11.7.0`；sourceCommit 期望 `667b00e`、实际 `8dd87e0`。后两项按已知口径记账，不代表测试失败。密钥只写 `SET`/`MISSING`。
- 测试：provider-401/403 为 `2/2`；agent-draft-api 为 `2/2`；agent-release 为 `29/29`；草稿输入与 P2 日志为 `20/20`；runtime-adapter 全量 `72/72`。`test:scripts` 为 `41/42`，唯一失败是沙箱内 `execFile('/bin/ps')` 的 `spawn EPERM`。
- 关键结果：401 为 `RUNTIME_EXECUTION_FAILED` / `Invalid token`；403 为 `RUNTIME_EXECUTION_FAILED` / `quota is not enough`；均有一条 `mcp invocation audit failed`，且没有 usage/tool 证据。重复 ID 为 `201` 后 `409 state_conflict`，`agents`/`agent_versions` 各仍 1 行，成功审计仍 1 条。非法 PATCH 为 `422 invalid_request`，revision 与版本数不变。case-trials 为 `409`，无 trial/Run/Attempt；旧 release/trials 为 `404`。
- 未执行：浏览器旅程；用真实模型凭据重放畸形提示词；候选 Release 安装与第 16 节 P2。
- 清理后生产 `active-release` 仍是 `v2026.10.16-01`，`current` 未变。一次性容器和 `/tmp/dsh-work-repo` 已删除。

## 16. 候选版本 P2 验收回填（v2026.10.19-01，2026-10-19）

### 16.1 发布、安装与基线

- 分支：`codex/target-environment-hardening`；PR [#3](https://github.com/globalsinocode/dsh-work/pull/3)；合并提交 `ee90ad834410d3b73b035f15f765c2f9e82e40a0`。
- 发布：GitHub Actions **Manual release**（[run 39188399180](https://github.com/globalsinocode/dsh-work/actions/runs/39188399180)）在 `main` 上成功；`v2026.10.19-01` 为 `isDraft=false`、`isPrerelease=false`、`isImmutable=true`、`author=github-actions[bot]`，目标提交与合并提交一致。
- 资产：`dsh-work-v2026.10.19-01.tar.gz`、`dsh-work-v2026.10.19-01.tar.gz.sha256`；归档 sha256 `a318fe44f4e56e7acf4d069d0a1f9257ee78ebb4d6020d730edb3b596df35011`。
- 来源证明：`gh release verify`、`gh release verify-asset`、`gh attestation verify`（signer-workflow、`refs/heads/main`、`source-digest=ee90ad8…`、`--deny-self-hosted-runners`）均通过；构件内 `release.json` 为 `version=2026.10.19-01`、`commit=ee90ad8…`。
- 安装：目标机执行 S1 偏差包（操作者 2026-10-19 明确授权），因为 `/Volumes/dsh-work-backups` 仍不存在。偏差只作用于临时副本：手工等值备份、临时移除 preflight 异机备份闸门、迁移后受控停止、`complete-install.sh` 切换；Release 本体与全部哈希/来源校验不变。包路径：`automation/local-deviations/2026-10-19-install-v2026.10.19-01/s1-fallback/`。
- 升级前备份：`backups/preupgrade-20261019T020916Z`（194M；`database.dump` 18M、`data.tar.gz` 176M；114 张表/视图、88068 行；收据 `receipt.txt`）。
- 安装结果（2026-10-19T10:22:37+0800）：`active-release=v2026.10.19-01`，`current→releases/v2026.10.19-01`，`previous→releases/v2026.10.16-01`；`DSH` 锁 `0.1.2-rc.1 @ 76fda729799fe9b3848dbe2c211d4b231032b81e`；profile bundle `@deepseek-ai/dsh-acp-app`；`DSH_RUNTIME_COMPATIBILITY` 未设置；迁移最大版本 `0081_knowledge_chunks.sql`；`/health` 为 `status=ok`、`dshRuntime=healthy`、`database=ok`。
- 未覆盖 `v2026.10.16-01`（`af0faca`）；回滚目标仍为该版本。`DSH_WORK_AUTO_DEPLOY_ENABLED` 保持 `false`，未启用自动升级。

### 16.2 P2 逐项结果

1. **合法 Agent 创建 + 审计成功：通过。** 专用测试 Agent `agent-p2-target-1019` 返回 `201`，revision `b4469bd2…`，version `0.1.0`；审计 `agent.create` 为 `success`，成功记录 1 条。未重放生产业务 Agent。
2. **重复 ID：通过。** 同一请求第二次返回 `409 state_conflict`，消息“Agent 标识已存在，请刷新列表后重新创建”；`agents` 总数 341→341，该 Agent 的 `agents`/`agent_versions` 仍各 1 行。
3. **非法草稿 PATCH：通过。** 删除 `welcomeMessage` 后返回 `422 invalid_request`（“welcomeMessage 必须是字符串”）；revision 保持 `b4469bd2…`，`agent_versions` 保持 1；`agent.draft.update` 成功审计 0 条。
4. **case-trials 阻塞：通过。** 第二个专用测试 Agent `agent-p2-blocked-1019` 先禁用自身执行 Principal（authorizationVersion 3），再对首个案例发起 `POST /release/case-trials`，返回 `409 state_conflict`（“试运行被阻塞：独立执行身份”）；`agent_trial_runs=0`、相关 `runs=0`、`run_attempts=0`；旧入口 `POST /release/trials` 返回 `404 route_not_found`。
5. **真实 DSH Attempt：通过。** 12/12 候选检查通过；首个案例“正常任务”经 Run/Attempt → Runtime Adapter → DSH 真实执行，终态 `succeeded`，输出 `OK`。脱敏标识：Run `sha256:200c312e2f286315…`、Attempt `sha256:f7d5bcf8734b0f9f…`（仅记录截断哈希）。usage：`input_tokens=12397`、`output_tokens=2`、`actual_output_bytes=2`、`actual_tool_calls=0`、`actual_duration_ms=6655`、`token_measurement=reported`、`cost_measurement=unavailable`；`tool_audit_logs` 计数 0。首案例后受控取消 trial（`cancelled`），未继续其余 4 个案例；Run/Attempt 仍为 `succeeded`。
6. **Nginx requestId 关联、uri 去查询串：通过。** 探测 `GET /api/admin/v1/p2-correlation-probe-1019?token=should-not-appear&x=1` 返回 `404`；响应 `X-Request-Id` 的 sha256 截断为 `7e6148801b7f1979…`。Nginx access log 的 `request_id` 与应用错误日志的 `requestId` 完全一致；Nginx `uri=/api/admin/v1/p2-correlation-probe-1019`（不含 `?token=…`），应用 `path=[unmatched]`、`status=404`、`code=route_not_found`。
7. **观察窗口 504 与最长 upstream_connect_time：通过。** 窗口 `2026-10-19T02:22:36Z–02:55:09Z`（CST 10:22:36–10:55:09），共 933 条 Nginx access 记录；504 计 1 条（`02:23:57Z`，`GET /health/live`，`upstream_connect_time="-"`、`upstream_response_time=5.006`），是启动期健康探测，不是业务请求；数值型 `upstream_connect_time` 最大 `0.038s`。

### 16.3 结论、边界与未完成项

- 结论：在 `v2026.10.19-01` 安装基线上，P2 第 1–7 项均有可复核证据并通过；发布由 **Manual release** 工作流在 `main` 上生成并带 Sigstore 来源证明，不是本地自编译包。
- 边界：安装仍使用 **S1 异机备份偏差**（站点无第二存储目标），因此不能把本次写成“无偏差正式验收”；`auto-deploy` 保持 `false`，不自动扩散该版本。若操作者要求严格无偏差，需要先提供真实异机备份目标，再按官方 `release.sh` 重跑一次等价安装。
- 验证过程中管理员会话曾过期（`401 session_expired`），随后由操作者提供新会话完成第 4、6、7 项；未输出 cookie、模型密钥或数据库内容。
- 模型凭据边界：第 5 项真实 Attempt 使用的是操作者提供的**测试用**模型密钥（`globalsino-deepseek` / `deepseek-flash`），仅用于 2026-10-19 时点验证；该密钥后续可能被禁用或删除。届时新的模型型 Attempt 会在 provider 认证处失败（`401/403` 或 `MISSING_CREDENTIAL`），但已落库的 Run/Attempt、usage 与本 P2 证据不会被追溯改写；第 1–4、6–7 项不依赖该密钥。生产长期使用需换用受管的生产凭据。
- 专用测试数据：`agent-p2-target-1019` 与 `agent-p2-blocked-1019` 均为 draft，无已发布版本；未触碰生产业务 Agent。`agent-p2-blocked-1019` 的执行 Principal 已禁用，仅用于阻塞路径。
- 清理：临时 cookie/密钥文件、下载目录、一次性 clone 与 Nginx 窗口日志在回填后删除；`backups/preupgrade-20261019T020916Z` 保留作为回滚材料。
- 严格无偏差复跑前置检查（2026-10-19 11:43）：`/Volumes/dsh-work-backups` 不存在；`/Volumes` 下仅有两个 SMB 挂载 `/Volumes/MDGROUP3 N`（3.6Ti，1.2Ti 可用）与 `/Volumes/品质保管部`（932Gi，145Gi 可用）。这两个挂载只用于判断是否存在可写的异机文件系统，**未向共享写入任何备份或业务文件**；两者根目录对 `deploy` 均不可写（`mkdir`/`touch` 返回 `Permission denied`）。它们是部门业务共享，不是经批准的 dsh-work 备份目标，不应复用；严格安装需要专用的 `dsh-work-backups` 共享或独立卷。故未修改 `runtime.env`、未回滚、未运行官方 `release.sh`；`active-release` 仍为 `v2026.10.19-01`，`DSH_WORK_AUTO_DEPLOY_ENABLED=false`。
- 决策（2026-10-19 14:24）：操作者选择 **A. 保持现状，不重装**。严格无偏差复装不执行；当前 `v2026.10.19-01` 继续运行，`auto-deploy` 保持 `false`；无 off-host 备份目标作为已知缺口保留；未修改共享文件夹，未修改 `runtime.env`。
