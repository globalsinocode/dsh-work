# Mac mini 部署手册

更新时间：2026-11-20（新增 12.3 节外部业务应用调用上下文，迁移 0131）；2026-11-16（删除 AI Hub 登录：第 5 节改为账号说明，首位管理员改由 `local-bootstrap.js` 初始化；新增 12.2 节升级步骤；删除已执行的模型路由升级步骤）

本流程用于在**已经安装 DSH 的 Apple Silicon Mac mini** 上首次部署 dsh-work。
所有 dsh-work 命令以本仓库现有部署脚本为准；本文统一维护首次安装、升级、恢复和地址变更。
dsh-work 不依赖同机的其他服务；同一台机器若还运行其他应用，只需避开端口冲突、互不改动对方的目录与数据。

目标顺序：确认现有环境 → 验证并下载 Release → 配置与预检 →
部署指定版本 → 初始化管理员、登录和备份检查 → 启用后续自动部署。

本文是操作手册，不代表已经在 Mac mini 上执行或验收。当前已确认的服务器访问基线是
`deploy@192.168.1.99`，服务器报告的 DSH 为 `0.1.2-rc.1`、Commit
`76fda729799fe9b3848dbe2c211d4b231032b81e`。目录、证书和备份挂载仍须在
服务器上按本文核验，不能仅依据示例值认定已经满足条件。
代码保留的 `0.1.1-rc.2` 本地开发兼容模式不适用于本流程，也不能作为服务器降级选项。

## 1. 部署边界与端口

| 组件 | 地址示例 | 本次操作 |
| --- | --- | --- |
| 新增 dsh-work 员工端 | `https://192.168.1.99:4174/workbench` | Nginx 容器提供 HTTPS |
| 新增 dsh-work 管理端 | `https://192.168.1.99:4180/overview` | 同一个 Nginx 容器提供 HTTPS |
| 新增 dsh-work 后端 | `127.0.0.1:4190` | 宿主机 Node 模块化单体，由 launchd 管理 |
| 新增 dsh-work PostgreSQL | `127.0.0.1:5434` | 独立 Compose 项目 `dsh-work` 和数据卷 |
| 已有 DSH | 宿主机固定版本的独立安装目录 | 后端通过 stdio 启动；不随应用自动升级 |

dsh-work 不是纯镜像部署。其前后端及生产依赖由 GitHub
构建为 Release 压缩包；Mac mini 不需要克隆或编译 dsh-work，但仍需保留已安装 DSH 的
独立 Git checkout、依赖及构建产物。无需新增 Linux VM、K8s、微服务或生产 Self-hosted Runner。

HTTPS 使用企业内网根 CA 签发的服务器证书（含 Mac mini IP 的 SAN）。dsh-work 保存证书的
独立副本；CA 私钥不放到 Mac mini，也不要复制其他应用的数据库或备份密钥。

## 2. 准备非敏感参数

由部署人员确认以下值。使用运行 Docker Desktop 的普通 macOS 服务账号；不是开发电脑上
恰好同名的目录，也不是 `root`。DSH 必须能被该账号读取和执行，其凭据目录也必须可用。

| 参数 | 示例 | 确认方式 |
| --- | --- | --- |
| 仓库 | `tonycc/dsh-work` | dsh-work 的公开 GitHub 仓库 |
| Release Tag | `v2026.09.07-01` | 管理员批准的、已发布的不可变 Release，格式为 `vYYYY.MM.DD-NN` |
| Mac mini IP | `192.168.1.99` | 当前部署主机的 RFC1918 私有保留地址 |
| dsh-work 根目录 | `/Users/deploy/services/dsh-work` | 首次安装的新目录；不能是 DSH 或其他应用的目录 |
| 证书来源目录 | `/Users/deploy/certs-staging` | 部署人员交接的 `server.crt`、`server.key`、`root-ca.crt` 所在目录，只读引用 |
| DSH 安装目录 | `/Users/deploy/services/deepseek-harness` | 已安装且完成构建的独立 checkout |
| DSH 配置目录 | `/Users/deploy/.dsh` | DSH 的独立配置目录（`DSH_HOME`），不是安装目录；不保存模型厂商密钥（由管理端录入，见 4.2） |
| Node 可执行文件 | `/opt/homebrew/bin/node` | 满足预检要求的真实绝对路径 |
| 异机备份目录 | `/Volumes/dsh-work-backups` | 已挂载、可写、启用加密和访问控制的 NAS/异机存储 |

以下命令在 Mac mini 的一个持续 Bash 会话中**逐段执行**；每段检查成功后再继续，不能把
整篇文档当作一段脚本运行。自动化 Agent 不得读取或回显密钥；需人工编辑配置、初始化管理员
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
DWP_CERT_SOURCE='/Users/deploy/certs-staging'
DWP_RUNTIME_HOME='/Users/deploy/services/deepseek-harness'
DWP_DSH_HOME='/Users/deploy/.dsh'
DWP_NODE='/opt/homebrew/bin/node'
DWP_OFFHOST='/Volumes/dsh-work-backups'

[[ "${DWP_REPOSITORY}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "${DWP_TAG}" =~ ^v[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])-[0-9]{2}$ ]]
[[ "${DWP_ROOT}" == "/Users/$(id -un)/"* ]]
[[ "${DWP_ROOT}" != "${DWP_RUNTIME_HOME}" ]]
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

缺少工具时由运维补齐。已安装的 Docker Desktop 和 GitHub CLI 可以复用；dsh-work
运行需要额外确认 Git、Node 和已构建 DSH，不需要为运行发布包再安装 pnpm。
GitHub CLI 必须在这个服务账号下认证，具备读取 dsh-work 内容和来源证明的权限；不要把令牌
粘贴到对话、命令参数或 `runtime.env`。

服务器出站还需能访问 GitHub API、Release 资产/来源证明服务，以及 Compose 中固定
PostgreSQL/Nginx 镜像所在的 Docker Hub。能从 GHCR 拉取镜像不代表 Docker Hub
也一定可达；网络受限时先由运维确认出站策略，不能改用未经验证的镜像来绕过。

确认服务账号保持图形登录会话、Docker Desktop 登录后自动启动、Mac mini 不自动睡眠，且
磁盘除同机其他应用用量外仍有足够余量；脚本最低要求部署盘空闲 5 GiB，这不是生产容量规划值。
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

其他端口被同机其他应用占用是正常现象，不能为 dsh-work 停掉占用这些端口的容器。

### 4.2 证书、备份和 DSH

```bash
test -r "${DWP_CERT_SOURCE}/server.crt"
test -r "${DWP_CERT_SOURCE}/server.key"
test -r "${DWP_CERT_SOURCE}/root-ca.crt"
[[ ! -e "${DWP_CERT_SOURCE}/root-ca.key" ]]
[[ ! -e "${DWP_CERT_SOURCE}/internal-ca.key" ]]

openssl verify -CAfile "${DWP_CERT_SOURCE}/root-ca.crt" "${DWP_CERT_SOURCE}/server.crt"
openssl x509 -in "${DWP_CERT_SOURCE}/server.crt" -noout -text | grep -F "IP Address:${DWP_IP}"

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

服务器证书须由该根 CA 签发并含 Mac mini IP；DSH tracked files 必须干净。当前 DSH 锁定版本为 `0.1.2-rc.1`、
Commit 为 `76fda729799fe9b3848dbe2c211d4b231032b81e`；第 8 节会用目标发布包再次
进行严格比对和真实 ACP 握手。“已经安装 DSH”不等于版本一定兼容；不一致时先停止并按
[Runtime 交付基线](dsh-runtime-delivery.md)安排独立升级，不能在现有目录直接拉取最新版。
模型厂商密钥不再放在 `DSH_HOME`：部署后由管理员在管理端“模型管理”为默认路由的 Provider 录入
API Key（以 `DSH_CREDENTIAL_MASTER_KEY` 加密保存），模型请求经平台模型网关转发；录入前所有 Agent 运行以 `MODEL_CREDENTIAL_INVALID` 失败。联网搜索只在默认路由的 Provider 为 DeepSeek 官方时可用。不要复制其他人员的
整个 DSH 配置目录，也不能把仅通过握手的环境记录为业务验收通过。

备份目录必须确实位于 NAS/另一台机器。可在已有的异机挂载卷中准备 dsh-work
独立子目录，但不能与其他应用混用备份文件或回执。禁止用 `mkdir /Volumes/...` 创建本机空目录假装
已挂载；预检还会拒绝与部署根目录在同一文件系统的路径。不同本地分区或 USB 盘也不等于异机。

若服务账号不能读取证书来源目录，由管理员把三个证书文件安全交接到独立暂存目录，再
修改 `DWP_CERT_SOURCE`；不要放宽其他应用配置目录的权限。发现 CA 私钥留在服务器
时停止部署，按证书安全流程处理；不要复制它，也不要关闭 TLS 验证。

## 5. 账号与登录

dsh-work 只使用自己的独立账号登录（员工端在钉钉客户端内另可免登，见第 14 节），部署不需要
登记任何外部身份应用，`runtime.env` 也不需要身份平台凭据。首位平台管理员在部署成功后按
第 9.2 节用 `local-bootstrap.js` 初始化，之后的员工账号都由管理员在“员工与权限”开通。
账号规则见 [独立账号登录](local-authentication.md)。

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
需要创建新 CA。客户端若已信任该根 CA，也不需要再次安装另一套根证书。

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
| `DSH_WORK_POSTGRES_DB`、`DSH_WORK_POSTGRES_USER` | 两者均为 `dsh_work`，与同机其他应用的数据库独立 |
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
| `DSH_WORK_EXECUTION_IMAGE` | **必填**（执行隔离方案 4.9：执行容器为必需）。所有 DSH 子进程、员工侧运行的 `bash` 与 `python_execute` 都在每 Attempt 的执行容器内运行，所有已发布 Agent 的员工侧运行都具备运行命令的能力。镜像须按摘要锁定并通过启动时的工具链检查（必需 `bash`、`rg`、LibreOffice `soffice` 与 `pdftoppm`，`python_execute` 另需 `python3`；服务日志 `execution container toolchain:` 一行列出检查到的工具与版本），服务须以非 root 账号运行，需要 Docker 26 及以上。当前镜像为 `ghcr.io/tonycc/dsh-work/execution@sha256:a59f988be919b4332a79d5a4ad92fff3af542e56cbffbb58dc47bf6be195f42c`（2026-10-27 构建，GHCR 包为公开，无需登录即可拉取）。正式执行镜像由 [执行镜像工作流](../../.github/workflows/execution-image.yml) 从 [deploy/execution-image](../../deploy/execution-image/Dockerfile) 构建、检查并推送 GHCR（附来源证明），运行摘要见该次运行的 Summary；在 Mac mini 上按摘要拉取一次（`docker pull ghcr.io/<owner>/<repo>/execution@sha256:…`，可先用 `gh attestation verify oci://<同一引用> --repo <owner>/<repo>` 核对来源），再把同一引用填入本项。服务以 `--pull never` 运行，不联网拉取；部署预检在镜像未设置、未按摘要锁定或本机不存在时拒绝部署。更换镜像时先拉取新镜像，再部署改了引用的配置。启动检查（含 DSH 工具调度的独占性核对）失败时服务照常启动，但不在宿主执行 DSH：所有 Agent 运行在创建前以“执行容器不可用”失败，`/health` 的 `executionCapabilities.executionContainer` 与管理端 Runtime 页面显示不可用，原因见服务日志；修复后重启服务。服务运行中执行镜像被删除（例如清理 Docker 腾空间）时，`/health` 与管理端约 15 秒内转为“不可用”，新的 Agent 运行在创建前被拒绝，服务日志记录 `execution image is missing`；按摘要重新拉取同一镜像后自动恢复，无需重启。只有 docker 明确答复镜像不存在才按缺失处理；检查本身超时或出错时保留上一次结论并记录 `execution image check failed`。Office/PDF 成果的解析文本另由同一镜像的一次性容器（`dsh-py-*`，最多 2 个）生成，失败只记日志；镜像须以 `名称@sha256:` 引用（本地镜像 ID 不能用于解析容器）。运行中的执行容器以 `dsh-exec-*` 命名，启动时与 `dsh-py-*` 一并清扫。每个 Attempt 工作区上限 2 GB；数据卷剩余空间低于 10 GB 或 10% 时不运行命令（`/health` 的 `executionCapabilities.executionContainer.diskLow` 与管理端 Runtime 页面告警）。`<数据根>/dsh-attempts/` 下的 Attempt 工作区在 Attempt 结束后删除（失败的保留 3 天），服务启动后与每 6 小时按同一规则清扫历史目录，`manifest.json` 等元数据文件保留。C 档 P2 已于 2026-10-28 验收通过，复验运行随 Release 发布的 `scripts/acceptance/c-tier-p2.mjs` |
| `DSH_WORK_EXECUTION_CONTAINER`、`DSH_WORK_PYTHON_IMAGE`、`DSH_WORK_PYTHON_PACKAGES`、`DSH_WORK_PYTHON_USER`、`DSH_WORK_EXECUTION_MAX_CONTAINERS` | 已删除（执行隔离方案 4.9），从 `runtime.env` 中移除。仍设置时服务只在启动日志提示被忽略；把开关改为 `off` 不会回到宿主执行，需要回退时部署上一个 Release |
| `DSH_WORK_TLS_CERT_FILE`、`DSH_WORK_TLS_KEY_FILE` | `<dsh-work 根目录>/certs/server.crt`、`<dsh-work 根目录>/certs/server.key` |
| `DSH_WORK_CA_CERT_FILE`、`NODE_EXTRA_CA_CERTS` | 两者均为 `<dsh-work 根目录>/certs/root-ca.crt` |
| `DSH_WORK_AUTH_MODE`、`DSH_WORK_COOKIE_SECURE` | 不设置认证模式（禁止 `prototype`）、`true` |
| `DSH_WORK_SESSION_SECRET` | 另一份独立高熵随机值，至少 32 字符，不与数据库密码共用 |
| `DSH_WORK_WORKBENCH_ORIGINS`、`DSH_WORK_ADMIN_ORIGINS` | 初次分别填 `https://<Mac mini IP>:4174`、`https://<Mac mini IP>:4180`；后续可追加已批准 IP/域名 Origin |
| `DSH_WORK_WORKBENCH_DEFAULT_ORIGIN`、`DSH_WORK_ADMIN_DEFAULT_ORIGIN` | 初次与上述单入口相同；启用固定域名后可改为相应域名 Origin |
| `DSH_WORK_SOURCE_MAP_DIR` | 可选，通常不设置。错误记录还原前端堆栈所用源码映射的目录，缺省为发布包内的 `sourcemaps/`（打包时从前端产物移出，按版本分目录，不经 Nginx 提供） |

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

预检会核对 Node、身份配置、数据库连接串、证书链/IP SAN/私钥匹配、异机挂载、磁盘、DSH
生产主版本及构建，拒绝本地兼容模式，并完成一次不发送 Prompt 的 ACP 握手和临时 Session
创建。首次部署也要求异机目录已就绪。

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

## 9. 完成首次检查与备份

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
```

确认 `postgres`、`web` 健康。Nginx 通过 `host.docker.internal:4190`
访问宿主机后端：若回环健康而 HTTPS 返回 502，检查 Docker Desktop 到宿主机的连接和
Nginx 日志；不要为排障把 4190 暴露到全网，也不要忽略 HTTPS 检查。
端口发布由预检生成的 `generated/compose.endpoints.yaml` 管理；不要省略该文件直接运行
Compose，否则无法验证实际入口集合。

从另一台已信任根 CA 的局域网电脑确认 4174/4180 可访问，4190/5434 不可访问。

### 9.2 身份与实际任务

1. 在加载 `runtime.env` 的受控终端初始化首位平台管理员；命令交互输入登录账号（手机号或
   邮箱）、姓名和密码，密码不回显。部署不会创建默认管理员密码，初始化账本只能消费一次：

   ```bash
   (
     set -a
     source "${DWP_ROOT}/runtime.env"
     set +a
     cd "${DWP_ROOT}/current"
     "${DSH_WORK_NODE_BIN}" server/dist/modules/identity/local-bootstrap.js
   )
   ```

   然后打开 `https://<IP>:4180/overview` 用该账号登录。
2. 在“员工与权限”新建测试员工账号并分配本地 `employee` 角色，用初始密码登录员工端，按提示改密。
3. 至少配置第二位有效平台管理员，检查权限撤销后下一请求被拒绝、停用账号后其新请求被拒绝。
4. 使用已配置的 DSH 模型凭据完成一个无敏感内容的小任务，确认输出、事件流、取消和成果
   可用。ACP 握手和健康检查通过不等于模型/工具调用已经验收。

### 9.3 首份异机备份

在没有运行中任务的维护窗口执行；此操作会短暂停止并恢复 dsh-work 后端：

```bash
bash "${DWP_ROOT}/current/scripts/deploy/backup.sh" "${DWP_ROOT}"
```

应同时得到本机 `backups/<UTC时间戳>/` 及异机目录中的 `.tar.gz`、`.sha256`、
`.tar.gz.verified.json`。脚本重新读取异机归档并校验哈希；该回执**不代表已完成恢复演练**。
安排隔离恢复验证，不能在仍承载其他应用的 Docker 环境中误删共享数据。

dsh-work 归档没有应用层加密，NAS 必须有静态加密和最小权限。该备份覆盖
dsh-work 数据库、`DSH_WORK_DATA_ROOT` 与发布清单，不覆盖 `runtime.env`、证书私钥、
外部 `DSH_HOME` 或 DSH 安装目录；这些应另行受控托管并验证灾难恢复，不把 Secret 提交 Git。
恢复验收必须抽查 `${DSH_WORK_DATA_ROOT}/skills/packages` 中的文件夹能够按数据库中的
`artifact_ref` 找到并通过摘要校验；只恢复数据库或只恢复数据目录都会造成 Skill 不可执行。

## 10. 首次检查后启用自动部署

watcher 只跟随 GitHub 的最新稳定 Release，安装后会立即运行。先确认最新版本就是刚检查
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
4. 查看 `active-release` 和日志，按 9.1 节确认服务健康。watcher 没有人工确认的拦截点，新版本会先被安装；需要先检查后安装时，保持 `DSH_WORK_AUTO_DEPLOY_ENABLED=false` 并人工升级。

dsh-work 自己创建并校验备份，因而可以自动提升。不要与同机其他应用互用发布脚本或备份回执。

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
| Release 验证失败 | 检查 Tag、不可变设置、CI 来源和服务账号 gh 认证，不跳过验证。若报 `no valid Sigstore verifiers could be initialized`，说明 `~/.cache/gh/.sigstore` 的 TUF 缓存过期：用 `XDG_CACHE_HOME=$(mktemp -d)` 指向全新缓存后重试，仍失败则停止发布并检查网络，不得跳过验证 |
| DSH Lock/ACP 失败 | 核对已安装 checkout、构建、权限与发布包 Lock，单独安排 Runtime 变更 |
| NAS 不可用或备份失败 | 恢复真实异机挂载及权限；不删除备份门禁，不用本机目录替代 |
| 初始管理员登录后无权限 | 确认登录的是 `local-bootstrap.js` 初始化的账号且未被停用；初始化账本只能消费一次，丢失管理员时由另一位平台管理员恢复，不重复初始化 |
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

最后安排共享服务器的维护窗口，验证 Mac mini 重启并登录、Docker Desktop 重启后
各应用都恢复；不要在同机其他应用的业务期间擅自重启整机或 Docker Desktop。制定定时备份、保留、
磁盘/入口/证书告警和证书续期计划；安装 watcher 不会自动配置这些作业。同一证书的两个
项目副本续期后都需要分别更新并生效。

部署交接只记录账号、目录、Release Tag/Commit、DSH Lock、健康/登录/任务/备份与重启
检查结论，不记录密码、Token 或私钥。绝不执行 `docker compose down -v`、删除数据卷，
或覆盖已有 `runtime.env` 来处理部署失败。

## 12. 升级与备份恢复

监听器调用的 `release.sh` 会：

1. 验证不可变 Release、Release 资产、Sigstore 构建来源和 SHA-256，并从已验证归档重新
   建立非活动 Release 目录；
2. 校验 macOS/ARM64、Docker Desktop、Node、证书、身份配置、发布包的 DSH
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

### 12.2 删除 AI Hub 登录（AH-S1，迁移 0129）的升级步骤

适用于从 `v2026.11.09-01` 或更早版本首次升级到包含迁移 `0129_remove_ai_hub_login` 的版本（`v2026.11.16-01` 起）。该版本删除 AI Hub 登录，同时带上 `v2026.11.09-01` 之后合入的 MCP 调用对账、知识检索工具、管理端模块权限等改动（迁移 0126～0128 只新增列，可向后兼容）。之后的版本照此流程升级：`v2026.11.26-01` 还会执行 0130～0135——0130 只为空值行补写 Skill 安装名称，0131～0135 只新增列、表或索引（MCP 员工身份、读取网页、错误记录、页面访问与索引），都可向后兼容，不需要改 `runtime.env`；不可回退的仍只有 0129。下文以 `v2026.11.26-01` 为例，换成实际要部署的版本。

**影响：** 迁移 0129 删除表和列，**不能回退到旧版本**；失败后只能发布修复版本，或用本次升级前的备份恢复数据库再回滚应用（第 12 节）。升级过程中后端会停止几分钟，执行中的对话会中断；员工的独立账号会话 Cookie 名不变，升级后无需重新登录。

#### 1. 发布端准备 Release

1. 确认 `main` 上包含 PR #129，`server/package.json` 的 `releaseVersion` 为目标版本（例如 `2026.11.26-01`），该 Commit 的 CI 四个 Job 全部成功。
2. 按第 3 节在 Actions 运行 **Manual release**，输入同一版本号，等待生成 `v2026.11.26-01` 及其资产与来源证明。

#### 2. Mac mini 升级前只读检查

在 Mac mini 的持续 Bash 会话中按第 2 节设置 `DWP_*`（`DWP_TAG='v2026.11.26-01'`，`DWP_ROOT` 填实际部署目录）。第 2 节开启了 `set -e`：本节的检查命令都写成“没有匹配也不退出”，不要去掉其中的 `|| true` 或 `if`，否则当前会话会退出并丢失 `DWP_*`。

```bash
cat "${DWP_ROOT}/active-release"   # 应为当前生产版本，例如 v2026.11.09-01
grep -E '^DSH_WORK_AUTO_DEPLOY_ENABLED=' "${DWP_ROOT}/runtime.env" || echo 'DSH_WORK_AUTO_DEPLOY_ENABLED 未设置（等同关闭）'
```

**检查可信入口是否已配置。** 新版本不再从 `AI_HUB_*_PORTAL_URL` 回退，缺少下面两项时预检会在迁移前失败：

```bash
{ grep -E '^(DSH_WORK_(WORKBENCH|ADMIN)_(ORIGINS|DEFAULT_ORIGIN)|AI_HUB_[A-Z_]+)=' "${DWP_ROOT}/runtime.env" || true; } \
  | sed -E 's/^(AI_HUB_[A-Z_]*SECRET)=.*/\1=***/'
```

- `DSH_WORK_WORKBENCH_ORIGINS`、`DSH_WORK_ADMIN_ORIGINS` 必须有值（例如 `https://<Mac mini IP>:4174`、`https://<Mac mini IP>:4180`）；默认入口两项可不设，不设时取各自列表的第一项。
- 输出里的 `AI_HUB_*` 行是旧配置，第 4 步删除。

**复查生产库没有 AI Hub 数据。** 两条都应为 0（2026-11-15 已确认；库中仍有 AI Hub 用户时迁移 0129 会失败并回滚）：

```bash
docker compose --env-file "${DWP_ROOT}/runtime.env" \
  -f "${DWP_ROOT}/current/deploy/compose.yaml" \
  -f "${DWP_ROOT}/generated/compose.endpoints.yaml" \
  exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
    select count(*) from users where identity_provider <> '\''local'\'';
    select count(*) from authentication_sessions where authentication_provider = '\''ai-hub-oidc'\'';"'
```

**确认异机备份目录可写、磁盘有余量。** 下面在子 shell 中按 `runtime.env` 的实际解析读取备份目录，不改动当前会话的变量；这只是提前发现问题，最终以 `release.sh` 预检为准（它还检查目录不是符号链接、与部署目录不在同一文件系统）：

```bash
(
  set -a; . "${DWP_ROOT}/runtime.env"; set +a
  if [[ -d "${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY}" && -w "${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY}" ]]; then
    df -h "${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY}" "${DWP_ROOT}"
  else
    echo "异机备份目录不可用：${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY}" >&2
  fi
)
```

#### 3. 进入维护窗口

1. 通知员工维护时间。
2. 在管理端 Runtime 页面把调度切换为“排空”，等待执行中的 Attempt 结束（排空期间员工新发起的任务会排队）。

#### 4. 整理运行配置

在 Mac mini 本地编辑，不要把内容回显到聊天或日志。先留一份原配置：

```bash
cp -p "${DWP_ROOT}/runtime.env" "${DWP_ROOT}/runtime.env.before-ah-s1"
chmod 600 "${DWP_ROOT}/runtime.env.before-ah-s1"
```

然后用本地编辑器修改 `${DWP_ROOT}/runtime.env`：

1. 第 2 步检查缺少 `DSH_WORK_WORKBENCH_ORIGINS` / `DSH_WORK_ADMIN_ORIGINS` 时补上；有 `AI_HUB_WORKBENCH_PORTAL_URL` / `AI_HUB_ADMIN_PORTAL_URL` 的，把它们的值分别填进这两项。
2. 删除所有 `AI_HUB_*` 行，以及 `DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS`、`DSH_WORK_ADMIN_BOOTSTRAP_ENABLED`、`DSH_WORK_OIDC_*`；删除 `DSH_WORK_AUTH_MODE`（若有）。这些变量新版本不再读取；不删也能启动，但启动日志会持续警告。例外：`DSH_WORK_AUTH_MODE` 只有值为 `local` 或 `oidc` 时才被忽略，其他值（包括 `prototype`）会让服务拒绝启动，必须删除。
3. 其他配置（数据库、证书、`DSH_CREDENTIAL_MASTER_KEY`、执行镜像、钉钉等）保持不变。

```bash
/bin/bash -n "${DWP_ROOT}/runtime.env"
grep -cE '^(AI_HUB_|DSH_WORK_OIDC_|DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS=|DSH_WORK_ADMIN_BOOTSTRAP_ENABLED=|DSH_WORK_AUTH_MODE=)' "${DWP_ROOT}/runtime.env" || true   # 应输出 0
grep -E '^DSH_WORK_(WORKBENCH|ADMIN)_ORIGINS=.+' "${DWP_ROOT}/runtime.env" || echo '缺少可信入口，回到上一步补齐'   # 应输出两行
```

#### 5. 下载、验证并执行升级

按第 6 节下载并验证 `v2026.11.26-01`（得到 `DWP_BUNDLE`），先记下后端错误日志当前的行数（launchd 日志是追加写入的，检查时只看这之后的内容），再用新包里的脚本升级：

```bash
DWP_LOG="${DWP_ROOT}/logs/server.stderr.log"
DWP_LOG_LINES="$(wc -l < "${DWP_LOG}" 2>/dev/null || echo 0)"
bash "${DWP_BUNDLE}/scripts/deploy/release.sh" "${DWP_VERSION}" "${DWP_ROOT}"
```

脚本依次执行：Release 与来源验证 → 预检（含身份配置与入口）→ 停止旧后端并备份、异机校验 → 迁移 0126～0129 及之后的迁移（`v2026.11.26-01` 为 0126～0135）→ 切换 `current` → 健康检查。

| 失败位置 | 现象 | 处理 |
| --- | --- | --- |
| 预检 | 输出 `DSH_WORK_WORKBENCH_ORIGINS 未配置`（或 `ADMIN`）后接 `Production identity configuration is invalid` | 数据库与应用都未改动；按第 4 步补齐 `runtime.env` 后重跑 |
| 备份 / 异机校验 | 备份目录不可用或校验失败 | 迁移未开始；恢复异机目录后重跑 |
| 迁移 0129 | `release.sh` 终端输出含 `仍有 N 个 AI Hub 用户` 与 `database migration failed`（不写入日志文件） | 每个迁移各自一个事务：0126～0128 已生效（只新增列，旧版本可用），0129 已回滚，脚本已恢复旧版本；先处理这些账号（只可能是遗留数据），再重跑 |
| 迁移后健康检查 | 输出 `database migrations were applied ... service stays stopped` | 服务保持停止，不能手工启动旧版本；查看 `logs/server.stderr.log` 排障，优先发布修复版本。必要时按第 12 节用本次备份 `restore.sh` 后立即 `rollback.sh`：此时 `current` 指向新版本，`restore.sh` 会先用新版本在恢复后的旧 Schema 上启动服务，回滚完成前保持 Runtime 排空、不对员工开放。新版本从未激活时 `active-release` 仍是旧版本，回滚会把旧版本自己记入 `automation/state/blocked-release`；以后开启自动部署前先确认并清理该文件 |

#### 6. 升级后检查

```bash
cat "${DWP_ROOT}/active-release"   # 应为 v2026.11.26-01
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:4190/health
for DWP_AUDIENCE_PORT in workbench:4174 admin:4180; do
  DWP_AUDIENCE="${DWP_AUDIENCE_PORT%%:*}"; DWP_PORT="${DWP_AUDIENCE_PORT##*:}"
  curl --fail --silent --show-error --max-time 30 --cacert "${DWP_ROOT}/certs/root-ca.crt" \
    "https://${DWP_IP}:${DWP_PORT}/auth/${DWP_AUDIENCE}/configuration"; echo
done
```

只看本次升级之后新写入的错误日志，确认没有旧配置警告：

```bash
DWP_NEW_LOG="$(tail -n "+$(( DWP_LOG_LINES + 1 ))" "${DWP_LOG}")"
if [[ "${DWP_NEW_LOG}" == *'AI Hub 登录已删除'* ]]; then
  printf '%s\n' "${DWP_NEW_LOG}" | grep 'AI Hub 登录已删除' | tail -1
else
  echo '本次启动没有旧配置警告'
fi
```

- 两个 `configuration` 响应只含 `mode: "local"`、`localEnabled: true`（员工端另有钉钉 `corpId`），不含 `aiHubEnabled`；这是区分新旧版本的依据（旧版本未配置 AI Hub 时也不注册 `/oidc/login`，所以不用该地址判断）。
- 有旧配置警告时，按列出的变量回到第 4 步删除，先执行 `DWP_LOG_LINES="$(wc -l < "${DWP_LOG}")"` 记下行数，再重启后端（`launchctl kickstart -k "gui/$(id -u)/com.company.dsh-work.server"`），然后重跑上面的日志检查。

在浏览器中：

1. 管理端与员工端登录页只有账号密码，没有 AI Hub 入口；平台管理员能登录管理端，“员工与权限”列表正常、没有“来源”列。
2. 用一名普通员工登录员工端；配置了钉钉的环境，在钉钉内打开一次确认免登正常。
3. 把 Runtime 调度**先切回“接受”**，再发一条无敏感内容的员工对话，确认回答、事件流与成果正常。

确认一切正常后，删除第 4 步留的 `runtime.env.before-ah-s1`（含密钥，不要长期保留）。

### 12.3 外部业务应用调用上下文（EA-S1，迁移 0131）

适用于升级到包含迁移 `0131_mcp_employee_identity` 的版本。迁移只新增列和表，可以向后兼容，不需要改 `runtime.env`；所有 MCP 连接器的“发送员工身份”默认关闭，升级后行为不变。按第 12 节常规升级即可，不需要单独的维护窗口。

**为某个外部业务应用开启“发送员工身份”**（[功能规则第 14 节](../development/feature-rules.md#14-外部业务应用接入ea-s1)、[外部业务应用接入方案](../design/external-app-integration-plan.md)第 6 节）：

1. 与外部应用的开发方按[方案第 6 节](../design/external-app-integration-plan.md#6-外部应用的接入约定)逐项核对接入约定，至少包括：
   - 外部应用校验 Bearer 凭据，凭据只给 dsh-work 使用；跨网络访问用 HTTPS；
   - 调用工具时拒绝以下请求：缺少 `X-DSH-Work-Visibility` 或取值不是 `personal`、`shared`；`personal` 却没有任何 `X-DSH-Work-Viewer-*`；`shared` 却带有 `X-DSH-Work-Viewer-*`；
   - 按 `X-DSH-Work-Viewer-Mobile` 识别员工（其次钉钉 userid、邮箱，都对应不上按无权限处理），按员工在本系统中的权限返回数据；`shared` 调用只返回所有员工可见的数据；
   - 写入只在 `personal` 时允许，按该员工的业务权限判断；写工具在参数中定义幂等键并按它去重，结果返回可核对的回执，记录该员工为操作人；
   - 访问日志不原样记录手机号与邮箱。
2. 在管理端“MCP 连接器”中，用该应用单独签发的 Bearer Token 登记连接器。不要复用其他连接器的 Token：凭据共用的连接器不能开启“发送员工身份”。
3. 打开连接器详情，开启“发送员工身份”并确认。只影响此后新启动的运行。
4. 按[验收目录 PF-MCP-P2](../../e2e/catalog/admin-platform.md#pf-mcp-p2-真实-mcp-与-dsh-发布前验收) 第 4 步核对：
   - 一名员工在个人对话中只拿到本人有权的数据；
   - 在项目空间中只拿到所有员工可见的数据，且写入被拒绝；
   - 管理端连接器详情的“最近调用”显示对应的调用上下文。

   核对记录中不写手机号原文。
5. 怀疑 Bearer 凭据泄露时，在连接器“更多”中选“轮换 Token”（凭据需重新录入时为“录入 Token”），并让外部应用作废旧 Token。持有旧凭据的人在更换前可以冒充任意员工调用该应用。

列表中标为“发送员工身份（未生效）”的连接器，表示开关已开启但当前不满足条件（如凭据与其他连接器共用），运行中不会发送员工身份；在“更多”中选“轮换 Token”换上本连接器单独的凭据即可（轮换会把共用的凭据拆开）。

## 13. 多 IP、固定域名与证书

入口配置由 dsh-work 自己管理，不改写同机其他应用的配置、数据库或网络；同机维护仍需协调共同的 Docker Desktop 和宿主机故障域。

1. 在网卡/DNS 上准备实际可达的地址，绑定 IP 必须是本机已分配的 RFC1918 IPv4。生产 Origin 使用完整 HTTPS 协议、主机和端口，不带路径、查询或 Fragment。
2. 在离线运维工作站使用企业 CA 签发覆盖旧、新全部 IP/域名的证书。没有现成 CA 时才使用 `init-intranet-ca.sh` 建立一套。每个项目优先使用独立服务器私钥，CA 私钥不放到 Mac mini。
3. 将服务器证书、私钥、根证书安装到 `runtime.env` 既有路径。私钥权限 `0600`；客户端信任根 CA。切换期间保留旧入口的证书覆盖和可达性。
4. 依次执行 `plan`、`check`、`apply --confirm`。多值配置使用逗号分隔，不手改生成的 Compose。

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

命令只修改入口字段，保留其他凭据，并复用发布锁。逐个入口验证 HTTPS、登录、刷新、退出和写请求；未知 Host/Origin 应拒绝。`/health` 成功不能替代登录验证。

恢复上一份地址配置：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh rollback \
  --deploy-root /Users/deploy/services/dsh-work --confirm
```

地址回滚不恢复 DNS 或证书文件，需分别核对。域名不变仅改变其 DNS IP 通常无需重签；新增直接访问的 IP/域名必须已在 SAN 中。所有副本续期后分别生效。

旧自签 CA 若曾将私钥放在服务器，应换成离线 CA 签发方案并在客户端完成信任切换；不要沿用服务器持有根私钥的模式。异机备份目录仍为所有发布的前置条件。

## 14. 钉钉移动端：公网员工端入口与钉钉应用（DT-S1）

依据[钉钉接入方案](../design/dingtalk-integration-plan.md) 4.3 与 8.3（DT2、DT24）。本节是 DT-S1 上线前的操作清单，**不代表已在生产执行或验收**；真实钉钉验收（DT-P2）按发布流程单独留证。第 4.1 节“不要配置公网转发”对内网 4174、4180 仍然有效：公网只开放本节的员工端入口，管理端（4180）、服务端口（4190）与数据库（5434）保持内网。

### 14.1 上线前必须确认

1. **安全基线（方案 8.3）已定：** 登录与免登接口按 IP 与账号限流、连续失败锁定（应用内已按账号与钉钉 userid 限流，**按 IP 限流在公网反向代理上配置**，见 14.3）；访问日志与异常登录告警；是否另加 WAF 或网关 IP 控制。员工首次在钉钉内绑定需要公网上的账号密码登录，网关不能只放行免登。
2. **旧配置清理：** 本版本起不再读取 `AI_HUB_*` 等 AI Hub 变量，启动日志会列出仍残留的变量；升级时从 `runtime.env` 删除它们（`set-macmini-endpoints.sh` 运行时也会删除以前写入的 `AI_HUB_*_PORTAL_URL`、`AI_HUB_*_REDIRECT_URI`）。可信入口只来自 `DSH_WORK_*_ORIGINS`。
3. **钉钉企业内部应用已创建**，并按方案 8.1“DT-S1 钉钉后台配置清单”完成配置（14.4）。

### 14.2 域名、证书与 origin

1. 申请员工端独立域名（例如 `m.<企业域名>`），网关对外使用**公网受信证书**（钉钉客户端不信任企业自签根证书）。证书只覆盖员工端域名，不覆盖管理端。
2. **公网入口使用 4174 端口：** `https://m.example.com:4174`。当前入口脚本（`set-macmini-endpoints.sh`、`render-endpoint-compose.mjs`）要求所有员工端 origin 使用 `DSH_WORK_WORKBENCH_PORT`（4174），并把各 origin 的主机名生成为 4174 Nginx 的 `server_name`。改用 443 需要先扩展入口脚本对公网 origin 的端口规则，属于后续工作，不能只改 `runtime.env` 绕过。
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

切换账号不在公网白名单内；钉钉内只用账号密码与钉钉免登。示例已在固定版本的 Nginx 镜像中做过语法检查与路径白名单探测（允许的路径带原始 Host 转发、其余返回 404、登录接口超限返回 503）；实际网关上线前仍须按 14.5 验证。

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
4. 启动日志没有“AI Hub 登录已删除，以下旧配置不再读取”的警告（有则从 `runtime.env` 删除所列变量）。
5. 在 iOS 与 Android 钉钉中从工作台打开 dsh-work：未绑定时显示“当前钉钉账号”与“登录并绑定”，登录后进入协作模式；再次打开免登。按 `e2e/catalog/dingtalk.md` 的 DT-P2 记录真机结果（返回键、软键盘、上传下载、安全区）。

回退：网关先撤下公网入口；用 `set-macmini-endpoints.sh` 去掉公网 origin（`plan`、`check`、`apply --confirm`，参数中不再包含 `https://m.example.com:4174`），或在刚变更后用 `rollback --confirm` 恢复上一份入口配置——不要手改 `DSH_WORK_WORKBENCH_ORIGINS`，否则与生成的 Nginx `server_name` 不一致；再在“钉钉集成 › 应用配置”点“清除配置”（删除已加密的 AppSecret，立即生效）。已写入的绑定记录保留，钉钉免登接口返回“未启用”。

## 15. 企业知识库（WeKnora）连接

规则见[功能规则第 11 节](../development/feature-rules.md#11-企业知识库weknorawk-s1-起)。连接在管理端“知识库 → 企业知识库 → 连接配置”中维护。

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

### 15.4 已知问题：关键词检索失败（WeKnora v0.9.0）

WeKnora v0.9.0 中，未开启问题生成的知识库做关键词检索时，ParadeDB 报 `Unsupported query shape`。WeKnora 保留向量结果、接口仍返回 200，员工端没有报错，但混合检索实际只剩向量检索，含编号、型号、专有名词等精确词的提问召回会变差。平台建的知识库都不开启问题生成（开启会把文档发给对话模型，见 15.1 第 2 条），所以全部受影响。上游登记为 [Tencent/WeKnora#4899](https://github.com/Tencent/WeKnora/issues/4899)，修复见 [Tencent/WeKnora#4908](https://github.com/Tencent/WeKnora/pull/4908)。不要为绕过此问题在 WeKnora 中开启问题生成。

判断是否受影响（容器名按实际部署）：

```bash
docker logs --since 24h WeKnora-app 2>&1 | grep -c 'Keywords retrieval failed'
```

结果大于 0 即受影响。升级到包含修复的 WeKnora 版本后：

1. 重跑契约测试（[开发与测试](../development/development.md)）。
2. 在员工端用含精确编号或型号的提问检索一次，确认上面的命令在升级后不再增加。
3. 关键词检索恢复后分值会变化，查看第 1 步契约测试“最低相关度”用例输出的分值，确认命中仍高于、无关提问仍低于最低相关度 0.5。
