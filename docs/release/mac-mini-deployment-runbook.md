# Mac mini 部署手册

更新时间：2026-09-08

本流程用于在**已经部署 AI Hub、已经安装 DSH 的同一台 Apple Silicon Mac mini** 上，
首次部署 dsh-work。参考 AI Hub 的
[Mac mini 镜像部署文档](https://github.com/tonycc/ai-hub/blob/main/docs/macmini-image-deployment.md)，
所有 dsh-work 命令以本仓库现有部署脚本为准；本文统一维护首次安装、升级、恢复和地址变更。

目标顺序：确认现有环境 → 登记 AI Hub 应用 → 验证并下载 Release → 配置与预检 →
部署指定版本 → 登录和备份验收 → 启用后续自动部署。

本文是操作手册，不代表已经在 Mac mini 上执行或验收。当前已确认的服务器访问基线是
`deploy@192.168.33.20`，服务器报告的 DSH 为 `0.1.2-rc.1`、Commit
`76fda729799fe9b3848dbe2c211d4b231032b81e`。目录、证书、OIDC 凭据和备份挂载仍须在
服务器上按本文核验，不能仅依据示例值认定已经满足条件。
代码保留的 `0.1.1-rc.2` 本地开发兼容模式不适用于本流程，也不能作为服务器降级选项。

## 1. 部署边界与端口

| 组件 | 地址示例 | 本次操作 |
| --- | --- | --- |
| 已有 AI Hub 门户/API | `https://192.168.33.20` | 复用，只登记 dsh-work 应用及凭据 |
| 已有 authentik | `https://192.168.33.20:8443` | 复用，不重装、不直接改蓝图 |
| 已有 AI Hub PostgreSQL | `127.0.0.1:5433` | 不操作 |
| 新增 dsh-work 员工端 | `https://192.168.33.20:4174/workbench` | Nginx 容器提供 HTTPS |
| 新增 dsh-work 管理端 | `https://192.168.33.20:4180/overview` | 同一个 Nginx 容器提供 HTTPS |
| 新增 dsh-work 后端 | `127.0.0.1:4190` | 宿主机 Node 模块化单体，由 launchd 管理 |
| 新增 dsh-work PostgreSQL | `127.0.0.1:5434` | 独立 Compose 项目 `dsh-work` 和数据卷 |
| 已有 DSH | 宿主机固定版本的独立安装目录 | 后端通过 stdio 启动；不随应用自动升级 |

dsh-work 不是 AI Hub 的另一个容器，也不是纯镜像部署。其前后端及生产依赖由 GitHub
构建为 Release 压缩包；Mac mini 不需要克隆或编译 dsh-work，但仍需保留已安装 DSH 的
独立 Git checkout、依赖及构建产物。无需新增 Linux VM、K8s、微服务或生产 Self-hosted Runner。

复用 AI Hub 已建立的离线根 CA。相同 IP 可以使用同一张服务器证书，在 dsh-work 中保存
独立副本；不要重建 CA、修改 AI Hub 的 `runtime.env`，也不要复制它的数据库/OIDC/备份密钥。

## 2. 准备非敏感参数

由部署人员确认以下值。使用运行 Docker Desktop 的普通 macOS 服务账号；不是开发电脑上
恰好同名的目录，也不是 `root`。DSH 必须能被该账号读取和执行，其凭据目录也必须可用。

| 参数 | 示例 | 确认方式 |
| --- | --- | --- |
| 仓库 | `tonycc/dsh-work` | dsh-work 的公开 GitHub 仓库 |
| Release Tag | `v2026.09.07-01` | 管理员批准的、已发布的不可变 Release，格式为 `vYYYY.MM.DD-NN` |
| Mac mini IP | `192.168.33.20` | 沿用 AI Hub 正在使用的 RFC1918 私有保留地址 |
| dsh-work 根目录 | `/Users/deploy/services/dsh-work` | 首次安装的新目录；不能是 AI Hub 或 DSH 目录 |
| AI Hub 根目录 | `/Users/deploy/services/ai-hub` | 现有部署的真实目录，只读引用其证书 |
| DSH 安装目录 | `/Users/deploy/services/deepseek-harness` | 已安装且完成构建的独立 checkout |
| DSH 配置目录 | `/Users/deploy/.dsh` | 已配置模型凭据的 `DSH_HOME`，不是安装目录 |
| Node 可执行文件 | `/opt/homebrew/bin/node` | 满足预检要求的真实绝对路径 |
| 异机备份目录 | `/Volumes/dsh-work-backups` | 已挂载、可写、启用加密和访问控制的 NAS/异机存储 |

以下命令在 Mac mini 的一个持续 Bash 会话中**逐段执行**；每段检查成功后再继续，不能把
整篇文档当作一段脚本运行。自动化 Agent 不得读取或回显密钥；需人工编辑配置、登记应用
或批准生产变更时，应交由有权限的人员在本地完成。

从运维终端进入服务器：

```bash
ssh deploy@192.168.33.20
```

```bash
/bin/bash
```

```bash
set -euo pipefail
set +x
umask 077
export PATH=/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin

DWP_REPOSITORY='tonycc/dsh-work'
DWP_TAG='v2026.09.07-01'
DWP_VERSION="${DWP_TAG#v}"
DWP_IP='192.168.33.20'
DWP_ROOT='/Users/deploy/services/dsh-work'
DWP_AIH_ROOT='/Users/deploy/services/ai-hub'
DWP_CERT_SOURCE="${DWP_AIH_ROOT}/tls"
DWP_RUNTIME_HOME='/Users/deploy/services/deepseek-harness'
DWP_DSH_HOME='/Users/deploy/.dsh'
DWP_NODE='/opt/homebrew/bin/node'
DWP_OFFHOST='/Volumes/dsh-work-backups'

[[ "${DWP_REPOSITORY}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "${DWP_TAG}" =~ ^v[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])-[0-9]{2}$ ]]
[[ "${DWP_ROOT}" == "/Users/$(id -un)/"* ]]
[[ "${DWP_ROOT}" != "${DWP_AIH_ROOT}" && "${DWP_ROOT}" != "${DWP_RUNTIME_HOME}" ]]
[[ "${DWP_ROOT}" != *[[:space:]]* ]]
```

`DWP_*` 仅用于本手册当前终端，不能写进 `runtime.env` 让 launchd 引用。下面的运行配置
必须填写真实的绝对路径和地址。若 Node 在 `node@24/bin` 等其他目录，终端与 `runtime.env`
的 `PATH` 都应加入其真实目录，不能依赖交互式 Shell 的 nvm 初始化。

## 3. 发布端先准备 Release

此步骤在开发/运维端和 GitHub 完成，不在生产服务器构建：

1. 确认部署改动已合并到 dsh-work 的 `main`，目标 Commit 的 **M6 quality gate** 成功。
2. 在仓库 `Settings → General → Releases` 启用 **Enable release immutability**。
   旧 Release 不会因此自动变为不可变 Release；不能用旧可变包充当新发布包。
3. 确认 `server/package.json` 中的 `releaseVersion` 与准备发布的日期版本一致。
4. 在 Actions 中人工运行 **Manual release**，选择 `main`，输入不带 `v` 的版本，
   例如本次发布的 `2026.09.07-01`。同一天的后续发布递增 `NN`；若 Tag/Release 已存在，递增构建号并通过 CI 后再发布，不能覆盖旧 Tag。
5. 等待工作流成功。目标 `v2026.09.07-01` 应包含 `dsh-work-v2026.09.07-01.tar.gz` 和对应 `.sha256`，
   并具有 GitHub 构建来源证明。

普通 push 只运行 CI，不部署。服务器凭据只负责读取和验证 Release，不需要 GitHub 写权限，
也不负责触发生产发布。DSH 的 Version/Commit 最终以该 Release 内的
`server/config/dsh/runtime-lock.json` 为准。

## 4. Mac mini 只读检查

### 4.1 主机、工具和现有部署

```bash
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
[[ "$(id -u)" -ne 0 ]]
for DWP_COMMAND in docker git gh curl openssl shasum tar launchctl plutil lsof; do
  command -v "${DWP_COMMAND}" >/dev/null
done
test -x "${DWP_NODE}"
"${DWP_NODE}" -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (!((major === 22 && minor >= 19) || major >= 24)) process.exit(1)
  console.log(`Node ${process.versions.node}`)
'
docker info >/dev/null
docker compose version
gh auth status
gh release verify --help >/dev/null
gh release verify-asset --help >/dev/null
gh attestation verify --help | grep -F -- '--deny-self-hosted-runners' >/dev/null
launchctl print "gui/$(id -u)" >/dev/null
ifconfig | awk -v ip="${DWP_IP}" '
  $1 == "inet" && $2 == ip { found = 1 }
  END { exit(found ? 0 : 1) }
'
df -h "/Users/$(id -un)"
```

缺少工具时由运维补齐。AI Hub 已安装的 Docker Desktop 和 GitHub CLI 可以复用；dsh-work
运行需要额外确认 Git、Node 和已构建 DSH，不需要为运行发布包再安装 pnpm。
GitHub CLI 必须在这个服务账号下认证，具备读取 dsh-work 内容和来源证明的权限；不要把令牌
粘贴到对话、命令参数或 `runtime.env`。

服务器出站还需能访问 GitHub API、Release 资产/来源证明服务，以及 Compose 中固定
PostgreSQL/Nginx 镜像所在的 Docker Hub。AI Hub 已能从 GHCR 拉取镜像，不代表 Docker Hub
也一定可达；网络受限时先由运维确认出站策略，不能改用未经验证的镜像来绕过。

确认服务账号保持图形登录会话、Docker Desktop 登录后自动启动、Mac mini 不自动睡眠，且
磁盘除 AI Hub 用量外仍有足够余量；脚本最低要求部署盘空闲 5 GiB，这不是生产容量规划值。
防火墙仅向受信任内网新增放行 **4174、4180**；不要开放 4190、5434 或配置公网转发。

首次安装根目录应尚不存在；已有目录、服务或数据卷时停止本流程，先确认是旧部署还是失败
现场，不能删除它们来“重新安装”：

```bash
[[ ! -e "${DWP_ROOT}" && ! -L "${DWP_ROOT}" ]]
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=dsh-work)" ]]
[[ -z "$(docker volume ls -q --filter label=com.docker.compose.project=dsh-work)" ]]
for DWP_LABEL in com.company.dsh-work.server com.company.dsh-work.release-watcher; do
  if launchctl print "gui/$(id -u)/${DWP_LABEL}" >/dev/null 2>&1; then
    printf 'existing dsh-work LaunchAgent: %s\n' "${DWP_LABEL}" >&2
    exit 1
  fi
done
for DWP_PORT in 4174 4180 4190 5434; do
  if lsof -nP -iTCP:"${DWP_PORT}" -sTCP:LISTEN; then
    printf 'required dsh-work port is occupied: %s\n' "${DWP_PORT}" >&2
    exit 1
  fi
done
```

443、8443、5433 已被 AI Hub 使用是正常现象，不能为 dsh-work 停掉占用这些端口的容器。

### 4.2 AI Hub、证书、备份和 DSH

```bash
test -r "${DWP_CERT_SOURCE}/server.crt"
test -r "${DWP_CERT_SOURCE}/server.key"
test -r "${DWP_CERT_SOURCE}/root-ca.crt"
[[ ! -e "${DWP_CERT_SOURCE}/root-ca.key" ]]
[[ ! -e "${DWP_CERT_SOURCE}/internal-ca.key" ]]

curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  --cacert "${DWP_CERT_SOURCE}/root-ca.crt" "https://${DWP_IP}/health/ready"
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  --cacert "${DWP_CERT_SOURCE}/root-ca.crt" "https://${DWP_IP}:8443/-/health/ready/"

[[ -d "${DWP_OFFHOST}" && ! -L "${DWP_OFFHOST}" && -w "${DWP_OFFHOST}" ]]
df -h "${DWP_OFFHOST}"
git -C "${DWP_RUNTIME_HOME}" rev-parse HEAD
git -C "${DWP_RUNTIME_HOME}" status --short --untracked-files=no
"${DWP_NODE}" -p 'require(process.argv[1]).version' "${DWP_RUNTIME_HOME}/package.json"
test -r "${DWP_RUNTIME_HOME}/apps/cli/src/bin.ts"
test -r "${DWP_RUNTIME_HOME}/apps/cli/lib/bin.js"
test -r "${DWP_RUNTIME_HOME}/packages/bundle/acp-app/cordis.patch.yml"
test -d "${DWP_RUNTIME_HOME}/node_modules/tsx"
test -d "${DWP_DSH_HOME}"
```

AI Hub 必须健康，DSH tracked files 必须干净。当前 DSH 锁定版本为 `0.1.2-rc.1`、
Commit 为 `76fda729799fe9b3848dbe2c211d4b231032b81e`；第 8 节会用目标发布包再次
进行严格比对和真实 ACP 握手。“已经安装 DSH”不等于版本一定兼容；不一致时先停止并按
[Runtime 交付基线](dsh-runtime-delivery.md)安排独立升级，不能在现有目录直接拉取最新版。
若 `DSH_HOME` 尚未配置模型凭据，由运维按现有 DSH 凭据流程完成配置，不要复制其他人员的
整个配置目录，也不能把仅通过握手的环境记录为业务验收通过。

备份目录必须确实位于 NAS/另一台机器。可在 AI Hub 已有的异机挂载卷中准备 dsh-work
独立子目录，但不能混用备份文件或回执。禁止用 `mkdir /Volumes/...` 创建本机空目录假装
已挂载；预检还会拒绝与部署根目录在同一文件系统的路径。不同本地分区或 USB 盘也不等于异机。

若服务账号不能读取 AI Hub 的证书，由管理员把三个证书文件安全交接到独立暂存目录，再
修改 `DWP_CERT_SOURCE`；不要放宽整个 AI Hub 配置目录的权限。发现 CA 私钥留在服务器
时停止部署，按证书安全流程处理；不要复制它，也不要关闭 TLS 验证。

## 5. 在现有 AI Hub 登记应用

由有权限的人员登录现有 AI Hub 门户操作；不重新生成 AI Hub 配置、不直接修改 authentik。

1. 确保员工目录中至少有一位状态为 `ACTIVE`、`business_user=true` 的业务员工。
   `ai-hub-platform-admin`、`akadmin` 等平台/身份服务运维账号不能充当 dsh-work 首位业务管理员。
2. 在“应用中心”创建一个 `dsh-work` 应用，选择业务负责人，能力使用 `API_CLIENT`，
   应用状态设为启用。不要另建 `dsh-work-admin`。
3. 创建 `production` 环境，**单独指定该环境的初始管理员**，填写下表。

| AI Hub 环境字段 | 应填写的值 |
| --- | --- |
| 环境标识 | `production` |
| 版本 | 目标 dsh-work Release 版本，如 `2026.09.07-01` |
| 门户入口 | `https://192.168.33.20:4174/workbench` |
| API 地址 | `https://192.168.33.20:4174/api` |
| 健康检查 | `https://192.168.33.20:4174/health` |
| OIDC 回调地址，第 1 行 | `https://192.168.33.20:4174/auth/workbench/callback` |
| OIDC 回调地址，第 2 行 | `https://192.168.33.20:4180/auth/admin/callback` |
| 初始管理员 | 准备首次登录 dsh-work 管理端的 ACTIVE 业务员工 |
| 状态 | 启用（`ACTIVE`） |

回调必须逐字一致，不加尾部 `/`，不用 `localhost`、4190 或旧版 AI Hub 的 8088/9443。
AI Hub 访问登记的 API/健康地址也应走这套可信 HTTPS；不能以关闭证书验证解决可达性问题。

环境凭据应包含以下 Scope：

```text
openid profile email offline_access ai_hub.identity platform.me.read
platform.application.bootstrap platform.directory.read
```

在密钥管理中创建该 `production` 环境的凭据，将一次性显示的 Secret 直接保存到受控密码
管理器和 Mac mini 的 dsh-work 配置文件。已有此环境且凭据有效时直接使用，不为重复执行
安装流程而轮换；不复用 AI Hub 门户凭据或 `local` 环境凭据。

记录实际的 Application ID、环境、Issuer、Client ID 和 Audience。当前 AI Hub 通常会为
首版凭据生成 `dsh-work__production__v1` 这样的 Client ID，以及
`https://<IP>:8443/application/o/ai-hub-dsh-work-production-v1/` 这样的 Issuer。
**以凭据界面的实际输出为准**：不能照抄模板中的 `/application/o/dsh-work/`，也不能把
`AI_HUB_OIDC_AUDIENCE` 固定写成应用标识 `dsh-work`；通常它应等于实际 Client ID。
凭据版本号也不是 dsh-work 的发布版本号。

负责人、登记人不自动获得应用权限。dsh-work 的角色和数据范围由自身管理；不要在 AI Hub
登记 `dsh_work.*` 权限或启用无关能力。更完整的身份规则见
[AI Hub 身份接入说明](ai-hub-sso-integration.md)。

## 6. 下载并验证指定 Release

在 Mac mini 上验证稳定 Release 的元数据和来源，之后才能执行包内脚本：

```bash
[[ "$(gh release view "${DWP_TAG}" --repo "${DWP_REPOSITORY}" \
  --json isDraft,isPrerelease,isImmutable,author \
  --jq '.isDraft == false and .isPrerelease == false and .isImmutable == true and .author.login == "github-actions[bot]"')" == true ]]
DWP_SOURCE_SHA="$(gh release view "${DWP_TAG}" --repo "${DWP_REPOSITORY}" \
  --json targetCommitish --jq .targetCommitish)"
[[ "${DWP_SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]]
gh release verify "${DWP_TAG}" --repo "${DWP_REPOSITORY}"

DWP_BOOTSTRAP="$(mktemp -d /private/tmp/dsh-work-bootstrap.XXXXXX)"
DWP_ARCHIVE="dsh-work-${DWP_TAG}.tar.gz"
gh release download "${DWP_TAG}" --repo "${DWP_REPOSITORY}" \
  --pattern "${DWP_ARCHIVE}" --pattern "${DWP_ARCHIVE}.sha256" \
  --dir "${DWP_BOOTSTRAP}"
(
  cd "${DWP_BOOTSTRAP}"
  shasum -a 256 -c "${DWP_ARCHIVE}.sha256"
)
gh release verify-asset "${DWP_TAG}" "${DWP_BOOTSTRAP}/${DWP_ARCHIVE}" \
  --repo "${DWP_REPOSITORY}"
gh attestation verify "${DWP_BOOTSTRAP}/${DWP_ARCHIVE}" \
  --repo "${DWP_REPOSITORY}" \
  --signer-workflow "${DWP_REPOSITORY}/.github/workflows/release.yml" \
  --source-ref refs/heads/main --source-digest "${DWP_SOURCE_SHA}" \
  --deny-self-hosted-runners

tar -xzf "${DWP_BOOTSTRAP}/${DWP_ARCHIVE}" -C "${DWP_BOOTSTRAP}"
DWP_BUNDLE="${DWP_BOOTSTRAP}/dsh-work-${DWP_TAG}"
"${DWP_NODE}" -e '
  const manifest = require(process.argv[1])
  if (manifest.version !== process.argv[2] || manifest.commit !== process.argv[3]) process.exit(1)
' "${DWP_BUNDLE}/release.json" "${DWP_VERSION}" "${DWP_SOURCE_SHA}"
test -x "${DWP_BUNDLE}/scripts/deploy/release.sh"
test -x "${DWP_BUNDLE}/scripts/deploy/install-release-watcher.sh"
```

任何验证失败都停止。不能只验证随包下载的 SHA-256，也不能手工更改 `release.json`、
忽略来源证明或从某个未经验证的源码目录启动应用。

## 7. 首次创建运行配置与证书目录

再次确认目标目录不存在，只初始化一次：

```bash
[[ ! -e "${DWP_ROOT}" && ! -L "${DWP_ROOT}" ]]
install -d -m 0700 "${DWP_ROOT}" "${DWP_ROOT}/certs"
install -m 0600 "${DWP_BUNDLE}/deploy/runtime.env.example" "${DWP_ROOT}/runtime.env"
install -m 0600 "${DWP_CERT_SOURCE}/server.key" "${DWP_ROOT}/certs/server.key"
install -m 0644 "${DWP_CERT_SOURCE}/server.crt" "${DWP_ROOT}/certs/server.crt"
install -m 0644 "${DWP_CERT_SOURCE}/root-ca.crt" "${DWP_ROOT}/certs/root-ca.crt"
openssl verify -CAfile "${DWP_ROOT}/certs/root-ca.crt" "${DWP_ROOT}/certs/server.crt"
openssl x509 -in "${DWP_ROOT}/certs/server.crt" -noout -checkend 2592000
```

最后一条要求至少还有 30 天有效期；不足时先由运维工作站使用原根 CA 续签。首次安装并不
需要创建新 CA。客户端若已信任 AI Hub 使用的同一根 CA，也不需要再次安装另一套根证书。

在 Mac mini 本地编辑 `runtime.env`，不要回显到 Agent 执行日志或聊天。保留模板中其他配置，
逐项替换以下内容；表中“所选目录”均填写第 2 节的**实际值**，而不是 `DWP_*` 变量名。

| 配置 | 应填写的值 |
| --- | --- |
| `DSH_WORK_DEPLOY_ROOT`、`DSH_WORK_GITHUB_REPOSITORY` | 所选 dsh-work 根目录、`tonycc/dsh-work` |
| `DSH_WORK_NODE_BIN`、`PATH` | 已检查的 Node 绝对路径及完整工具搜索路径 |
| `DSH_WORK_AUTO_DEPLOY_ENABLED` | 首次安装先设为 `false`，第 10 节再启用 |
| `DSH_WORK_RELEASE_POLL_INTERVAL_SECONDS` | `300` |
| `NODE_ENV` | `production` |
| `DSH_WORK_SERVER_HOST`、`DSH_WORK_SERVER_PORT` | `127.0.0.1`、`4190` |
| `DSH_WORK_PUBLIC_HOST`、`DSH_WORK_BIND_ADDRESS` | 兼容字段；两者都填首个 Mac mini LAN IP，不使用 `0.0.0.0` |
| `DSH_WORK_BIND_ADDRESSES` | 初次部署填同一个 LAN IP；后续多 IP 用无空格逗号分隔，第一项与兼容字段一致 |
| `DSH_WORK_WORKBENCH_PORT`、`DSH_WORK_ADMIN_PORT` | `4174`、`4180` |
| `DSH_WORK_POSTGRES_PORT` | `5434` |
| `DSH_WORK_POSTGRES_DB`、`DSH_WORK_POSTGRES_USER` | 两者均为 `dsh_work`，与 AI Hub 独立 |
| `DSH_WORK_POSTGRES_PASSWORD` | 新生成的独立随机密码，建议使用至少 32 随机字节的十六进制形式 |
| `DSH_WORK_DATABASE_URL` | `postgres://dsh_work:<同一数据库密码>@127.0.0.1:5434/dsh_work` |
| `DSH_WORK_DATA_ROOT` | `<dsh-work 根目录>/data` |
| `DSH_WORK_DSH_SESSIONS_ROOT` | `<dsh-work 根目录>/data/dsh-sessions`，保持在备份覆盖的数据目录内 |
| `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY` | 已确认的 dsh-work 异机备份目录 |
| `DSH_RUNTIME_HOME`、`DSH_HOME` | 已安装 DSH 的 checkout 路径、其独立凭据/配置目录 |
| `DSH_EXPECTED_VERSION`、`DSH_EXPECTED_COMMIT` | 生产主 Runtime Lock：`0.1.2-rc.1` 和 `76fda729799fe9b3848dbe2c211d4b231032b81e` |
| `DSH_RUNTIME_COMPATIBILITY` | 必须保持未设置；这是本地开发专用开关 |
| `DSH_WORK_TLS_CERT_FILE`、`DSH_WORK_TLS_KEY_FILE` | `<dsh-work 根目录>/certs/server.crt`、`<dsh-work 根目录>/certs/server.key` |
| `DSH_WORK_CA_CERT_FILE`、`NODE_EXTRA_CA_CERTS` | 两者均为 `<dsh-work 根目录>/certs/root-ca.crt` |
| `DSH_WORK_AUTH_MODE`、`DSH_WORK_COOKIE_SECURE` | `oidc`、`true` |
| `DSH_WORK_SESSION_SECRET` | 另一份独立高熵随机值，至少 32 字符，不与数据库密码共用 |
| `DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS` | `900`，生产不可设为 `0` |
| `AI_HUB_PLATFORM_URL` | `https://<Mac mini IP>`，使用 443 |
| `AI_HUB_APPLICATION_ID`、`AI_HUB_ENVIRONMENT` | `dsh-work`、`production` |
| `AI_HUB_OIDC_ISSUER` | AI Hub 为该环境凭据返回的完整 Issuer，包含正确的路径和尾部 `/` |
| `AI_HUB_CLIENT_ID`、`AI_HUB_CLIENT_SECRET` | 该环境的真实凭据，两端共用 |
| `AI_HUB_OIDC_AUDIENCE` | 实际 Audience，通常等于上述 Client ID，不是固定的 `dsh-work` |
| `AI_HUB_WORKBENCH_PORTAL_URL` | `https://<Mac mini IP>:4174` |
| `AI_HUB_WORKBENCH_REDIRECT_URI` | `https://<Mac mini IP>:4174/auth/workbench/callback` |
| `AI_HUB_ADMIN_PORTAL_URL` | `https://<Mac mini IP>:4180` |
| `AI_HUB_ADMIN_REDIRECT_URI` | `https://<Mac mini IP>:4180/auth/admin/callback` |
| `DSH_WORK_WORKBENCH_ORIGINS`、`DSH_WORK_ADMIN_ORIGINS` | 初次分别填 `https://<Mac mini IP>:4174`、`https://<Mac mini IP>:4180`；后续可追加已批准 IP/域名 Origin |
| `DSH_WORK_WORKBENCH_DEFAULT_ORIGIN`、`DSH_WORK_ADMIN_DEFAULT_ORIGIN` | 初次与上述单入口相同；启用固定域名后可改为相应域名 Origin |

密码可在受控本地终端用 `openssl rand -hex 32` 分别生成，或由密码管理器生成；不要让
Agent 把生成值输出到对话。非十六进制数据库密码需正确 URL 编码后再放入连接串。
文件采用 shell-compatible dotenv：特殊字符需安全引用，不写命令、不写命令替换。
`DSH_RUNTIME_COMMAND` 保持未设置；模型密钥由现有 DSH 凭据体系管理，不加入本文件。

## 8. 预检并部署指定版本

先进行语法和环境检查，不手工创建数据库、不手工切换 `current`：

```bash
chmod 600 "${DWP_ROOT}/runtime.env"
/bin/bash -n "${DWP_ROOT}/runtime.env"
if grep -Eq 'replace-me|<[^>]+>' "${DWP_ROOT}/runtime.env"; then
  printf 'runtime.env still contains placeholders; edit it locally\n' >&2
  exit 1
fi
bash "${DWP_BUNDLE}/scripts/deploy/preflight.sh" "${DWP_ROOT}" "${DWP_BUNDLE}"
```

预检会核对 Node、OIDC 配置、数据库连接串、证书链/IP SAN/私钥匹配、异机挂载、磁盘、DSH
生产主版本及构建，拒绝本地兼容模式，并完成一次不发送 Prompt 的 ACP 握手和临时 Session
创建。首次部署也要求异机目录已就绪；
AI Hub 的“首次无旧数据可不提供备份回执”不能用于跳过 dsh-work 的挂载预检。

继续检查该环境的 OIDC Discovery 可达，以下命令只加载配置，不输出任何 Secret：

```bash
(
  set -a
  source "${DWP_ROOT}/runtime.env"
  set +a
  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    --cacert "${DSH_WORK_CA_CERT_FILE}" \
    "${AI_HUB_OIDC_ISSUER%/}/.well-known/openid-configuration" --output /dev/null
)
```

确认这次安装获准后，部署前面已验证的指定版本：

```bash
bash "${DWP_BUNDLE}/scripts/deploy/release.sh" "${DWP_VERSION}" "${DWP_ROOT}"
```

首次需要执行这一次 `release.sh`；它会再次验证来源，把发布包放入 `releases/<Tag>`，
初始化独立 PostgreSQL、执行迁移、建立 `current`、安装 Node LaunchAgent、启动 Nginx 并
检查 HTTPS，成功后写入 `active-release`。不要用裸 `docker compose up`、`pnpm dev` 或
手工软链接代替，也不要给尚未创建 `current` 的空目录直接安装 watcher。

失败时停止，保留目录、数据卷和日志；不能直接重新运行第 7 节覆盖配置。若已经成功启动，
也不要重跑同版本 `release.sh`，脚本会拒绝覆盖活动 Release。`DSH_WORK_AUTO_DEPLOY_ENABLED=false`
只暂停 watcher，不禁止这里明确执行的人工部署。

## 9. 完成首次验收与备份

### 9.1 服务和入口

```bash
[[ "$(<"${DWP_ROOT}/active-release")" == "${DWP_TAG}" ]]
[[ -L "${DWP_ROOT}/current" ]]
launchctl print "gui/$(id -u)/com.company.dsh-work.server"
docker compose --env-file "${DWP_ROOT}/runtime.env" \
  -f "${DWP_ROOT}/current/deploy/compose.yaml" \
  -f "${DWP_ROOT}/generated/compose.endpoints.yaml" ps
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:4190/health
for DWP_PORT in 4174 4180; do
  curl --fail --silent --show-error --max-time 30 \
    --cacert "${DWP_ROOT}/certs/root-ca.crt" "https://${DWP_IP}:${DWP_PORT}/health"
done
curl --fail --silent --show-error --max-time 30 \
  --cacert "${DWP_CERT_SOURCE}/root-ca.crt" "https://${DWP_IP}/health/ready"
curl --fail --silent --show-error --max-time 30 \
  --cacert "${DWP_CERT_SOURCE}/root-ca.crt" "https://${DWP_IP}:8443/-/health/ready/"
```

确认 `postgres`、`web` 健康，且 AI Hub 仍健康。Nginx 通过 `host.docker.internal:4190`
访问宿主机后端：若回环健康而 HTTPS 返回 502，检查 Docker Desktop 到宿主机的连接和
Nginx 日志；不要为排障把 4190 暴露到全网，也不要忽略 HTTPS 检查。
端口发布由预检生成的 `generated/compose.endpoints.yaml` 管理；不要省略该文件直接运行
Compose，否则无法验证实际入口集合。

从另一台已信任根 CA 的局域网电脑确认 4174/4180 可访问，4190/5434 不可访问。

### 9.2 身份与实际任务

1. 用第 5 节指定的 `production` 初始管理员打开 `https://<IP>:4180/overview`，完成
   AI Hub 登录，确认自动获得 dsh-work 本地平台管理员。部署不会创建另一个默认管理员密码。
2. 在“员工与权限”同步目录；给测试员工分配本地 `employee` 角色，再登录员工端。
3. 至少配置第二位有效平台管理员，检查权限撤销后下一请求被拒绝。
4. 在 AI Hub 接入治理中执行 `OIDC_ONLY` 认证，不以启用通知等无关能力换取通过。
5. 使用已配置的 DSH 模型凭据完成一个无敏感内容的小任务，确认输出、事件流、取消和成果
   可用。ACP 握手和健康检查通过不等于模型/工具调用已经验收。

### 9.3 首份异机备份

在没有运行中任务的维护窗口执行；此操作会短暂停止并恢复 dsh-work 后端：

```bash
bash "${DWP_ROOT}/current/scripts/deploy/backup.sh" "${DWP_ROOT}"
```

应同时得到本机 `backups/<UTC时间戳>/` 及异机目录中的 `.tar.gz`、`.sha256`、
`.tar.gz.verified.json`。脚本重新读取异机归档并校验哈希；该回执**不代表已完成恢复演练**。
安排隔离恢复验证，不能在仍承载 AI Hub 的 Docker 环境中误删共享数据。

dsh-work 归档没有 AI Hub 那样的应用层加密，NAS 必须有静态加密和最小权限。该备份覆盖
dsh-work 数据库、`DSH_WORK_DATA_ROOT` 与发布清单，不覆盖 `runtime.env`、证书私钥、
外部 `DSH_HOME` 或 DSH 安装目录；这些应另行受控托管并验证灾难恢复，不把 Secret 提交 Git。

## 10. 验收后启用自动部署

watcher 只跟随 GitHub 的最新稳定 Release，安装后会立即运行。先确认最新版本就是刚验收
的版本；若已有新版本，先评估它，不要在未获准时启用自动升级：

```bash
DWP_LATEST_TAG="$(gh release view --repo "${DWP_REPOSITORY}" --json tagName --jq .tagName)"
[[ "${DWP_LATEST_TAG}" == "${DWP_TAG}" ]]
```

如果服务器的 `current` 仍指向旧版 `v0.1.x`，不能只从旧 `current` 重装 watcher：旧版
`release.sh` 也不能完成日期版本升级。先按第 6～8 节下载并验证目标 Release，保持
`DSH_WORK_AUTO_DEPLOY_ENABLED=false`，用已验证的新 bundle 完成一次人工升级：

```bash
bash "${DWP_BUNDLE}/scripts/deploy/release.sh" "${DWP_VERSION}" "${DWP_ROOT}"
```

确认 `active-release` 和 `current` 已指向目标版本后，再在本地编辑器中仅将
`runtime.env` 的 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改为 `true`，保留全部密钥和其他值，
并始终从已验证的 bundle 安装新版 watcher，不要调用旧 `current` 中的安装脚本：

```bash
bash "${DWP_BUNDLE}/scripts/deploy/install-release-watcher.sh" "${DWP_ROOT}"
test -x "${DWP_ROOT}/automation/watch-release.sh"
test -x "${DWP_ROOT}/automation/release-version.sh"
launchctl print "gui/$(id -u)/com.company.dsh-work.release-watcher"
```

此后发布流程固定为：

1. 开发端提交、推送并通过 CI；此时不会部署。
2. 发布人员在 GitHub Actions 人工运行 **Manual release**，发布新的不可变稳定版本。
3. Mac mini 通常在下一次 300 秒轮询时发现，自动验证 → 停止旧后端并备份 → 验证异机副本 →
   向前迁移 → 切换应用 → 健康检查。不需要每次手工执行 `release.sh`。
4. 查看 `active-release` 和日志，完成该版本的业务验收。

与 AI Hub 的区别仍然保留：AI Hub watcher 只暂存，提升需要其新鲜加密异机备份回执；
dsh-work 自己创建并校验备份，因而可以自动提升。两者不能互用发布脚本或备份回执。

## 11. 日常运维与失败处理

在重新打开的终端先设置第 2 节的实际参数。查看非敏感版本和日志：

```bash
cat "${DWP_ROOT}/active-release"
launchctl print "gui/$(id -u)/com.company.dsh-work.release-watcher"
tail -n 80 "${DWP_ROOT}/logs/release-watcher.stdout.log"
tail -n 80 "${DWP_ROOT}/logs/release-watcher.stderr.log"
tail -n 80 "${DWP_ROOT}/logs/server.stderr.log"
docker compose --env-file "${DWP_ROOT}/runtime.env" \
  -f "${DWP_ROOT}/current/deploy/compose.yaml" \
  -f "${DWP_ROOT}/generated/compose.endpoints.yaml" logs --tail 80 postgres web
```

不要运行会回显完整配置的 `source ...; env`、`set -x` 或 `docker compose config` 后把输出
上传聊天。分享日志前先脱敏。

| 情况 | 处理 |
| --- | --- |
| 需要暂停后续自动升级 | 把 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改为 `false`；不会中止已经开始的部署，等待当前操作结束 |
| Release 验证失败 | 检查 Tag、不可变设置、CI 来源和服务账号 gh 认证，不跳过验证 |
| DSH Lock/ACP 失败 | 核对已安装 checkout、构建、权限与发布包 Lock，单独安排 Runtime 变更 |
| NAS 不可用或备份失败 | 恢复真实异机挂载及权限；不删除备份门禁，不用本机目录替代 |
| 登录报 Issuer/Audience/回调错误 | 对照 AI Hub 当前 `production` 凭据及两个完整 HTTPS 回调，不轮换全平台密钥 |
| 初始管理员登录后无权限 | 检查是否为环境指定的 ACTIVE 业务员工、Bootstrap Scope 和认领状态，不新建第二个应用绕过 |
| `automation/state/blocked-release` 存在 | 说明某版本部署进入变更阶段后失败或被回滚；先排障并优先发布修复版本，不反复清空状态 |

应用回滚前先暂停自动升级，确认没有正在运行的部署/备份，并人工确认旧应用兼容当前数据库
Schema 和宿主机 DSH Lock。在维护窗口选择**不同于当前活动版本**的已知良好版本：

```bash
DWP_ROLLBACK_VERSION='2026.09.06-01' # 示例：必须换成已批准的旧版本
bash "${DWP_ROOT}/current/scripts/deploy/rollback.sh" "${DWP_ROLLBACK_VERSION}" "${DWP_ROOT}"
```

回滚仍会验证 GitHub Release 并执行备份，因此需要 GitHub 可达和 NAS 就绪；不是离线
切软链接。它只回滚应用，不降级数据库，不能用来修复破坏性迁移。备份恢复属于破坏性操作，
需在确认的维护窗口按本文第 12 节执行。

最后安排共享服务器的维护窗口，验证 Mac mini 重启并登录、Docker Desktop 重启后两个
应用都恢复；不要在 AI Hub 业务期间擅自重启整机或 Docker Desktop。制定定时备份、保留、
磁盘/入口/证书告警和证书续期计划；安装 watcher 不会自动配置这些作业。同一证书的两个
项目副本续期后都需要分别更新并生效。

部署交接只记录账号、目录、Release Tag/Commit、DSH Lock、健康/登录/任务/备份与重启
验收结论，不记录密码、Token 或私钥。绝不执行 `docker compose down -v`、删除数据卷，
或覆盖已有 `runtime.env` 来处理部署失败。

## 12. 升级与备份恢复

监听器调用的 `release.sh` 会：

1. 验证不可变 Release、Release 资产、Sigstore 构建来源和 SHA-256，并从已验证归档重新
   建立非活动 Release 目录；
2. 校验 macOS/ARM64、Docker Desktop、Node、证书、AI Hub 生产配置、发布包的 DSH
   Lock，并与宿主机已安装的 DSH 做一次真实 ACP 启动握手；
3. 已有版本时先停止旧后端，并使用旧版本 Compose 生成数据库与持久文件备份；首次部署
   则直接初始化 PostgreSQL；
4. 将备份打包复制到 NAS/异机挂载点，重新校验 SHA-256 并原子写入
   `.verified.json` 回执；只有异机验证成功后才应用候选 PostgreSQL Compose；
5. 执行向前数据库迁移；
6. 原子切换 `current`，安装/重启 `launchd`，重建 Nginx 容器；
7. 从内网 HTTPS 地址执行健康检查；失败时恢复旧应用版本与旧 PostgreSQL Compose 配置。

数据库迁移不会自动降级。因此每次迁移必须保持至少一个版本的向后兼容，确认新版本稳定
后再进行破坏性清理。

自动部署接受新的稳定版本 `vYYYY.MM.DD-NN`；为兼容已发布版本，也保留对旧
`vMAJOR.MINOR.PATCH` Tag 的读取和回滚支持。自动部署只允许升级，不会自动降级。
部署失败的 Tag 会写入 `automation/state/blocked-release`，不会反复重试和制造重复停机；
发布修复版本是首选处理方式。

恢复备份是破坏性操作，脚本要求显式确认，并把原数据目录改名保留：

```bash
bash current/scripts/deploy/restore.sh \
  /Users/deploy/services/dsh-work \
  /Users/deploy/services/dsh-work/backups/20260902T120000Z \
  --confirm
```

如果数据库删除开始后 `pg_restore`、文件解压或服务重建失败，脚本会保持后端和 Nginx
停止，避免空库或半恢复数据对外可见。修复磁盘、备份或数据库问题后，使用同一备份重新
执行恢复命令；不要在恢复未完成时手工启动服务。

每次手工备份和升级备份都会同时保留本机恢复目录，并在
`DSH_WORK_OFF_HOST_BACKUP_DIRECTORY` 创建 `.tar.gz`、`.sha256` 和 `.verified.json`。
异机挂载不可用、与部署目录位于同一文件系统或校验失败时，备份和发布都会在迁移前终止。
该压缩包本身不做应用层加密，因此异机存储必须启用卷级静态加密、最小写权限和独立保留
策略。需要从异机副本恢复时，先在受控临时目录验证 `.sha256` 并解压，再把其中的时间戳
目录传给上述 `restore.sh`；不要跳过恢复演练。


## 13. 多 IP、固定域名与证书

入口配置由 dsh-work 自己管理，不改写 AI Hub 的配置、数据库或网络。两者独立升级、回滚；同机维护仍需协调共同的 Docker Desktop 和宿主机故障域。

1. 在网卡/DNS 上准备实际可达的地址，绑定 IP 必须是本机已分配的 RFC1918 IPv4。生产 Origin 使用完整 HTTPS 协议、主机和端口，不带路径、查询或 Fragment。
2. 在离线运维工作站使用企业 CA 签发覆盖旧、新全部 IP/域名的证书。没有现成 CA 时才使用 `init-intranet-ca.sh` 建立一套。每个项目优先使用独立服务器私钥，CA 私钥不放到 Mac mini。
3. 将服务器证书、私钥、根证书安装到 `runtime.env` 既有路径。私钥权限 `0600`；客户端信任根 CA。切换期间保留旧入口的证书覆盖和可达性。
4. 在 AI Hub 的同一个应用环境登记所有入口的完整回调，每行一个。每个入口不新建应用或凭据；Issuer 保持平台实际签发的固定地址，不随用户访问 Origin 改写。
5. 依次执行 `plan`、`check`、`apply --confirm`。多值配置使用逗号分隔，不手改生成的 Compose。

离线工作站签发示例（将示例域名和目录替换为实际值）：

```bash
bash scripts/deploy/issue-intranet-certificate.sh \
  --ca-dir /absolute/offline/company-ca \
  --ip 192.168.33.20 --ip 192.168.101.20 \
  --dns work.example.com \
  --output-dir /absolute/staging/dsh-work
```

Mac mini 地址预览示例：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh plan \
  --deploy-root /Users/deploy/services/dsh-work \
  --bind-address 192.168.33.20 --bind-address 192.168.101.20 \
  --workbench-origin https://192.168.33.20:4174 \
  --workbench-origin https://192.168.101.20:4174 \
  --admin-origin https://192.168.33.20:4180 \
  --admin-origin https://192.168.101.20:4180 \
  --workbench-default-origin https://192.168.33.20:4174 \
  --admin-default-origin https://192.168.33.20:4180
```

从部署根目录执行；确认预览后保留全部参数，把 `plan` 替换为 `check`；通过后再替换为 `apply` 并追加 `--confirm`。域名入口使用相同的 Origin 参数，默认入口必须属于允许列表。保持员工端 4174、管理端 4180 的当前端口约束。

命令只修改入口字段，保留其他凭据，并复用发布锁。逐个入口验证 HTTPS、登录回调、刷新、退出和写请求；未知 Host/Origin 及跨入口回调应拒绝。`/health` 成功不能替代登录验证。确保后端与 AI Hub 容器均能解析固定认证域名。

恢复上一份地址配置：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh rollback \
  --deploy-root /Users/deploy/services/dsh-work --confirm
```

地址回滚不恢复 DNS、AI Hub 回调或证书文件，需分别核对。域名不变仅改变其 DNS IP 通常无需重签；新增直接访问的 IP/域名必须已在 SAN 中。所有副本续期后分别生效。

旧自签 CA 若曾将私钥放在服务器，应换成离线 CA 签发方案并在客户端完成信任切换；不要沿用服务器持有根私钥的模式。异机备份目录仍为所有发布的前置条件。
