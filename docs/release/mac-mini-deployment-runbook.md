# Mac mini 部署手册

更新时间：2026-11-05（新增第 14 节：钉钉移动端公网员工端入口）

本流程用于在**已经部署 AI Hub、已经安装 DSH 的同一台 Apple Silicon Mac mini** 上，
首次部署 dsh-work。参考 AI Hub 的
[Mac mini 镜像部署文档](https://github.com/tonycc/ai-hub/blob/main/docs/macmini-image-deployment.md)，
所有 dsh-work 命令以本仓库现有部署脚本为准；本文统一维护首次安装、升级、恢复和地址变更。

目标顺序：确认现有环境 → 登记 AI Hub 应用 → 验证并下载 Release → 配置与预检 →
部署指定版本 → 登录和备份验收 → 启用后续自动部署。

本文是操作手册，不代表已经在 Mac mini 上执行或验收。当前已确认的服务器访问基线是
`deploy@192.168.1.99`，服务器报告的 DSH 为 `0.1.2-rc.1`、Commit
`76fda729799fe9b3848dbe2c211d4b231032b81e`。目录、证书、OIDC 凭据和备份挂载仍须在
服务器上按本文核验，不能仅依据示例值认定已经满足条件。
代码保留的 `0.1.1-rc.2` 本地开发兼容模式不适用于本流程，也不能作为服务器降级选项。

## 1. 部署边界与端口

| 组件 | 地址示例 | 本次操作 |
| --- | --- | --- |
| 已有 AI Hub 门户/API | `https://192.168.1.99` | 复用，只登记 dsh-work 应用及凭据 |
| 已有 authentik | `https://192.168.1.99:8443` | 复用，不重装、不直接改蓝图 |
| 已有 AI Hub PostgreSQL | `127.0.0.1:5433` | 不操作 |
| 新增 dsh-work 员工端 | `https://192.168.1.99:4174/workbench` | Nginx 容器提供 HTTPS |
| 新增 dsh-work 管理端 | `https://192.168.1.99:4180/overview` | 同一个 Nginx 容器提供 HTTPS |
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
| Mac mini IP | `192.168.1.99` | 当前部署主机的 RFC1918 私有保留地址 |
| dsh-work 根目录 | `/Users/deploy/services/dsh-work` | 首次安装的新目录；不能是 AI Hub 或 DSH 目录 |
| AI Hub 根目录 | `/Users/deploy/services/ai-hub` | 现有部署的真实目录，只读引用其证书 |
| DSH 安装目录 | `/Users/deploy/services/deepseek-harness` | 已安装且完成构建的独立 checkout |
| DSH 配置目录 | `/Users/deploy/.dsh` | DSH 的独立配置目录（`DSH_HOME`），不是安装目录；模型路由生效后不再需要保存厂商密钥（见 12.2） |
| Node 可执行文件 | `/opt/homebrew/bin/node` | 满足预检要求的真实绝对路径 |
| 异机备份目录 | `/Volumes/dsh-work-backups` | 已挂载、可写、启用加密和访问控制的 NAS/异机存储 |

以下命令在 Mac mini 的一个持续 Bash 会话中**逐段执行**；每段检查成功后再继续，不能把
整篇文档当作一段脚本运行。自动化 Agent 不得读取或回显密钥；需人工编辑配置、登记应用
或批准生产变更时，应交由有权限的人员在本地完成。

从运维终端进入服务器：

```bash
ssh deploy@192.168.1.99
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
DWP_IP='192.168.1.99'
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

1. 确认部署改动已合并到 dsh-work 的 `main`，目标 Commit 的 CI 四个 Job（Static checks and build、Unit tests、PostgreSQL integration tests、Browser tests）全部成功；发布工作流会再次核对。
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
防火墙仅向受信任内网新增放行 **4174、4180**；不要开放 4190、5434 或配置公网转发。启用钉钉移动端时，只按第 14 节为员工端增加经路径白名单的公网入口，管理端、4190 与 5434 仍不上公网。

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
模型厂商密钥不再放在 `DSH_HOME`：部署后由管理员在管理端“模型管理”为默认路由的 Provider 录入
API Key（以 `DSH_CREDENTIAL_MASTER_KEY` 加密保存），模型请求经平台模型网关转发（见 12.2）。不要复制其他人员的
整个 DSH 配置目录，也不能把仅通过握手的环境记录为业务验收通过。

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
| 门户入口 | `https://192.168.1.99:4174/workbench` |
| API 地址 | `https://192.168.1.99:4174/api` |
| 健康检查 | `https://192.168.1.99:4174/health` |
| OIDC 回调地址，第 1 行 | `https://192.168.1.99:4174/auth/workbench/callback` |
| OIDC 回调地址，第 2 行 | `https://192.168.1.99:4180/auth/admin/callback` |
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
| `DSH_WORK_DATA_ROOT` | `<dsh-work 根目录>/data`；`skills/` 保存不可变 Skill 文件夹，必须持久化并与数据库成组备份 |
| `DSH_WORK_DSH_SESSIONS_ROOT` | `<dsh-work 根目录>/data/dsh-sessions`，保持在备份覆盖的数据目录内 |
| `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY` | 已确认的 dsh-work 异机备份目录 |
| `DSH_RUNTIME_HOME`、`DSH_HOME` | 已安装 DSH 的 checkout 路径、其独立配置目录（不再需要厂商密钥） |
| `DSH_CREDENTIAL_MASTER_KEY`、`DSH_CREDENTIAL_MASTER_KEY_ID` | **必填**。`openssl rand -base64 32` 生成一次，与 PostgreSQL 分开备份；模型厂商密钥、MCP Bearer Token、企业知识库 API Key 与钉钉 AppSecret 都以它加密。缺失时模型网关无法解析厂商密钥，所有 Agent 运行以 `MODEL_CREDENTIAL_INVALID` 失败（启动日志有警告）。主密钥丢失后已保存的密钥无法解密，只能重新录入 |
| `DSH_WORK_MODEL_GATEWAY_HOST`、`DSH_WORK_MODEL_GATEWAY_PORT` | 平台模型网关监听地址，保持 `127.0.0.1` 与 `0`（系统分配端口）；只供本机 DSH Worker 访问，不在 Nginx 中暴露。启动日志 `dsh-work model gateway listening on …` 一行给出实际地址 |
| `DSH_EXPECTED_VERSION`、`DSH_EXPECTED_COMMIT` | 生产主 Runtime Lock：`0.1.2-rc.1` 和 `76fda729799fe9b3848dbe2c211d4b231032b81e` |
| `DSH_RUNTIME_COMPATIBILITY` | 必须保持未设置；这是本地开发专用开关 |
| `DSH_WORK_EXECUTION_IMAGE` | **必填**（执行隔离方案 4.9：执行容器为必需）。所有 DSH 子进程、员工侧运行的 `bash` 与 `python_execute` 都在每 Attempt 的执行容器内运行，所有已发布 Agent 的员工侧运行都具备运行命令的能力。镜像须按摘要锁定并通过启动时的工具链检查（必需 `bash`、`rg`、LibreOffice `soffice` 与 `pdftoppm`，`python_execute` 另需 `python3`；服务日志 `execution container toolchain:` 一行列出检查到的工具与版本），服务须以非 root 账号运行，需要 Docker 26 及以上。当前镜像为 `ghcr.io/tonycc/dsh-work/execution@sha256:a59f988be919b4332a79d5a4ad92fff3af542e56cbffbb58dc47bf6be195f42c`（2026-10-27 构建，GHCR 包为公开，无需登录即可拉取）。正式执行镜像由 [执行镜像工作流](../../.github/workflows/execution-image.yml) 从 [deploy/execution-image](../../deploy/execution-image/Dockerfile) 构建、检查并推送 GHCR（附来源证明），运行摘要见该次运行的 Summary；在 Mac mini 上按摘要拉取一次（`docker pull ghcr.io/<owner>/<repo>/execution@sha256:…`，可先用 `gh attestation verify oci://<同一引用> --repo <owner>/<repo>` 核对来源），再把同一引用填入本项。服务以 `--pull never` 运行，不联网拉取；部署预检在镜像未设置、未按摘要锁定或本机不存在时拒绝部署。更换镜像时先拉取新镜像，再部署改了引用的配置。启动检查（含 DSH 工具调度的独占性核对）失败时服务照常启动，但不在宿主执行 DSH：所有 Agent 运行在创建前以“执行容器不可用”失败，`/health` 的 `executionCapabilities.executionContainer` 与管理端 Runtime 页面显示不可用，原因见服务日志；修复后重启服务。Office/PDF 成果的解析文本另由同一镜像的一次性容器（`dsh-py-*`，最多 2 个）生成，失败只记日志；镜像须以 `名称@sha256:` 引用（本地镜像 ID 不能用于解析容器）。运行中的执行容器以 `dsh-exec-*` 命名，启动时与 `dsh-py-*` 一并清扫。每个 Attempt 工作区上限 2 GB；数据卷剩余空间低于 10 GB 或 10% 时不运行命令（`/health` 的 `executionCapabilities.executionContainer.diskLow` 与管理端 Runtime 页面告警）。`<数据根>/dsh-attempts/` 下的 Attempt 工作区在 Attempt 结束后删除（失败的保留 3 天），服务启动后与每 6 小时按同一规则清扫历史目录，`manifest.json` 等元数据文件保留。验收按 [C 档 P2 验收清单](c-tier-p2-acceptance.md) |
| `DSH_WORK_EXECUTION_CONTAINER`、`DSH_WORK_PYTHON_IMAGE`、`DSH_WORK_PYTHON_PACKAGES`、`DSH_WORK_PYTHON_USER`、`DSH_WORK_EXECUTION_MAX_CONTAINERS` | 已删除（执行隔离方案 4.9），从 `runtime.env` 中移除。仍设置时服务只在启动日志提示被忽略；把开关改为 `off` 不会回到宿主执行，需要回退时部署上一个 Release |
| `DSH_WORK_TLS_CERT_FILE`、`DSH_WORK_TLS_KEY_FILE` | `<dsh-work 根目录>/certs/server.crt`、`<dsh-work 根目录>/certs/server.key` |
| `DSH_WORK_CA_CERT_FILE`、`NODE_EXTRA_CA_CERTS` | 两者均为 `<dsh-work 根目录>/certs/root-ca.crt` |
| `DSH_WORK_AUTH_MODE`、`DSH_WORK_COOKIE_SECURE` | 不设置认证模式（禁止 `prototype`）、`true`；AI Hub 按接入配置自动可用 |
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
恢复验收必须抽查 `${DSH_WORK_DATA_ROOT}/skills/packages` 中的文件夹能够按数据库中的
`artifact_ref` 找到并通过摘要校验；只恢复数据库或只恢复数据目录都会造成 Skill 不可执行。

### 9.4 目标环境部署验收

完成 9.1～9.3 后，按 [PF-07 手册的目标环境部署验收清单](../development/pf07-platform-acceptance.md#目标环境部署验收) 逐项检查并留证。首次部署和之后的每次发布都要执行；恢复演练只在隔离环境进行，不在本机运行 `restore.sh`。清单完成前，不在该环境开放新版本带来的新能力；已开放的能力继续运行并按发布问题跟踪，清单未通过时回退版本或停用相关 Agent；需要先验收后安装的环境应关闭自动部署。交接记录须包含清单结论、Run/Attempt 引用和证据位置。

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
4. 查看 `active-release` 和日志，按 9.4 节完成该版本的部署验收。watcher 没有等待验收的拦截点，新版本会先被安装；需要先验收后安装时，保持 `DSH_WORK_AUTO_DEPLOY_ENABLED=false` 并人工升级。

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
切软链接。它只回滚应用，不降级数据库，不能用来修复破坏性迁移；破坏性迁移之后要先恢复发布前备份。备份恢复属于破坏性操作，
需在确认的维护窗口按本文第 12 节执行。

最后安排共享服务器的维护窗口，验证 Mac mini 重启并登录、Docker Desktop 重启后两个
应用都恢复；不要在 AI Hub 业务期间擅自重启整机或 Docker Desktop。制定定时备份、保留、
磁盘/入口/证书告警和证书续期计划；安装 watcher 不会自动配置这些作业。同一证书的两个
项目副本续期后都需要分别更新并生效。

部署交接只记录账号、目录、Release Tag/Commit、DSH Lock、健康/登录/任务/备份与重启
验收结论，以及 9.4 节要求的清单结论、Run/Attempt 引用和证据位置，不记录密码、Token 或私钥。绝不执行 `docker compose down -v`、删除数据卷，
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
7. 从内网 HTTPS 地址执行健康检查。迁移未改动数据库（全部 `skipped`）时，失败会恢复旧应用
   版本与旧 PostgreSQL Compose 配置；本次实际执行了迁移（输出含 `applied`）时，旧版本可能读取
   已删除的表或列，脚本不再自动拉起旧版本，而是保持服务停止并提示处理方式（fail-closed）。

数据库迁移不会自动降级。因此每次迁移必须保持至少一个版本的向后兼容，确认新版本稳定
后再进行破坏性清理。包含删除表或列的版本（例如 0083、0085、0087 移除委派、旧发布记录与
Agent 数据平面）不具备向后兼容，发布前必须确认第 3～4 步的备份已异机校验；迁移后失败只有两条
路：发布修复版本向前修复，或在维护窗口用本次发布前的备份执行 `restore.sh` 恢复数据库，
再用 `rollback.sh` 回到旧应用版本。不要在新 Schema 上手工启动旧版本。

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


### 12.1 为脚本型 Skill 增加 Python 包

脚本型 Skill 只能使用执行镜像中已安装的 Python 包，运行时不联网安装。平台在安装、提交与发布时核对 Skill 的依赖：`requirements.txt` 声明的包，以及脚本中 import 的标准库以外的模块（未声明的按镜像中的“模块 → 包”对应关系识别）。镜像里没有时安装计划不兼容。需要新包时：

1. 在仓库 [deploy/execution-image/requirements.in](../../deploy/execution-image/requirements.in) 添加包名，按该文件顶部注释的 `uv pip compile` 命令重新生成带哈希的 `requirements.lock`，提交 PR；[执行镜像工作流](../../.github/workflows/execution-image.yml)在 PR 中构建并跑冒烟检查，合入 `main` 后推送 GHCR，新摘要见该次运行的 Summary。
2. 在 Mac mini 上按摘要拉取新镜像，把 `runtime.env` 中的 `DSH_WORK_EXECUTION_IMAGE` 改为新引用，按第 8 节部署（或重启服务）。
3. 服务启动时会用新镜像复查所有已发布 Skill 的依赖：缺包的 Skill 记入服务日志（`skill python dependencies missing in execution image`），在管理端 Skill 列表标“依赖缺失”；员工直接选用时在运行前被拒绝，固定引用它的 AI 同事本次不装配它、其余照常。去掉包之前先确认没有已发布 Skill 依赖它。
4. 镜像摘要是脚本型 Skill 试运行证据的一部分：换镜像后，待发布的脚本型 Skill 版本须重新严格试运行才能发布；已发布且依赖仍满足的版本不受影响。

### 12.2 模型路由生效（MR-S2 + DLP-S1）的升级步骤

首次升级到模型路由生效的版本时（迁移 `0121_model_gateway_requests`），执行模型改为“平台默认路由 + 平台模型网关”，DSH 不再使用 `DSH_HOME` 中的厂商密钥：

1. 确认 `runtime.env` 已配置 `DSH_CREDENTIAL_MASTER_KEY`（见第 7 节参数表）；
2. 升级前在 Runtime 页面把调度切换为排空，等待执行中的 Attempt 结束。升级前创建、缺少路由快照的 Attempt 在升级后执行时会以 `MODEL_ROUTE_UNAVAILABLE` 失败，包括已排队未开始的 Attempt 与等待审批的恢复（批准后新建的 Attempt 沿用来源快照）；员工重新执行即可，待审批的操作在升级前处理完或升级后重新发起；
3. 升级后在管理端“模型管理”为默认路由的 Provider 点击“密钥”录入 API Key。列表显示“需录入 API Key”的 Provider 仍是旧的 DSH 受管引用，模型网关无法使用；录入前所有 Agent 运行以 `MODEL_CREDENTIAL_INVALID` 失败；
4. 发一条员工对话确认成功，再把 Runtime 调度恢复为接受；
5. 确认无误后可以从 `DSH_HOME` 移除 DeepSeek 密钥（工具目录探测与 MCP 连接检查不发出模型请求，不受影响）。

联网搜索只在默认路由的 Provider 为 DeepSeek 官方时可用；更换为其他厂商后，开启联网搜索的 AI 同事本轮不装配该工具，并在回答中说明暂时不可用。

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
  --ip 192.168.1.99 --ip 192.168.101.20 \
  --dns work.example.com \
  --output-dir /absolute/staging/dsh-work
```

Mac mini 地址预览示例：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh plan \
  --deploy-root /Users/deploy/services/dsh-work \
  --bind-address 192.168.1.99 --bind-address 192.168.101.20 \
  --workbench-origin https://192.168.1.99:4174 \
  --workbench-origin https://192.168.101.20:4174 \
  --admin-origin https://192.168.1.99:4180 \
  --admin-origin https://192.168.101.20:4180 \
  --workbench-default-origin https://192.168.1.99:4174 \
  --admin-default-origin https://192.168.1.99:4180
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

## 14. 钉钉移动端：公网员工端入口与钉钉应用（DT-S1）

依据[钉钉接入方案](../design/dingtalk-integration-plan.md) 4.3 与 8.3（DT2、DT24）。本节是 DT-S1 上线前的操作清单，**不代表已在生产执行或验收**；真实钉钉验收（DT-P2）按发布流程单独留证。第 4.1 节“不要配置公网转发”对内网 4174、4180 仍然有效：公网只开放本节的员工端入口，管理端（4180）、服务端口（4190）与数据库（5434）保持内网。

### 14.1 上线前必须确认

1. **安全基线（方案 8.3）已定：** 登录与免登接口按 IP 与账号限流、连续失败锁定（应用内已按账号与钉钉 userid 限流，**按 IP 限流在公网反向代理上配置**，见 14.3）；访问日志与异常登录告警；是否另加 WAF 或网关 IP 控制。员工首次在钉钉内绑定需要公网上的账号密码登录，网关不能只放行免登。
2. **AI Hub 静默回退检查：** 只要 `runtime.env` 中配置了 `AI_HUB_PLATFORM_URL`、`AI_HUB_OIDC_ISSUER`、`AI_HUB_APPLICATION_ID`、`AI_HUB_CLIENT_ID`、`AI_HUB_CLIENT_SECRET`（含 `WORKBENCH_`/`ADMIN_` 前缀的同名变量）中任一项，启动就会尝试 AI Hub（OIDC）配置；`AI_HUB_*_PORTAL_URL`、`AI_HUB_*_REDIRECT_URI` 由入口脚本维护，不会单独触发。OIDC 要求所有员工端 origin 与 `DSH_WORK_WORKBENCH_PORT` 同端口。端口不一致（例如 443 的公网 origin）时**不会报错，而是静默回退为本地模式并关闭 AI Hub 登录**（`loadStartupIdentityConfiguration`，启动日志只有一行 `AI Hub 登录未启用：…`）。本节的公网入口使用 4174 端口（14.2），不触发回退；若以后改用 443，须先从 `runtime.env` 删除上述 AI Hub 接入变量（组织架构方案 OD1 计划删除 AI Hub），否则 AI Hub 登录会被静默关闭。上线后检查启动日志没有 `AI Hub 登录未启用`，并在桌面端确认登录页的 AI Hub 入口与预期一致。
3. **钉钉企业内部应用已创建**，并按方案 8.1“DT-S1 钉钉后台配置清单”完成配置（14.4）。

### 14.2 域名、证书与 origin

1. 申请员工端独立域名（例如 `m.<企业域名>`），网关对外使用**公网受信证书**（钉钉客户端不信任企业自签根证书）。证书只覆盖员工端域名，不覆盖管理端。
2. **公网入口使用 4174 端口：** `https://m.example.com:4174`。当前入口脚本（`set-macmini-endpoints.sh`、`render-endpoint-compose.mjs`）要求所有员工端 origin 使用 `DSH_WORK_WORKBENCH_PORT`（4174），并把各 origin 的主机名生成为 4174 Nginx 的 `server_name`；端口一致也满足 AI Hub 的同端口校验（14.1 第 2 项）。改用 443 需要先扩展入口脚本对公网 origin 的端口规则，属于后续工作，不能只改 `runtime.env` 绕过。
3. **Mac mini 侧的两项前置（缺一项入口脚本就会失败）：**
   - **内网证书加入公网域名：** `check` 调用的 `preflight.sh` 要求内网服务器证书含每个 origin 主机名的 DNS SAN。按第 13 节在离线工作站重签，追加 `--dns m.example.com`，安装到 `runtime.env` 既有路径。这张证书只供网关到 Mac mini 这一跳使用，员工看到的是网关的公网证书。
   - **Mac mini 把公网域名解析到本机：** `apply` 会用内网根证书逐个请求 `<origin>/health`。在 Mac mini 上配置内网 DNS（分区解析）或 `/etc/hosts`，使 `m.example.com` 指向 `192.168.1.99`，这些检查才会到达本机 4174 Nginx，而不是公网网关（网关不转发 `/health`，证书也不是企业根证书签发）。
4. 用入口脚本把公网 origin 追加到员工端（保留全部现有参数，先 `plan`、再 `check`、最后 `apply --confirm`，见第 13 节）：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh plan \
  --deploy-root /Users/deploy/services/dsh-work \
  --bind-address 192.168.1.99 \
  --workbench-origin https://192.168.1.99:4174 \
  --workbench-origin https://m.example.com:4174 \
  --admin-origin https://192.168.1.99:4180 \
  --workbench-default-origin https://192.168.1.99:4174 \
  --admin-default-origin https://192.168.1.99:4180
```

   这会同时更新 `DSH_WORK_WORKBENCH_ORIGINS` 与 4174 Nginx 的 `server_name`。管理端 origin 不变。
5. 钉钉 H5 微应用把公网 origin 作为“首页地址”和“可信域名”，见 14.4。

### 14.3 反向代理：只转发员工端，`/auth/workbench/` 按路径白名单

公网网关（企业网关或独立 Nginx，不在 Mac mini 上）对外监听 `m.example.com:4174`，终止 TLS 后反代到 Mac mini 的员工端 Nginx（`https://192.168.1.99:4174`）。必须：

- **保留原始 Host（`m.example.com:4174`）：** 4174 Nginx 按它匹配 `server_name` 并写入 `X-Forwarded-Host`，后端据此确认请求来自已登记的公网 origin；改写成内网地址会让登录与写请求的来源校验失败（403），未登记的 Host 返回 421；
- 只转发员工端页面、`/api/workbench/`，以及 `/auth/workbench/` 下**显式列出**的路径；不转发 `/api/admin/`、`/auth/admin/`、`/health*`，也不整段转发 `/auth/`；
- 对登录与免登接口按真实客户端 IP 限流（应用内不按连接地址限流：反向代理后所有请求共享一个地址）。同一办公网出口或运营商 NAT 后的员工共用一个 IP，额度按“整个办公室”估算：钉钉会话 12 小时过期后，早上上班时会集中免登。下例给免登单独的宽松额度，密码登录额度稍紧；上线后按访问日志调整，账号级的连续失败锁定仍由应用负责；
- `/api/workbench/` 关闭缓冲（事件流需要）。

Nginx 示例（域名、证书路径与上游地址按实际替换；上游证书由企业根 CA 签发，含公网域名的 DNS SAN）：

```nginx
# 按客户端 IP；NAT 后多人共用，额度按办公室规模调整。
limit_req_zone $binary_remote_addr zone=dsh_work_password:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=dsh_work_dingtalk:10m rate=300r/m;

upstream dsh_work_workbench {
  server 192.168.1.99:4174;
  keepalive 16;
}

server {
  listen 4174 ssl;
  server_name m.example.com;
  ssl_certificate     /etc/nginx/tls/m.example.com.fullchain.pem;
  ssl_certificate_key /etc/nginx/tls/m.example.com.key;

  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "same-origin" always;
  client_max_body_size 50m;

  proxy_ssl_trusted_certificate /etc/nginx/tls/dsh-work-root-ca.crt;
  proxy_ssl_verify on;
  proxy_ssl_name m.example.com;   # 内网证书已含该 DNS SAN（14.2 第 3 项）
  proxy_ssl_server_name on;

  # 认证：只放行登录、钉钉免登、绑定登录、改密、退出与配置查询。
  location = /auth/workbench/configuration       { proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location = /auth/workbench/login               { limit_req zone=dsh_work_password burst=30 nodelay; proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location = /auth/workbench/dingtalk/login      { limit_req zone=dsh_work_dingtalk burst=100 nodelay; proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location = /auth/workbench/dingtalk/bind-login { limit_req zone=dsh_work_password burst=30 nodelay; proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location = /auth/workbench/password            { limit_req zone=dsh_work_password burst=30 nodelay; proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location = /auth/workbench/logout              { proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
  location /auth/ { return 404; }

  location /api/workbench/ {
    proxy_pass https://dsh_work_workbench;
    include /etc/nginx/dsh-work-public-proxy;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
  location /api/ { return 404; }
  location /health { return 404; }

  # 员工端页面（单页应用）。
  location / { proxy_pass https://dsh_work_workbench; include /etc/nginx/dsh-work-public-proxy; }
}
```

`/etc/nginx/dsh-work-public-proxy`：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Connection "";
```

AI Hub 登录（`/auth/workbench/oidc/*`、`/auth/workbench/callback`）与切换账号不在公网白名单内；钉钉内只用账号密码与钉钉免登。仍配置 AI Hub 时，公网登录页会显示“使用 AI Hub 账号登录”，点击后得到网关的 404；公网上线前最好按组织架构方案 OD1 停用 AI Hub，或接受这一入口在公网不可用。示例已在固定版本的 Nginx 镜像中做过语法检查与路径白名单探测（允许的路径带原始 Host 转发、其余返回 404、登录接口超限返回 503）；实际网关上线前仍须按 14.5 验证。

### 14.4 钉钉企业内部应用与服务端配置

1. 在钉钉开放平台创建**企业内部应用**，开通 H5 微应用：首页地址为公网员工端（例如 `https://m.example.com:4174/c/chats`），可信域名为 `m.example.com:4174`（以开发者后台对端口的要求为准，P2 确认）。
2. 按方案 8.1 开通权限：免登（默认）、工作通知（默认，DT-S2 使用）、根据手机号获取成员基本信息、成员信息读权限、通讯录部门信息读权限；**通讯录权限范围设为“全部员工”**。不申请“企业员工手机号信息”与“邮箱等个人信息”。开始前在开发者后台逐项核对权限当前名称，与方案不同以后台为准并回写方案。
3. 在“服务器出口 IP”登记 Mac mini 的公网出口 IP；服务器出站放行 `oapi.dingtalk.com:443`（与出口 IP 白名单是两件事）。
4. 确认 `runtime.env` 已配置凭据主密钥 `DSH_CREDENTIAL_MASTER_KEY`（与 MCP Bearer Token、企业知识库 API Key 共用；没有时生成 `openssl rand -base64 32` 写入并重启后端）。没有主密钥时页面不能保存 AppSecret。
5. 平台管理员在管理端“钉钉集成 › 应用配置”点“填写配置”：填写 CorpId、AgentId、AppKey、AppSecret，按需调整钉钉会话有效期（默认 12 小时）、待绑定凭证有效期（默认 5 分钟）、每位管理员每日代绑上限（默认 50）与接口超时（默认 10 秒），点“验证并保存”。服务端先用这组凭据向钉钉换取 access_token，失败（凭据错误、出口 IP 未登记）不保存；成功后 AppSecret 加密保存、不再显示，配置立即生效，无需重启。

   已在 `runtime.env` 设置 `DSH_WORK_DINGTALK_*` 的环境：它们只在页面从未保存过时作为初始配置（页面显示“部署配置”），页面保存或清除后不再生效，之后可从 `runtime.env` 删除。钉钉开放平台地址 `DSH_WORK_DINGTALK_API_BASE_URL` 只能由部署配置决定，生产保持默认。

### 14.5 上线验证（DT-P2 的前置检查）

1. 管理端“钉钉集成”：应用配置显示 CorpId、AgentId 与配置来源，“钉钉内入口”列出公网 origin；“重新检查连接”后凭据与各项接口权限为“已开通”。“配置异常”时按提示检查权限、通讯录范围与出口 IP。
2. 公网入口：`curl -sS -o /dev/null -w '%{http_code}\n' https://m.example.com:4174/auth/admin/configuration` 返回 404；`/api/admin/v1/session` 返回 404；`/auth/workbench/configuration` 返回 200 且含 `dingtalk.corpId`。
3. 用未登记的 Host 访问后端返回 421；跨站 `Origin` 的登录请求返回 403。
4. 启动日志没有 `AI Hub 登录未启用`（或确认这是预期的本地模式）。
5. 在 iOS 与 Android 钉钉中从工作台打开 dsh-work：未绑定时显示“当前钉钉账号”与“登录并绑定”，登录后进入协作模式；再次打开免登。按 `e2e/catalog/dingtalk.md` 的 DT-P2 记录真机结果（返回键、软键盘、上传下载、安全区）。

回退：网关先撤下公网入口；用 `set-macmini-endpoints.sh` 去掉公网 origin（`plan`、`check`、`apply --confirm`，参数中不再包含 `https://m.example.com:4174`），或在刚变更后用 `rollback --confirm` 恢复上一份入口配置——不要手改 `DSH_WORK_WORKBENCH_ORIGINS`，否则与生成的 Nginx `server_name` 不一致；再在“钉钉集成 › 应用配置”点“清除配置”（删除已加密的 AppSecret，立即生效）。已写入的绑定记录保留，钉钉免登接口返回“未启用”。

## 15. 企业知识库（WeKnora）连接

设计见[企业知识库接入 WeKnora 方案](../design/weknora-knowledge-plan.md)与[企业知识库优化方案](../design/weknora-knowledge-optimization-plan.md)。连接在管理端“知识库 → 企业知识库 → 连接配置”中维护。

### 15.1 上线前必须确认

1. **API Key 只给最小能力。** 在 WeKnora 中为平台专用工作空间单独创建 Key，能力只勾 `retrieve`、`ingest`、`manage_kbs`，不设知识库白名单，设置到期时间。不要复用全权限或带 `manage_models`、`chat` 等能力的 Key。
2. **WeKnora 中登记的全部模型都在内网。** 包括嵌入模型、重排序模型，以及摘要、问答等对话模型。平台建库不设摘要模型，但在 WeKnora 前端修改知识库时可以设置，设置后入库会把文档内容发给该模型。WeKnora 前端只供运维使用，不要为平台创建的知识库设置摘要模型、问题生成、图谱抽取或多模态模型；管理端会标出“已配置摘要模型”的知识库。
3. **重排序模型可达。** WeKnora 出站访问模型服务受 SSRF 检查约束，模型主机解析到内网或代理虚拟地址（如 198.18.0.0/15）时须加入 WeKnora 的 `SSRF_WHITELIST`。上线后在管理端健康状态确认“最近重排序”不是“模型不可用”或“调用失败”。

### 15.2 查看统一嵌入模型 ID

“统一嵌入模型 ID”填 WeKnora 中模型记录的 ID（UUID），不是模型名称。填成名称时新建知识库仍会成功，但上传的文档全部解析失败（`model not found`）。任选一种方法查看：

- 在 WeKnora 前端“设置 → 模型管理”页打开浏览器开发者工具的网络面板，刷新后在 `models` 请求的响应里找 `type` 为 `Embedding` 的记录，复制 `id`。
- 在 WeKnora 的数据库中查询（容器名按实际部署）：

```bash
docker exec WeKnora-postgres psql -U postgres -d WeKnora -c "select id, name, type from models where deleted_at is null;"
```

只能填 `type` 为 `Embedding` 的那一行。平台的最小能力 Key 读不到模型列表，因此管理端不提供下拉选择。

### 15.3 更换 WeKnora 地址

更换地址（或部署配置中的 `WEKNORA_BASE_URL`）后，原有知识库标为“原连接已更换”，不再参与检索、员工端不显示。新地址只是同一实例的另一个访问地址，或已把数据迁到新实例时，在“全部知识库”中逐个点“恢复”：平台会先确认新地址的 WeKnora 中存在该知识库。
