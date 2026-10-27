# 执行隔离与受控 Shell 方案

**状态：** 阶段 1a 已实施（2026-10-26）；阶段 1b 的 subprocess 部分已实施（2026-10-26，开关 `DSH_WORK_EXECUTION_CONTAINER` 默认关闭；单元、集成、本机真实 Docker 与真实 DSH 端到端用例通过），`python_execute` 并入执行容器另作 1b②，待确定脚本路径契约（4.4）；1c（“静止”保证，3.7、4.1）已实施（2026-10-26，单元、集成、本机真实 Docker 与真实 DSH 端到端用例通过；Mac mini 验收未执行）；阶段 2a（C 档单次 `bash`，3.8）已实施（2026-10-27，同上，Mac mini 验收未执行）；2b（Office 工具链与二进制成果）已定案（2026-10-27，4.6），其中 2b-2（成果收集与校验、不合规文件跳过并提示）与 2b-4（原始文件挂载与跨轮修改）已实施（2026-10-27，单元、集成与本机真实 Docker 用例通过），2b-1 的 Dockerfile 与构建流水线已进入仓库（2026-10-27，镜像尚未构建，预检与 Runtime 说明的工具链清单待镜像摘要产出后实施），其余未实施；Mac mini 验收均未执行。可执行能力已定以 **C 档**（单次 `bash` 与 Office 工具链）为目标，D 档（后台任务）暂缓（第 6 节）；阶段 2 前置事项已于 2026-10-26 定案（第 6 节）。执行容器模式默认关闭，在阶段 2b 完成并通过第 9 节 P2 验收前不在生产开启。<br>
**更新日期：** 2026-10-26（按 KnowWork 源码复核修订：执行通道经平台中转、阶段重排、容器粒度与并发、产品决策新增中间选项；评审修订：审批保留在工具层、路径一致与可执行文件映射、宿主侧符号链接防护、阶段 1 拆分、档位按隔离要求重评；决定以 C 档为目标；简化：执行器改为服务内模块、只实现 docker 后端、容器按一次性容器管理、文件工具审计复用工具层记录、容器环境变量固定、非 C 档内容移至第 10 节后续方向；1c 定案为“静止”保证、不移植 remote fs）<br>
**依据：** 当前 Runtime Adapter、Platform Tool Bridge、DSH 工具策略与 Python 执行代码；DSH `0.1.2-rc.1`（`76fda72979`）的 `dsh-sandbox*`、`dsh-fs*`、`dsh-subprocess*`、`dsh-shell*`、`dsh-e2b` 系列源码与 README；KnowWork v0.0.2（`83c763e`）runtime-host 与会话沙箱实现（对照参考）；2026-10-25 两次本地探针（第 3 节）。<br>
**执行基线：** 每个 Attempt 一个独立 DSH ACP Worker，不改变进程模型；不新增执行循环。

## 1. 背景与目标

当前执行隔离分两层，强度不一致：

- **Python 执行**已在容器中：每次 `python_execute` 启动一个断网、只读根、非 root、`cap-drop ALL`、`seccomp`、资源受限、镜像按摘要锁定的临时容器（[功能规则第 6 节](../development/feature-rules.md#6-skill-python-执行)、[python-skill-runner.ts](../../server/src/modules/runtime/python-skill-runner.ts)）。入口只能是已激活 Skill 登记的 `.py` 文件，模型不能提交源码。
- **DSH Worker 本身**作为宿主机上的服务账号进程运行。文件工具的范围由 [dsh-work-tool-policy.js](../../server/config/dsh/dsh-work-tool-policy.js) 在应用层校验（`realpath` 后须位于 `DSH_WORKSPACE_ROOT` 内、写入限于 `output/`），不是操作系统边界。策略缺陷或 DSH 文件工具漏洞的影响面是服务账号可读的整台机器，包括 `DSH_HOME` 中的模型凭据。

同时，`bash`、终端、后台任务等 DSH 原生工具不在[内置工具注册表](../../server/src/modules/runtime/builtin-tools.ts)中，模型也不能执行自己写的代码，数据处理、准确计算、Office 文件生成与转换等能力只能依赖预制 Skill（影响见第 6 节）。

目标：

1. 模型可执行的命令落在操作系统级隔离的执行容器中；文件工具留在宿主，但只在容器内没有进程时读写工作区（“静止”保证，4.1）；
2. 受控放开 C 档可执行能力（单次 `bash` 与 Office 工具链，第 6 节）；
3. 模型可执行的代码永远接触不到凭据、平台工具桥和其他 Attempt 的数据；
4. 每次工具调用都经平台复核当前授权，收权立即生效；命令由平台逐条审计，文件工具调用沿用工具层记录。

## 2. 边界

- **执行职责不变。** DSH 仍持有单次 Attempt 内的 Agent Loop；本方案只替换“命令和文件在哪个世界执行”，经 DSH 官方扩展点（`ctx.fs`、`ctx.subprocess`）完成，不新增执行循环，不 fork DSH（[AGENTS.md](../../AGENTS.md)、[总览 3.5](../development/overview.md#35-agent-执行引擎统一)）。
- **不做中断后继续执行。** 容器崩溃、超时或宿主重启时 Attempt 以失败结束，沿用[Runtime 方案](runtime-execution-optimization-plan.md)的约定。
- **无合格隔离即不可用。** 部署环境没有满足要求的容器运行时，需要隔离的能力明确标记不可用，不降级为宿主机执行（与功能规则第 6 节“无合规镜像即不兼容”一致）。开发环境同样使用容器运行时，不提供无隔离的开发模式。
- **只覆盖现有部署形态。** 仓库现有部署只有 Mac mini（3.1），本方案只实现单机 docker 后端；其他部署形态与 C 档以外的能力见第 10 节。
- **不建设通用沙箱平台。** 只服务 dsh-work 的 Attempt 执行；不对外提供容器编排或任意镜像运行。
- **Agent 协作与委派不在范围内。** 原 `delegate_agent` 已于 2026-10-16 删除，需另行产品设计。

## 3. 事实与探针结论

### 3.1 代码核对（2026-10-25，2026-10-26 补充）

| 事实 | 依据 |
| --- | --- |
| DSH 同世界沙箱（`dsh-sandbox-local`：Linux bwrap/Landlock、macOS Seatbelt、Windows ACL）只约束写：bwrap 以只读方式挂载宿主根，`fs-sandbox` 读操作一律放行；README 明确“不表达网络、进程、系统调用、设备或凭据限制” | `packages/sandbox/sandbox/README.md`、`sandbox-local/README.md`、`fs/fs-sandbox/README.md` |
| DSH 官方以“整体替换执行世界”表达容器/远程隔离：`fs-e2b` 与 `subprocess-e2b` 把文件、bash、终端整体移入远程沙箱，模型侧工具不变 | `packages/e2b/*/README.md` |
| `0.1.2-rc.1` 提供 `SubprocessRuntime`（`resolveExecutable`、`spawn`、`spawnTerminal`）与 `FileSystem` 抽象基类，以及 `dsh-bash-local`、`dsh-tool-bash`、`dsh-tool-jobs`、`dsh-shell-env` 包 | `packages/subprocess/subprocess/src/index.ts`、`packages/fs/fs/src/index.ts`、`packages/shell/*`、`packages/jobs/tool-jobs` |
| `tool-fs-search`（`glob`、`grep`）不走 `ctx.fs`，经 `ctx.subprocess` 调用 npm 包自带的 ripgrep；可执行文件取 `@vscode/ripgrep` 的 `rgPath`，即宿主 `node_modules` 内 macOS arm64 二进制的绝对路径，Linux 执行容器中不存在。KnowWork 未挂载该插件 | `packages/fs/tool-fs-search/src/search-core.ts` |
| `dsh-tool-bash` 默认暴露 `run_in_background` 参数（配置 `enableRunInBackground` 默认 `true`），后台进程注册到 `ctx.jobs`，经 `job_output`、`job_kill` 读取与终止；关闭该配置后带此参数的调用被拒绝 | `packages/shell/tool-bash/src/index.ts` |
| `dsh-bash-local` 交给 `ctx.subprocess` 的是显式 env（`ENV_OVERRIDES`、调用方 env、`dshEnv` 三层合并）；宿主进程环境由本地 subprocess 实现自行合并 | `packages/shell/bash-local/src/index.ts` `spawnSpec` |
| DSH 进程当前持有模型凭据（`DSH_HOME`）与 MCP Bearer 头（`DSH_MCP_VALUE_*` 环境变量及 Attempt patch） | [dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) `prepareMcpProcess` |
| 平台工具桥为每 Attempt 一个 Unix socket（`0600`），服务端只注册本 Attempt 的平台工具、限制调用次数并复核当前授权；**审批模式与试运行隔离在 DSH 策略插件中执行**，可直连 socket 的进程可绕过这两项 | [platform-tool-bridge.ts](../../server/src/modules/runtime/platform-tool-bridge.ts)、[dsh-work-tool-policy.js](../../server/config/dsh/dsh-work-tool-policy.js) |
| 审批按工具调用粒度：策略插件在工具执行前复核授权，需要审批时返回 `ask`，经 ACP 权限请求交平台确认，审批记录关联工具名与 `resource_ref` | [dsh-work-tool-policy.js](../../server/config/dsh/dsh-work-tool-policy.js) 审批分支 |
| Adapter 按 ACP `tool_call`、`tool_call_update` 发出 `tool.started`、`tool.completed` 事件（EX-01，按 `toolCallId` 关联，有条数上限），只含工具名与状态，不含参数与结果；参数留在 Attempt 目录的 DSH 会话日志中 | [dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) `onToolCallUpdate` |
| 工作区每 Attempt 新建于宿主 `<runtimeRoot>/<tenant>/<run>/<attempt>/workspace`；新建后只写入记忆投影、检查点中的 `output/` 文件与输入挂载（Manifest 中挂载路径写作 `/workspace/...`，由 Adapter 映射到宿主目录） | [dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) `execute` |
| 业务服务进程直接调用 `docker` CLI 创建 Python 容器，即业务服务本身持有容器运行时控制权（Docker Desktop 上等同控制整个 Docker 虚拟机） | [python-skill-runner.ts](../../server/src/modules/runtime/python-skill-runner.ts) |
| 仓库现有部署形态只有 Mac mini：服务由 launchd 托管，compose 只运行 PostgreSQL 与 nginx | [deploy/](../../deploy/)、[Mac mini 部署手册](../release/mac-mini-deployment-runbook.md) |

### 3.2 KnowWork 对照（参考，不照搬）

KnowWork v0.0.2 的执行链路分两部分：

**宿主侧（结构值得借鉴）：**

- DSH 运行在一个常驻的 `runtime-host` 容器中，**所有会话与工作空间共用一个 DSH 进程**；容器只读、非 root、`cap-drop ALL`，只接入一张只能到达 api 的内部网络，不挂 `docker.sock`。
- 本机 `filesystem`、`subprocess`、持久化 bash、终端与工作目录插件全部停用，换成 `remote-fs`、`remote-subprocess`；官方 bash、文件工具、`present`、后台任务原样挂在其上。
- 每次文件或命令操作以 HTTP 回调 api 内部接口（`/internal/extensions/sandbox/exec|stat|read|list|write`），api **每次重新校验会话工具令牌与空间成员身份**后，再对沙箱执行 `docker exec` 或 archive 写入。DSH 不持有容器控制权。
- 模型调用经 api 的模型网关（OpenAI 兼容），网关短期令牌经官方凭据服务存于 tmpfs 并按 TTL 轮换；DSH 不直连模型厂商。
- 远程 subprocess 只支持收集模式输出，命令结束后一次拿回，不支持 stdin 与终端；转发 env 时只剔除 `DSH_HOME`、`DSH_PROFILE_DIR`。

**沙箱侧（姿态不采用）：** 每会话一个常驻容器（按工作空间与会话摘要命名，空闲 30 分钟回收，工作区在容器自身文件系统中，重建即丢失）。默认以 root 执行、`cap-drop ALL` 后加回 `CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SETGID/SETUID/KILL`、根文件系统可写、**默认 `bridge` 可出网**（其插件注释称“断网”，但部署默认值并非如此）；附件与命令同处一个可出网的容器，存在提示词注入后外泄风险。api 与 worker 挂载 `docker.sock`，其 `SECURITY.md` 承认等同宿主 root。

**借鉴的工程细节：** 按 label 清扫孤儿容器（`sweeper.py`）；`init: true` 防僵尸进程；内存与内存+交换相等；命令放入独立进程组，超时或取消时另起 exec 整组 `SIGKILL`，容器内看门狗兜底（仅断开 exec 连接不会停止容器内进程）；产物只收普通文件；未启用沙箱时明确报不可用。Office 工具链选用原生 LibreOffice：其实测每份文档 2–5 秒、约 190 MB，DSH 官方 WASM 引擎约 17 秒、峰值约 1.4 GB（2026-10-20）。其按名称找回已有容器、核对 label 后才收养、姿态摘要变化即重建等逻辑服务于常驻复用的容器，本方案的容器每 Attempt 一次性使用（4.4），不需要。

本方案采用其“命令经平台中转进入容器”的结构与上述工程细节，但文件工具不随之移入容器，改以“静止”保证（3.7、4.1）；不采用其沙箱默认姿态、`docker.sock` 挂载方式与共享 DSH 进程模型（dsh-work 保持每 Attempt 一个 Worker 进程）。

### 3.3 探针一：宿主 Unix socket 与网络（macOS Docker Desktop 4.68，arm64）

| 场景 | 结果 |
| --- | --- |
| 宿主 Unix socket 绑定挂载进容器（`/private/tmp` 与 `os.tmpdir()`，root 与宿主 uid） | ❌ `connect ENOTSUP`，宿主未收到请求 |
| 两个容器经 Docker 命名卷共享 Unix socket（`--network none`） | ✅ 9 ms；权限按 socket 文件模式生效 |
| 宿主 TCP（`127.0.0.1` 监听）经 `host.docker.internal` 访问 | `bridge` 网络 ✅（约 20 ms），但同一网络可出公网；`none` 与 `--internal` 网络不可达 |
| `host.docker.internal` 解析 | IPv6 优先且不可达，客户端须强制 IPv4 |
| macOS socket 路径 | 受 `sun_path` 104 字节限制，长路径无法监听 |

结论：macOS 上宿主侧的工具桥与模型网关**不能**以 Unix socket 进入容器。这只影响 Worker 进容器（第 10 节）；执行容器不需要连接任何宿主服务（4.1），宿主目录绑定挂载在 Docker Desktop 上可用（现有 Python 执行即如此）。

### 3.4 探针二：DSH Worker 容器内启动（第 10 节背景）

在 `node:24-bookworm` 中按部署方式安装构建同一 DSH 提交（`pnpm install --frozen-lockfile` 35 s、`pnpm run build` 60 s，目录 2.0 GB，其中 `node_modules` 1.5 GB），以源码加 `tsx` 方式启动。容器参数：`--read-only`、`--tmpfs /tmp`、`--cap-drop ALL`、`no-new-privileges`、`--user 1000:1000`、1 GiB 内存、2 CPU、DSH 目录只读。每种方式 5 次，完整执行 `initialize → session/new → 首轮回答`（假上游确认收到 `probe-chat`）：

| 方式 | 就绪中位数（至 `session/new`） | 首轮回答 | 失败 |
| --- | --- | --- | --- |
| 宿主直接启动（现状） | 871 ms（首次冷启动 3.8 s） | 96 ms | 0/5 |
| 容器，无 tsx 缓存 | 1457 ms | 63 ms | 0/5 |
| 容器，可写共享 tsx 缓存卷 | 860 ms | 56 ms | 0/5 |
| 容器，预编译只读 tsx 缓存（只挂 `/tmp/tsx-1000`） | **852 ms** | 54 ms | 0/5 |
| 容器，`apps/cli/lib/bin.js` 构建产物入口 | 启动失败：加载器找不到 `@deepseek-ai/*` 插件包 | — | 5/5 |

结论：加固姿态下 Worker 可正常运行；冷启动增量约 0.6 s，全部来自 `tsx` 即时编译，预编译缓存（约 5 MB）只读挂载即可与宿主持平；禁止跨 Attempt 共享可写编译缓存；去除 `tsx` 需改用官方打包发行版，尚未验证。本探针只覆盖 Worker 容器，**未覆盖执行容器**（3.5）。

### 3.5 探针三：阶段 1b 前提（2026-10-26）

本机 DSH `0.1.2-rc.1` 源码检出、`--profile acp --patch <探针 patch>`、独立临时 `DSH_HOME`、`DSH_TELEMETRY_MODE=DISABLED`，上游为脚本化的 OpenAI 兼容假模型（依次要求 `bash`、`glob`、`grep`）。探针 remote subprocess 插件把每次 spawn 经 `docker exec` 落到一个断网、只读根、`cap-drop ALL`、非 root、按宿主绝对路径挂载工作区的 `python:3.12-slim` 容器，并以固定环境变量执行。探针脚本保存在会话 scratchpad，未进入仓库。

**acp Profile 组成（`--dump-config`）：**

| 服务 | 插件 | 结论 |
| --- | --- | --- |
| `ctx.subprocess` | `subprocess`（`dsh-subprocess-local`） | 停用后插入 remote 实现 |
| `ctx.fs` | `fs-sandbox`（`dsh-fs-sandbox`，继承宿主 `LocalFileSystem`，写入按 `sandbox-policy` 围栏） | 保持（1c 以“静止”保证代替 remote fs，见 3.7） |
| bash 执行器 | `bash-sandbox`（经 `ctx.sandbox` 把 argv 包进 Seatbelt/bwrap） | 包装程序在容器内不存在，须停用并改挂 `dsh-bash-local` |
| 权限预设 | `permission`（`dsh-permission-presets`） | 拒绝装配在不受限的 bash 执行器之上，DSH 启动失败；须停用。审批仍由 `dsh-user-approval` 与 dsh-work 策略插件承担 |
| 后台任务 | `tool-jobs`（默认挂载） | C 档停用 |

patch 不能替换已有条目的包名（`name mismatch … skipping`），替换方式只能是停用原条目并插入新条目（与 KnowWork 相同）。

**端到端结果：**

| 项 | 结果 |
| --- | --- |
| DSH 加载 remote subprocess 并完成 `initialize → session/new → prompt` | ✅ |
| `bash` 在容器内执行 | ✅ uid 501、cwd 为宿主绝对路径、写入的 `out.txt` 在宿主工作区可见且属主为宿主用户，收集模式输出回到模型 |
| DSH 交给 subprocess 的 env | `DSH_HOME`、`DSH_SESSION_ID`、`DSH_SHELL`、`GIT_PAGER`、`NO_COLOR`、`PAGER`、`TERM`；固定环境变量后均未进入容器（印证 4.2） |
| `glob`、`grep` | DSH 传入平台专用包路径 `@vscode/ripgrep-darwin-arm64/bin/rg`；映射规则须匹配 `@vscode/ripgrep(-<平台>)?/bin/rg`。映射为 `rg` 后因探针镜像不含 `rg` 退出 127，镜像须内置 `rg` |
| `0.1.2-rc.1` 的 `SubprocessRuntime` | 抽象方法只有 `resolveExecutable`、`spawn`、`spawnTerminal`（KnowWork 基于 0.2.1 另有 `terminalEnvironment`）；`SubprocessHandle` 须带 `pid` |

**执行容器冷启动（含 4.2 姿态，创建 → 首条 `exec` 返回）：**

| 镜像 | 单个（中位数 / 最大） | 4 个并发（中位数 / 最大） | 删除（中位数） |
| --- | --- | --- | --- |
| 基线 `python:3.12-slim` | 176 / 302 ms | 213 / 252 ms | 51–70 ms |
| Office 探针镜像（解压后约 1.4 GB） | 178 / 580 ms | 236 / 574 ms | 52–77 ms |

容器创建基本不随镜像大小变化，最大值出现在首次创建。

**Office 探针镜像：** 基于同一 `python:3.12-slim`（Debian 13），安装 `libreoffice-{writer,calc,impress}-nogui`（25.2.3）、`poppler-utils`、`pandoc`、`ripgrep`（14.1.1）、`fonts-liberation2` 与 pandas、openpyxl、python-docx、python-pptx；不含中文字体。构建时本机代理对 `deb.debian.org` 的 HTTP 请求间歇返回 502，改用 HTTPS 源并在构建步骤内重试后成功（约 140 s）；正式镜像应在可靠的构建环境中产出并按摘要锁定。

| 项 | 结果（简单样例文档，3 次一致） |
| --- | --- |
| LibreOffice 默认用户配置 | ❌ 非 root uid 在容器内无 `passwd` 条目，即使 `HOME` 为可写 tmpfs，也报 “User installation could not be completed” 退出 77；指定 `-env:UserInstallation=file://<可写目录>` 后正常。镜像或执行器须显式设置配置目录 |
| docx → PDF | 首次约 320 ms（含建立用户配置），再次约 160 ms |
| xlsx → PDF | 约 130 ms |
| PDF → PNG（`pdftoppm`） | 约 22 ms |
| 容器内存峰值（`memory.peak`） | 约 157 MB（上限 1 GiB） |
| `glob`（`rg --files --sort=modified …`） | 宿主 DSH 自带 `rg` 15.0.0 与镜像 `rg` 14.1.1 输出完全一致，含隐藏文件、`.git` 排除与中文路径 |
| `grep`（`rg --json`） | 匹配记录集合一致；文件顺序不同（未排序时 `rg` 并行遍历，顺序本就不确定） |
| DSH 端到端（Office 镜像） | `bash`、`glob`、`grep` 均在容器内完成，结果回到模型 |

真实文档的转换耗时会更高（KnowWork 实测 2–5 秒），以上只说明工具链在 4.2 姿态下可用及启动开销量级。

**1b① 实施中的发现（2026-10-26）：**

- DSH 交给 subprocess 的 `cwd` 可能是未解析的路径（`glob` 送 `/var/…`，`bash` 送 `/private/var/…`）。平台按解析后的真实路径校验工作区边界，执行容器同时按给定路径与真实路径挂载工作区。
- `tool-fs-search` 申请的输出上限大于平台上限；平台按平台上限截断（`truncated` 标记），而不是拒绝。
- 执行镜像也可用本地镜像 ID（`sha256:…`）锁定，与仓库摘要同样不可变。

### 3.6 未覆盖

- **正式执行镜像**：中文字体、工具链显式清单与 `rg` 版本是否与 DSH 依赖对齐（探针为 14.1.1，DSH 自带 15.0.0）；真实业务文档的转换耗时与内存；多 Attempt 并发时的总内存。

### 3.7 探针四：1c 前提（2026-10-26）

本机 macOS 26.6、Node 26.5、DSH `0.1.2-rc.1` 源码，执行容器沿用 1b① 的 `DockerExecutionBackend` 与 4.2 姿态。探针脚本保存在会话 scratchpad，未进入仓库，未改生产代码。

**宿主侧不跟随符号链接（macOS）：**

| 项 | 结果 |
| --- | --- |
| Node 是否导出 `O_NOFOLLOW_ANY` | 否；macOS 定义为 `0x20000000`，以数字传给 `fs.openSync` 可用 |
| 打开路径中间含符号链接的文件 | `O_NOFOLLOW` 只查最后一级，读到了工作区外的文件；`O_NOFOLLOW_ANY` 返回 `ELOOP` |
| 最后一级为符号链接 / 经符号链接父目录创建文件 | `O_NOFOLLOW_ANY` 均返回 `ELOOP` |
| `rename`、`mkdir`、`unlink` 等按路径的操作 | Node 没有 `*at` 系统调用，也没有不跟随参数；经符号链接父目录 `rename` 成功写到了工作区外 |
| Linux | 未验证；`O_NOFOLLOW_ANY` 是 macOS 专有，Linux 需要 `openat2` 等，Node 同样未提供 |

结论：宿主侧的读与新建可以做到逐级不跟随，但改名、建目录、删除只有在容器内没有进程同时改动工作区时才安全。

**命令结束后是否还有进程（1b① 的执行容器）：**

| 项 | 结果 |
| --- | --- |
| 命令内 `cmd &`、`setsid …`、`nohup …` | 命令返回后进程**仍在容器内运行**（被 PID 1 收养）；`setsid` 出去的进程也逃过超时时的整组终止 |
| 每条命令后清扫（杀掉 PID 1 与保活进程以外的所有进程，重复直到干净） | 约 140 ms 清理干净 |
| 进程数耗尽（在 pids 上限内不断 fork） | 清扫命令本身也无法启动，容器内任何命令都失败 |
| 删除并重建容器（工作区在宿主，文件不丢） | 约 0.4 s，总能回到干净状态 |

结论：1b① 目前只运行 `rg`，不会留下进程，不受影响；放开 bash（阶段 2）前必须保证每条命令结束后容器内没有残留进程。清扫只是优化，**“清扫不干净就删除容器”才是保证**。

**DSH 工具调度（`packages/core/agent-loop/src/tool-calls.ts`、`core/tools`）：** 只有声明 `isConcurrencySafe` 的工具会并行；`0.1.2-rc.1` 中 `read`、`read_image`（及联网搜索、子 Agent）可并行，`bash`、`write`、`edit`、`str_replace_editor`、`glob`、`grep` 都是独占调用，前一组结束后下一组才开始。dsh-work 的平台工具（含 `python_execute`）均未声明可并行，同样独占。因此 `bash` 运行期间不会有任何文件工具同时执行。

**调度方式随参数变化（1c 实施时发现）：** DSH 按每次调用的参数判断能否并行，`read` 不带参数时报告独占、带 `file_path` 时报告并行。因此工具目录按“空参数”与“按输入 Schema 构造的参数”各探测一次，任一为并行即记为并行；按此在真实 DSH 中得到：`read`、`read_image`、`web_search` 并行，`bash`、`write`、`edit`、`str_replace_editor`、`glob`、`grep`、`todo_write` 独占（`web_fetch`、子 Agent 也报告并行，但不在注册表内，被工具策略拒绝）。这一核对是启发式的：只覆盖探测时用到的参数形态，`0.1.2-rc.1` 中 `bash`、`write`、`edit` 根本没有定义 `isConcurrencySafe`，因此结论成立；DSH 升级时须在源码中再确认这些工具及会启动容器代码的平台工具仍未定义 `isConcurrencySafe`（见 [Runtime 交付](../release/dsh-runtime-delivery.md)第 5 节）。

**remote fs 移植：** `FileSystem` 有 12 个抽象方法，并带版本号（`FsVersion`）、写入意图与 `fs/observed` 等事件；`tool-fs` 用 `instanceof FsError` 判断错误，实现必须使用 DSH 自己加载的 `FsError` 类，即插件要从 DSH 安装目录解析 `@deepseek-ai/dsh-fs`（不能像 subprocess 插件那样不引用 DSH）。KnowWork 的 `remote-fs` 约 250 行，基于 `0.2.1`（另实现了 `0.1.2-rc.1` 没有的 `readByteRange`），并自行实现了编辑语义。移植可行，但需要模块解析机制、维护一份与 DSH 一致的编辑语义，且每次文件操作都要一次容器 `exec`（约 60 ms 起）。

**宿主侧读取工作区的现状：** 七个带路径参数的文件工具都经工具策略的真实路径检查。检查点读取（`readCheckpointWorkspaceFiles`）与成果发布（`publishRuntimeArtifacts`）会拒绝 `output/` 内的符号链接与硬链接文件，但**不检查 `output/` 目录本身**：容器内代码若把 `output` 换成指向宿主目录的符号链接，两者都会读到工作区外的文件。目前没有途径创建该链接（容器只运行 `rg`），放开 bash 后即成为静态（非竞态）的外泄路径，无论 1c 选哪种做法都必须修复。

**1c 做法（2026-10-26 定案）：保持 DSH 本机文件工具，以“静止”保证代替 remote fs。** 只要宿主读写工作区时容器内没有任何进程，路径检查与使用之间就不存在竞态，现有真实路径检查足以拦住容器留下的符号链接。成立的条件：

1. **每条可能派生进程的命令（`bash`；1b② 后的 Python）结束后确认容器静止**：先清扫，确认失败、清扫命令无法执行或进程数耗尽时删除容器（下次命令再惰性创建）。
2. **超时与取消也要等清理完成**：DSH 取消命令时插件会立即结束请求，DSH 随即开始下一个工具。平台在执行容器“忙或未确认静止”时，令工具桥的 `/authorize-execution`（生产环境每次工具调用前都会探测）等待清理完成，超过时限则拒绝本次工具调用；插件侧再加“取消后等待平台确认”作为补充。
3. **静止无法恢复时 fail closed**：删除容器也失败（`state_conflict`）时，Attempt 立即失败，不再执行任何文件工具。
4. **宿主侧读取方修复**：检查点读取与成果发布先确认 `output/` 本身是工作区内的真实目录（`lstat` 与真实路径），文件只收普通文件；macOS 上读取可再用 `O_NOFOLLOW_ANY`。管道等非普通文件一律拒绝，避免宿主读取被卡住。
5. **工具独占性升格为安全不变量**：`bash`、`write`、`edit`、`str_replace_editor`、`glob`、`grep` 与平台工具必须保持独占、只有 `read`/`read_image` 可并行，纳入 DSH 升级准入测试；并行的读工具只在静止期间运行。

不采用 remote fs。与之相比：不需要解析 DSH 模块、不复刻编辑语义、读文件没有 `exec` 开销、不依赖 macOS 专有标志；代价是每条 `bash` 命令后多一次静止确认（约 0.1 s，异常时约 0.4 s 重建）。


### 3.8 阶段 2a 实施发现（2026-10-27）

本机 DSH `0.1.2-rc.1`、执行镜像 `dsh-exec-test:rg`（基于 `python:3.12-slim`，含 `rg`），经与 1b 相同的真实 DSH 端到端用例验证：

- **装配：** 叠加层停用 `bash-sandbox` 与 `permission` 后插入 `@deepseek-ai/dsh-bash-local`，DSH 正常启动，启动准入读到的 `bash` 仍为独占调度。
- **审批：** 停用 `permission` 后 DSH 对 `bash` 不另行发起权限请求（`DSH_PERMISSION_MODE=workspace-write`、审批模式“从不”时零次请求）；是否确认仍只由 dsh-work 工具策略按 Agent 审批模式决定，与第 6 节定案一致。
- **argv：** `dsh-bash-local` 交给 `ctx.subprocess` 的永远是 `['bash', '-c', <命令>]`。平台只接受这一形式并在镜像内 `bash` 执行；`/bin/bash`、`bash -lc`、`sh -c` 等其他形式与宿主路径一律拒绝。
- **环境：** 容器内只有执行器固定的变量与镜像自带变量（如 `PYTHON_VERSION`），`DSH_*`、Worker 变量与 MCP 凭据都不进入。
- **成果收集的限制：** `output/` 只接受顶层的 Markdown、文本、CSV、HTML 普通文件（单个 ≤10 MB，合计 ≤20 MB），其他格式、子目录或隐藏文件会令成果登记失败。`bash` 放开后模型可能写出 `.xlsx`、`.docx` 等；2a 在 Runtime 说明中要求中间文件放在工作区其他目录或 `/tmp`，Office 等二进制成果的登记、扫描与预览并入 2b 设计（4.6），在此之前 C 档的 Office 价值只能体现为转换为文本类成果。
- **Skill 声明：** Skill 的 `allowed-tools` 中的 `Bash` 维持“不支持的依赖”，不映射到 `bash`：`bash` 是否可用取决于部署的执行容器状态，Skill 发布校验不能依赖它；Skill 试运行不装配 `bash`。

## 4. 方案

### 4.1 执行链路：经平台中转

```text
DSH Worker（每 Attempt 一个，宿主进程）
  工具层：dsh-work-tool-policy 按工具调用复核授权与审批（ask → ACP → 平台），现有机制不变
  本地 subprocess 插件停用，换成 dsh-work-remote-subprocess；文件工具仍用本机 fs-sandbox（“静止”保证）
        │ 每 Attempt 工具桥（Unix socket 0600 + Attempt 令牌）
        ▼
平台（业务服务）
  操作层：校验 Attempt 令牌与当前授权 → 配额 → 路径与可执行文件映射 → 命令审计 → 命令后确认容器静止
  执行器模块（唯一调用容器运行时的代码，固定参数接口）
        │ exec / archive
        ▼
执行容器（非 root、只读根、默认断网，只挂本 Attempt 工作区，挂载路径与宿主一致）
```

- **Worker 与执行容器之间没有直接通道。** Worker 不需要容器控制权，也不需要第二条网络通道；执行容器不需要访问任何宿主服务。
- **职责分两层：**
  - **工具层（DSH 策略插件）**负责审批与文件路径检查。服务端经工具桥收到的是一条条命令，看不到工具调用本身，无法按工具审批，也对不上审批记录的 `resource_ref`，因此审批保留在工具层（3.1）。
  - **操作层（服务端）**负责每个底层操作的令牌与当前授权校验（收权立即生效）、配额、路径与可执行文件映射、命令审计。
- **绕过问题靠隔离解决。** 3.1 中“可直连工具桥的进程可绕过审批”的前提是模型代码能接触工具桥 socket；可执行能力放开后，模型代码只在执行容器中运行，接触不到 socket。
- **试运行不在操作层另做隔离。** 执行容器断网，底层操作没有外部效果；MCP 与平台工具的 `trial_only` 维持现状。
- **审计。** 平台对命令逐条记录（`bash` 与 `python_execute`：命令、退出码、耗时、输出摘要），进入 Attempt 事件。文件工具调用沿用工具层已有记录（3.1：Attempt 事件含工具名与状态，参数在 DSH 会话日志），平台不按底层文件操作另做审计，也不需要把底层操作与工具调用关联。
- **路径一致。** 执行容器把 Attempt 工作区按宿主绝对路径原样挂载（可另提供 `/workspace` 别名），DSH、模型与容器内命令看到同一路径。否则模型从工具输出取得的宿主路径在容器命令中不存在，容器命令输出的 `/workspace/...` 路径交给 DSH 文件工具也对不上。KnowWork 以容器内 `/sessions/<会话 id>` → `/workspace` 符号链接达到同一效果。路径中含租户、Run 与 Attempt 标识，不含凭据。
- **可执行文件映射。** remote subprocess 只接受白名单内的可执行文件：DSH 自带二进制按白名单映射到镜像内同名工具，`@vscode/ripgrep` 的 `rgPath`（平台专用包路径，如 `@vscode/ripgrep-darwin-arm64/bin/rg`，见 3.5）映射为镜像内 `rg`（版本与 DSH 依赖对齐），保证默认工具 `glob`、`grep` 可用（3.1）；其他宿主绝对路径一律拒绝。
- **“静止”保证代替 remote fs（1c，3.7 定案）。** 执行容器能运行代码后，可在共享工作区留下指向外部的符号链接，或在宿主检查路径与使用路径之间替换路径。dsh-work 不把文件工具搬进容器，而是保证宿主读写工作区时容器内没有任何进程，从而消除检查与使用之间的竞态；容器留下的静态符号链接由工具策略的真实路径检查拦截。具体要求：
  - 每条可能派生进程的命令（`bash`；1b② 后的 Python）结束后先清扫残留进程，确认失败、清扫命令无法执行或进程数耗尽时删除容器（下次命令再惰性创建）。清扫只是优化，“不干净就删除”才是保证。
  - 超时或取消时，平台在清理与静止确认完成前把执行容器标为忙；执行容器模式下工具桥的 `/authorize-execution`（策略每次工具调用前都会探测）先等待执行容器空闲，最多 3 秒（在策略 6 秒的探测时限之内；正常清理约 0.1–0.4 s），超时只拒绝本次工具调用。插件侧“取消后等待平台确认”未实施，由该等待替代。
  - 静止无法恢复（删除容器也失败）时，下一次授权探测即令 Attempt 以 `EXECUTION_CONTAINER_UNRECOVERABLE` 失败，不再执行任何工具；该 Attempt 的执行容器也拒绝后续命令。
  - 在 dsh-work 内置工具注册表的工具与 `bash` 中，只有 `read`、`read_image`、`web_search` 可由 DSH 并行调度，其余必须独占（3.7）。这是安全不变量：工具策略在工具目录中发布 DSH 实际的调度方式（`dshScheduling`），执行容器模式启动检查据此准入，不满足或未报告即视为执行容器不可用。
- **宿主侧读取工作区。** 产物收集、检查点复制、输入挂载等宿主侧操作只在静止期间进行：Attempt 结束时先让工具桥停止接收命令、等待清理结束并删除执行容器，再收集成果，任何一步失败都令 Attempt 以 `EXECUTION_CONTAINER_UNRECOVERABLE` 失败且不收集；持久化等待的检查点在读取 `output/` 前等待执行容器空闲，不空闲则不创建检查点。读取时并先确认 `output/` 等目录本身是工作区内的真实目录（`lstat` 与真实路径，3.7 发现现有代码未检查目录本身），文件只收普通文件，拒绝管道等特殊文件；macOS 上读取可再加 `O_NOFOLLOW_ANY`。
- **remote subprocess 插件**按官方 `SubprocessRuntime` 接口实现，参照 KnowWork 的 `remote-subprocess`；DSH 官方 bash、文件工具与 `present` 原样使用。路径只认本 Attempt 工作区。
- **acp Profile 调整：** 1b 停用 `subprocess`、`tool-jobs`，插入 remote subprocess，`tool-bash` 配置 `enableRunInBackground: false`（[执行容器叠加层](../../server/config/dsh/execution-container.cordis.patch.yml)，追加在部署 patch 之后，作用于 Attempt、工具目录探测、MCP 发现与预检的所有 DSH 进程）。阶段 2a 再停用 `bash-sandbox`、`permission` 并改挂 `dsh-bash-local`（`timeoutMs` 60000、`maxTimeoutMs` 600000，与平台单条命令上限一致；3.8）。`fs-sandbox` 保持不变（1c 不替换 `ctx.fs`）。patch 不能替换已有条目的包名，只能停用后插入。插件以 `ctx.provide('subprocess', …)` 注册，不引用 DSH 包，与工具策略插件一样以绝对路径装配。
- **执行器模块**：业务服务内唯一调用容器运行时的代码，由现有 [python-skill-runner.ts](../../server/src/modules/runtime/python-skill-runner.ts) 重构而来；只暴露固定参数的接口（固定姿态、白名单镜像、本 Attempt 工作区挂载），其他代码不再直接拼接 `docker` 命令。它与业务服务同进程、同账号，提供的是代码边界而非账号隔离：业务服务被攻破即可控制容器运行时，须在总览中如实标注。独立账号的执行器组件见第 10 节。

### 4.2 执行容器

沿用 Python 沙箱姿态：

| 项 | 要求 |
| --- | --- |
| 账号与权限 | 非 root、`cap-drop ALL`、`no-new-privileges`、`seccomp`；宿主启用 AppArmor 时附加 |
| 文件系统 | 只读根；只挂本 Attempt 工作区（含 `output/`），按宿主绝对路径挂载（4.1）；`/tmp` 与 `HOME`（LibreOffice 等工具的 profile 目录）为限额 tmpfs；LibreOffice 须显式指定 `-env:UserInstallation` 指向可写目录（容器 uid 无 `passwd` 条目时不会使用 `HOME`，见 3.5） |
| 属主映射 | 容器内非 root uid 须能写工作区；Docker Desktop 由文件共享层映射到宿主用户 |
| 网络 | `none` |
| 资源 | CPU 2、内存 1 GiB（内存+交换相等）、pids 256、单文件 256 MiB（`ulimit -f`，远大于 10 MB 的成果上限，给 Office 转换的中间文件留余量）、单条命令最长 600 s（DSH 默认 60 s）、Attempt 总时长（沿用 Attempt 超时：超时即取消并删除执行容器）；工作区总磁盘用量不设上限（第 8 节） |
| 进程 | `init: true`；命令放入独立进程组，取消与超时整组 `SIGKILL`，容器内看门狗兜底；可能派生进程的命令结束后须确认容器静止，不干净则删除容器（4.1） |
| 镜像 | 摘要锁定、`--pull never`、工具链显式清单（Office 采用原生 LibreOffice；包含 DSH 工具依赖的 `rg` 等二进制，见 4.1 可执行文件映射）；运行时不安装依赖 |
| 环境变量 | 由执行器固定给出 `LANG`、`PATH`、`HOME`、`TMPDIR`；remote subprocess 传来的 env 一律忽略，不合并宿主进程环境 |
| 不可见 | 凭据、`DSH_HOME`、工具桥 socket、其他工作区、宿主与 Worker 的环境变量 |

**环境变量固定而非白名单：** 不逐项校验调用方给出的变量，也就不存在白名单遗漏 `DSH_MCP_VALUE_*` 等凭据变量的风险（KnowWork 只剔除两项，dsh-work 的 Worker 环境含 MCP Bearer）。代价是 `dsh-shell-env` 注入的 `DSH_*` 提示变量不进入容器，对 C 档无实际影响。

### 4.3 输出与后台任务

第一版 remote subprocess 采用收集模式：命令结束后一次返回输出，按字节偏移读取，有总量上限。C 档只有前台单次命令，收集模式足够；`tool-bash` 配置 `enableRunInBackground: false`，不挂载 `tool-jobs`。收集模式下 `job_output` 在后台任务结束前读不到内容，这是 D 档暂缓的原因之一（第 6 节）。

### 4.4 容器粒度、生命周期与并发

**每 Attempt 一个执行容器，一次性使用**：与 Run/Attempt 生命周期对齐，Attempt 结束即删除；每轮都是干净环境，被注入污染的状态不延续。工作区本身每 Attempt 新建（3.1），跨 Attempt 的状态经产物、检查点与附件重新挂载传递（镜像只读、运行时不装包，会话级保留容器内状态的收益有限）。

| 粒度 | 取舍 |
| --- | --- |
| 每次调用（现有 Python） | 开放 Shell 后命令频繁，创建开销叠加、上下文断开 |
| **每 Attempt（采用）** | 回收简单、隔离清洁，同时存在的容器数 ≈ 活跃 Attempt 数 |
| 每会话常驻 | 不减少并发容器数，空闲期也占资源，需要找回、收养与空闲清扫逻辑；不采用 |

**生命周期：** 容器以唯一名称和 label（组件、Attempt）创建，Attempt 终态时删除；服务启动时与周期性按 label 删除孤儿容器（服务崩溃后遗留）。容器从不复用，因此不需要按名称找回、收养核对或姿态摘要重建。某个 Attempt 的容器启动失败后，该 Attempt 后续的命令都返回同一失败，不在 Attempt 内重试启动。预热池不纳入本方案；若 3.5、3.6 的冷启动实测不可接受，另行评审。

`python_execute` 并入执行容器（阶段 1b②，未实施）会改变脚本路径契约：现有 Skill 脚本依赖每次调用的固定挂载（`/skill` 为当前 Skill 目录并作为工作目录、`/input` 只读、`/output` 为本 Skill 的输出目录），而每 Attempt 一个的执行容器无法按调用重新挂载。须先确定新契约（例如改用工作区内的固定路径并提供兼容方案），并同步修改[功能规则第 6 节](../development/feature-rules.md#6-skill-python-执行)。并入后同一 Attempt 内的调用不再各自使用干净容器，可看到此前命令留下的文件。在此之前 Python 仍为每次调用一个容器。

**并发：** 执行容器每 Attempt 一个，数量受 Runtime 并发上限（`runtimes.capacity`）约束，不占全局槽位，因而不会等待槽位；Python 每次调用的容器仍占用全局槽位（`DSH_WORK_EXECUTION_MAX_CONTAINERS`）。两类容器分开计数，不会出现执行容器占着槽位等待 Python 槽位的死锁；1b② 并入后 Python 直接使用所在 Attempt 的执行容器，不再单独占槽位。

### 4.5 执行后端

`ExecutionBackend` 端口保留，首版只实现 `docker`：Mac mini 使用 Docker Desktop（OrbStack、colima 的 docker CLI 兼容）。端口职责：创建/删除执行容器、挂载 Attempt 工作区、按 Manifest 设置资源、取消时整组回收、启动时报告能力（容器运行时与合规镜像是否可用）。能力不满足时可执行工具不出现在模型可见工具中（第 6 节）。Kubernetes、Linux rootless 等实现在出现对应部署形态时再加（第 10 节）。

### 4.6 阶段 2b：Office 工具链与二进制成果（已定案；2b-2、2b-4 已实施，2b-1 部分实施）

2a 放开了 `bash`，但 C 档的主要价值（生成与转换 Office 文件）还到不了用户手里：成果只收 `output/` 顶层的 Markdown、文本、CSV、HTML，引用到下一轮的输入只有解析文本。2b 把执行镜像、成果收集、引用与预览一起补齐。以下“现状”均为 2026-10-27 核对代码的结论。

**现状与问题：**

| 环节 | 现状 | 对 C 档的影响 |
| --- | --- | --- |
| 执行镜像 | 只有本机测试镜像；`DSH_WORK_EXECUTION_IMAGE` 与 `DSH_WORK_PYTHON_IMAGE` 都没有构建流水线 | 生产无法开启执行容器模式 |
| 成果收集 | `publishRuntimeArtifacts` 只接受 `output/` 顶层 `.md`/`.txt`/`.csv`/`.html` 普通文件，单个 ≤10 MB、合计 ≤20 MB；任一文件不合规即抛错，Attempt 以失败结束，助手回答也不提交（回答在收集之后才登记） | 模型写出一个 `.xlsx`、子目录或临时文件，整轮结果丢失 |
| 安全检查 | `BaselineFileSafetyScanner` 只查可执行文件签名；生产应替换为企业杀毒服务（端口已留） | 宏、外部链接、PDF 脚本等活动内容不受检查 |
| 解析与引用 | 成果的解析文本只对 UTF-8 文本生成（`artifactInputText`），`canReference` 依赖 `m4-basic-v1` 解析记录；员工上传的 PDF/DOCX/XLSX 由宿主进程内的 `document-extractor` 解析（自带 ZIP 与流大小上限），PPTX 无解析器 | 二进制成果不能引用；容器产出的文件比员工上传更可能被注入内容操纵 |
| 下一轮输入 | 附件与引用的成果只以解析文本挂载为 `input/*.txt` | 模型看不到原始 `.xlsx`，无法用 pandas 处理，也无法“继续修改”一个 Office 成果 |
| 预览 | HTML 成果在 `sandbox="allow-scripts"`（无 `allow-same-origin`）的 iframe 中预览；Markdown/文本在气泡内展开；xlsx/pdf 卡片只有下载 | Office 成果只能下载后本地打开 |

**设计（按依赖顺序；每步单独提交与验证）：**

1. **2b-1 执行镜像**（部分实施，2026-10-27）。[deploy/execution-image](../../deploy/execution-image/Dockerfile) 与 [执行镜像工作流](../../.github/workflows/execution-image.yml) 已进入仓库：基础镜像 `python:3.12-slim` 按摘要锁定，apt 固定为基础镜像自身记录的快照时间 `20261020T213255Z`；`rg` 取 DSH 依赖的 `@vscode/ripgrep` 1.18.0（ripgrep 15.0.0），按 DSH `pnpm-lock.yaml` 的 integrity 校验；Python 依赖由 `uv pip compile` 生成 linux/aarch64 的哈希锁（截至快照日期）；`soffice`/`libreoffice` 包装脚本位于 `/usr/local/bin`；构建时生成字体缓存（运行时根文件系统只读）。流水线在 `ubuntu-24.04-arm` 上构建后，按执行容器姿态（断网、只读根、无 capabilities、无 `passwd` 条目的 uid、tmpfs `/tmp` 与 HOME）运行 [smoke-test.sh](../../deploy/execution-image/smoke-test.sh)：核对工具链与 `rg` 版本、中文字体，并把含中文的 docx/xlsx/pptx 转为 PDF 与 PNG；PR 只构建与检查，`main` 才推送 GHCR 并附来源证明，摘要写入运行 Summary。`pnpm verify` 的 runtime 组检查各项输入均已锁定。**尚未完成：** 镜像未构建过；执行容器预检与 Runtime 说明的工具链清单等镜像摘要产出、真实 Docker 端到端用例换用该镜像后再实施（提前实施会使现有本机测试镜像无法通过启动检查）。
   - 仓库内维护 Dockerfile：基础镜像按摘要锁定，apt 按快照源（`snapshot.debian.org` 固定日期）安装，pip 依赖按版本与哈希锁定；构建产物按摘要锁定后填入 `DSH_WORK_EXECUTION_IMAGE`，运行时 `--pull never`。
   - 工具链：`bash`、`rg`（与 DSH 依赖的版本对齐）、原生 LibreOffice（writer/calc/impress，nogui）、poppler-utils、pandoc，Python 包 pandas、openpyxl、python-docx、python-pptx；字体见决策 2。
   - `soffice` 包装脚本固定加 `-env:UserInstallation=file://$HOME/.lo-profile`（3.5：容器 uid 无 `passwd` 条目时默认配置失败）。
   - 镜像以 label 声明工具链清单；执行容器预检除 `rg` 外再检查 `bash`、`soffice --version`、`pdftoppm -v`，清单写入 Runtime 说明，模型据此选择工具而不是猜测。
   - 与 Python 镜像的关系：1b② 之后 `python_execute` 也在执行容器中运行，届时两个镜像合一；在此之前 `DSH_WORK_PYTHON_IMAGE` 可指向同一镜像，但不强制。
2. **2b-2 成果收集与校验**（已实施，2026-10-27；宿主侧、执行容器静止之后，沿用 1c 的目录检查）。实现见 `artifact-file-policy.ts`；收集触发条件改为装配了 `write` 或 `bash`（`write` 被紧急停用时 `bash` 写出的成果仍要收集）；二进制成果不生成解析文本，`canReference` 为假，直到 2b-3。Excel 公式中的 DDE 无法可靠识别，记为残余风险由杀毒端口覆盖。
   - 收集失败的语义见决策 8。
   - 接受的格式见决策 3；扩展名与文件头一致（PDF `%PDF-`，OOXML 为含 `[Content_Types].xml` 的 ZIP，PNG/JPEG 文件头），不一致即不合规。
   - 平台策略检查（与可替换的杀毒端口分开），按决策 5 精确拒绝：OOXML 拒绝宏部件（`vbaProject.bin`）、嵌入对象（OLE）、外部数据连接，以及除超链接以外的外部关系（外链图片、模板等打开时会取远程内容的关系）；普通超链接允许。PDF 拒绝 `/JavaScript`、`/JS`、`/Launch`、`/EmbeddedFile`，以及指向脚本的 `/OpenAction`；`/URI` 链接允许。ZIP 沿用 `document-extractor` 的条目数与解压大小上限。被拒绝的文件按决策 8 跳过并说明原因。
   - 大小上限见决策 4；类型、MIME 与下载头（`attachment`、`nosniff`）统一由一处映射给出。
3. **2b-3 解析。**
   - 二进制成果发布时生成 `m4-basic-v1` 解析文本（PDF/DOCX/XLSX 复用现有解析器，PPTX 新增），用于摘要、全文检索与引用；解析失败不阻止发布，只是 `canReference` 为假。
   - 容器产出的文件可能被注入内容刻意构造，宿主进程内解析是新的攻击面。建议改为在执行器管理的一次性容器中解析（经 `ExecutionBackend`，断网、限时、限额，与 Python 同一套姿态），宿主只接收文本结果；员工上传沿用现有解析，不在本阶段迁移。
4. **2b-4 原始文件挂载与跨轮修改**（已实施，2026-10-27）。实现要点：Manifest 新增 `input.original_mounts`（只带引用与摘要，编译器要求同时装配 `bash`）；工具清单确定后由派发器决定挂载；Runtime Adapter 在初始授权复核后经内容服务按 Run 绑定读取原始字节、校验后只读写入 `input/original/`（恢复执行的新 Attempt 沿用同一 Run 的绑定）；执行容器可用时二进制成果的“继续修改”可用；与引用版本内容相同的文件不产生新版本；`run_input_files.extraction_id` 改为可空（迁移 0101）。
   - 本轮装配了 `bash` 时，引用的成果除解析文本外再以只读方式挂载原始文件（`input/<序号>-<名称>.<扩展名>`），Runtime 说明告知“修改时把完整文件写入 `output/<原名>`，平台登记为下一版”（与文本成果的 `artifact_revision` 一致）。
   - 没有 `bash` 时二进制成果只能作为文本参考，不提供“继续修改”。
   - 员工上传的附件同样挂载原始文件（决策 7），落实功能规则第 6 节未完成的“原始 CSV/XLSX 输入的授权暂存”。
5. **2b-5 预览**（决策 6）。
   - 硬约束：不可信的 Office/PDF 内容不在工作台源中渲染；不在宿主运行 LibreOffice；若以后做页面图片渲染，只能经执行器在一次性容器中进行，不新增直接调用 `docker` 的代码。
   - Office/PDF 成果沿用气泡内“查看正文”展示解析文本（标明是解析文本、不含版式）；png/jpg 以 `<img>` 从鉴权下载取得的 Blob 预览。交互沿用现有成果卡与气泡内展开；若需新增独立预览界面，先出可点击原型。
6. **契约与验收。**
   - 前后端 `Artifact['type']` 已含 `xlsx`/`docx`/`pdf`，增补决策 3 中新增的类型；同步 `openapi-workbench.json` 与接口契约测试；员工端成果卡片沿用已有的 xlsx/pdf 卡片样式。
   - 验收目录新增旅程（个人空间、团队空间、项目空间各一）：生成 Office 成果并下载、不合规文件的提示、跨轮修改得到 V2、预览（按决策 6）。
   - C 档 P2：Mac mini 上真实 DSH 生成 xlsx/docx 并转换为 PDF，下载核对内容；含中文的文档（决策 2）。

**不在 2b 范围：** `python_execute` 的输出登记为成果（随 1b②）；D 档后台任务；员工上传解析迁入容器。

**定案（2026-10-27，逐项讨论后均采纳建议）：**

| # | 决策 | 定案 | 理由 |
| --- | --- | --- | --- |
| 1 | 镜像在哪里构建与托管 | GitHub Actions 用 arm64 runner 构建，附来源证明推送 GHCR，Mac mini 按摘要拉取一次后 `--pull never` | 构建可复现、留证，与发布包同一信任链；本仓库为公开仓库，可用 GitHub 标准 arm64 runner（首次构建时确认）；Mac mini 已能访问 GHCR。镜像只含开源软件与公开包，不含凭据 |
| 2 | 中文字体 | 内置 Noto CJK（镜像约增加 100–200 MB） | 企业文档以中文为主，缺字体时 LibreOffice 转出的 PDF 与图表中文缺字 |
| 3 | 接受的成果格式 | 现有文本类之外增加 `.xlsx`、`.docx`、`.pptx`、`.pdf`、`.png`、`.jpg`；不接受 `.svg`、旧版 `.doc`/`.xls` 与启用宏的格式 | SVG 可含脚本；旧版二进制格式难以校验；模型生成的文件不需要宏 |
| 4 | 大小上限 | 单个 20 MB、每轮合计 50 MB（文本类成果同样适用） | 图表较多的 docx/pptx 容易超过 10 MB；仍远低于容器单文件 256 MiB |
| 5 | 活动内容 | 精确拒绝（见 2b-2）：宏、OLE、外部数据连接、取远程内容的外部关系、PDF 脚本/启动/嵌入文件；允许普通超链接 | 一律拒绝外部关系会误伤所有带链接的文档；剥离会改变用户拿到的文件 |
| 6 | 预览 | 解析文本 + 图片；页面图片渲染作为后续增强；不采用浏览器内 PDF 查看器 | 安全、无新组件；页面图片需要每次发布多一次容器转换，待有需求再做 |
| 7 | 员工上传附件挂载原始文件 | 装配 `bash` 时以只读方式同时挂载原始文件，解析文本照常提供；授权沿用现有附件挂载校验 | C 档的准确计算、多表关联主要针对员工上传的表格 |
| 8 | 收集失败的语义 | 跳过不合规文件（格式、子目录、隐藏文件、超限、安全检查不通过），登记其余成果；被跳过的文件不落盘，回答下方列出文件与原因，并记入 Attempt 事件，结果核验据此标为未完全达成 | 一个误写的临时文件不应让整轮回答丢失 |

## 5. 分阶段

| 阶段 | 内容 | 收益 | 前提 |
| --- | --- | --- | --- |
| 1a（已实施） | 执行器模块与 `ExecutionBackend` 端口（`docker` 实现），由 `python-skill-runner` 重构；`python_execute` 改经执行器（仍为每次调用一个容器）；孤儿清扫（启动时全量清扫，运行中只重试本进程删除失败的容器）；全局并发槽位（`DSH_WORK_EXECUTION_MAX_CONTAINERS`，按服务实例计算，删除确认前占用） | 容器参数集中在一处、经固定接口调用，业务代码不再直接拼接 `docker` 命令 | 不改 DSH |
| 1b①（已实施） | 执行容器模式开关（默认关闭，启动时确定，失败则本次启动退回宿主执行并在健康状态报告不可用）；执行容器（每 Attempt 惰性创建、Attempt 结束删除、启动清扫）；remote subprocess 经工具桥 `/subprocess/exec` 与平台中转（`rg` 映射，`glob`、`grep` 在容器内运行）；固定环境变量；命令逐条审计（`run.container.command`）；进程组终止与容器内看门狗 | 命令类工具进入执行容器 | 1a；3.5 探针 |
| 1b② | `python_execute` 并入执行容器（4.4） | 同一 Attempt 只有一个执行容器 | 1b①；确定脚本路径契约 |
| 1c（已实施） | “静止”保证（3.7、4.1）：命令后清扫与“不干净就删除容器”、超时与取消时由 `/authorize-execution` 等待清理、静止无法恢复时 Attempt 失败；检查点读取与成果发布先确认 `output/` 本身；工具独占性纳入 DSH 升级准入测试 | 容器内代码无法利用宿主文件操作的竞态或替换后的目录越界 | 1b①；3.7 探针（已完成） |
| 2a（已实施） | 放开 C 档单次 `bash`：叠加层改挂 `dsh-bash-local`、平台只接受 `bash -c` 形式；内置工具注册表新增 `bash`（装配方式 `execution-container`，风险中）；执行容器可用时员工侧 Agent 运行装配、Runtime 无执行容器时拒绝带 `bash` 的 Manifest；单文件大小上限；Runtime 说明告知容器限制与 `output/` 规则；管理端 Runtime 页面显示执行容器状态；安全回归；同步总览、功能规则与内部端口（3.8） | 模型可“写代码 → 运行 → 看结果 → 修正”，覆盖数据处理与准确计算 | 1a–1c 完成（放开 bash 前必须先有“静止”保证，见 4.1）；第 6 节前置事项已定案 |
| 2b（方案见 4.6，已定案） | Office 生产镜像；二进制成果的收集、校验、解析、跨轮修改与预览；收集失败改为跳过并提示 | Office 文件生成、转换与交付 | 2a；4.6 已定案 |

已定以 C 档为目标，1c 是阶段 2 的必要前提，不推迟。“静止”保证不改变文件工具的执行位置，读写不经容器 `exec`；代价是每条 `bash` 命令后多一次静止确认（约 0.1 s，异常时删除并重建约 0.4 s，3.7）。

## 6. 可执行能力：决策与待定事项

**决策（2026-10-26）：以 C 档为目标；D 档暂缓。**

- **C 档范围：** 前台单次 `bash`（`tool-bash` 配置 `enableRunInBackground: false`，不挂载 `tool-jobs`）与执行容器内的 Office 工具链。模型用文件工具写出脚本，再经 `bash` 运行（如 `python x.py`），因此 C 档已覆盖 B 档能力，不另设“提交 Python 源码”的工具。`python_execute` 保持只运行已激活 Skill 登记入口的约束。
- **D 档暂缓的原因：** DSH 后台任务挂在 Worker 进程上，dsh-work 每 Attempt 一个 Worker、执行容器随 Attempt 回收，后台任务在 Attempt 结束时一并终止，只能用于单个 Attempt 内的并行或较长命令；收集模式下 `job_output` 在任务结束前读不到内容（4.3）；中断后不可恢复（第 2 节）。跨轮的长任务需求按定时任务或持久化等待另行设计，不经 D 档解决。C 档稳定后若仍需要 D 档，另行评审。
- **生效条件：** 2a 已把 `bash` 加入内置工具注册表并同步总览、功能规则与内部端口（2026-10-27），但只在执行容器模式开启且启动检查通过时装配；该模式默认关闭，在 2b 完成并通过第 9 节 P2 验收前不在生产开启，[总览第 1 节](../development/overview.md#1-产品定位与范围)“MVP 不包含任意 Shell”在此之前继续有效。

**不放开时的影响（决策背景）：** 知识查询与企业系统只读查询基本不受影响；MVP 场景 3（文件分析与成果交付）中的准确统计、多表关联、生成格式规范的 Excel/Word、格式转换等，只能依赖预制 Skill，模型无法“写代码 → 运行 → 看结果 → 修正”。

**评估过的档位（已选 C）：**

| 档位 | 内容 | 能力 | 隔离要求 | 体验、审计与改造 |
| --- | --- | --- | --- | --- |
| A | 不放开，常用能力做成平台工具或 Skill | 取决于预制覆盖面 | 无新增 | 不涉及 |
| B | 允许模型提交 Python 源码，在执行容器中运行（不开放 Shell） | 覆盖数据处理、计算、文件生成的大部分需求 | 与 C 相同：Python 可调用 `subprocess`、`os.system`，等同在执行容器中执行任意代码 | 只有 Python 工具链；审计对象是源码，较易阅读；需修改功能规则第 6 节“模型不能提交源码”的约束 |
| C | 放开单次 `bash` 与 Office 工具链 | 加上格式转换、渲染检查等命令行能力 | 同 B | 命令行工具链完整；审计对象是命令行 |
| D | C + 后台任务 | 长时间任务 | 同 B；另需进程数与时长上限 | 受 4.3 收集模式限制 |

B、C、D 的风险由执行容器姿态决定，隔离要求相同，不能因“只放开 Python”而放宽姿态；档位差异在能力面、体验与审计可读性。

**阶段 2 前置事项（2026-10-26 定案）：**

1. **开关粒度：平台默认装配，不设 Agent 开关。** `bash` 与 `read`、`glob`、`grep` 一样由平台默认装配（注册表 `assembly` 为默认），员工侧 Agent 运行（工作台对话、定时任务、发布试运行）默认可用；会话摘要、项目档案员、管理助手、Skill 安装与 Skill 试运行等系统与管理用途不装配。全局关闭依靠 Runtime 紧急停用（立即生效）或关闭执行容器模式；执行容器不可用时 `bash` 不出现在模型可见工具中。每个 Attempt 的 Manifest 固定实际装配的工具清单，可追溯。
   - 影响：上线后所有已发布的员工侧 Agent 都获得代码执行能力，而它们的发布验证是在没有 `bash` 时做的，回答方式可能变化。上线后应挑选关键 Agent 重新试运行，并在发布说明中告知。
   - 审批模式为“从不”的 Agent 会直接执行代码而不经员工确认；代码只在断网的执行容器内运行（4.1、4.2）。
2. **网络：一律断网。** 依赖只能预装在执行镜像中；经出口代理访问白名单域名仍属第 10 节后续方向。
3. **审批：`bash` 风险等级为“中”（与 `python_execute` 相同），是否确认由 Agent 版本现有的审批模式决定，不另设规则。** 发布试运行允许执行：执行容器断网，没有外部效果；MCP 与平台工具的 `trial_only` 维持现状。
4. **数据：与现有工作区一致。** 本次运行已授权给该 Agent 的数据都可以进入执行容器（附件、激活 Skill 的资源、知识检索与 MCP 结果经模型写入的文件）；容器断网，不形成新的外传通道。产物只经 `output/` 与交付流程离开，交付仍按当前人员与工作空间授权。

**C 档必须满足的治理要求（任何档位同样适用）：**

| 要求 | 说明 |
| --- | --- |
| 审计 | 命令逐条记录命令、退出码、耗时、输出摘要，进入 Attempt 事件，不保存完整输出正文；文件工具调用沿用工具层记录（4.1） |
| 进程组终止 | 取消与超时须杀死整个进程组（4.2） |
| 资源上限 | CPU、内存、pids、文件大小、单命令超时、Attempt 总时长 |
| 镜像 | 摘要锁定、`--pull never`、包含的工具链显式清单；运行时不安装依赖 |
| 外泄面 | 执行容器断网 |
| 不可用时 | 部署环境不满足隔离要求时，可执行工具不出现在模型可见工具中，并在管理端 Runtime 页面说明原因 |

## 7. 其他未支持工具

| 工具 | 阻塞点 | 路径 |
| --- | --- | --- |
| 前台单次 `bash`（含经 `bash` 运行模型写的脚本） | 执行世界 | 阶段 2，C 档（第 6 节） |
| `bash` 的 `run_in_background`、`job_output`/`job_kill` | 生命周期随 Attempt 结束、收集模式无中途输出 | D 档暂缓（第 6 节、第 10 节） |
| 持久化 bash、终端 | 执行世界 + 终端会话 | 第 10 节 |
| `web_fetch` | 数据出口治理，与沙箱无关 | 第 10 节 |
| Agent 协作、子 Agent | 委派已删除，需产品重设计 | 不在本方案 |
| Runtime 控制类工具 | 越过平台边界 | 继续拒绝 |

## 8. 风险

| 风险 | 处理 |
| --- | --- |
| 执行容器冷启动叠加在每轮执行上 | 已实测约 0.2 s（3.5）；不可接受时另行评审预热池（4.4） |
| 每条命令后的静止确认增加延迟 | 清扫约 0.1 s，异常时重建约 0.4 s（3.7）；不为性能跳过确认 |
| 命令留下进程、或超时后清理未完成时宿主读写工作区 | 命令后清扫，不干净即删除容器；清理完成前 `/authorize-execution` 等待或拒绝；无法恢复时 Attempt 失败（4.1） |
| DSH 升级后文件工具改为可并行 | 工具独占性纳入 DSH 升级准入测试（3.7） |
| 默认工具 `glob`、`grep` 在容器内找不到宿主 ripgrep | 可执行文件白名单映射到镜像内 `rg`（4.1），P1 覆盖 |
| DSH 与容器看到的路径不一致 | 工作区按宿主绝对路径挂载（4.1） |
| 宿主侧读取经工作区内符号链接越界 | 静止期间读取；先确认 `output/` 等目录本身、只收普通文件（4.1），安全回归覆盖 |
| 服务端成为命令执行的单点 | 中转无状态，随 Attempt 终态回收；服务端不可用时 Attempt 失败，不降级为本地执行 |
| 执行器模块与业务服务同进程同账号 | 固定参数接口，镜像白名单，拒绝任意参数；总览如实标注为代码边界而非账号隔离；账号隔离见第 10 节 |
| DSH 升级改变 `ctx.subprocess` 接口 | remote subprocess 插件纳入 DSH 升级准入测试 |
| 凭据经环境变量进入容器 | 容器环境变量由执行器固定，忽略传入 env（4.2），安全回归覆盖 |
| 服务崩溃遗留容器 | 启动与周期清扫按 label 删除（4.4） |
| 命令写满宿主磁盘 | 单文件 256 MiB 上限；工作区总用量未设上限，依赖 Attempt 超时与工作区随 Attempt 回收，必要时另行评审配额 |
| 模型在 `output/` 写入不支持的格式或子目录，导致成果登记失败 | Runtime 说明要求中间文件放在工作区其他目录或 `/tmp`；Office 等二进制成果的登记与预览、收集失败改为跳过并提示，见 4.6 |

## 9. 验证

| 层级 | 内容 |
| --- | --- |
| 单元 | 执行器参数白名单、容器参数生成、固定环境变量、路径映射、可执行文件映射、令牌校验、静止确认与“不干净就删除”、清理期间授权探测等待、`output/` 目录本身的检查、进程组终止、能力报告、孤儿清扫 |
| P1 集成 | 受控 DSH + 假上游：remote subprocess 经工具桥与平台到达执行容器；命令留下的后台进程在下一个工具前被清除；`glob`、`grep` 在容器内返回与宿主一致的结果；DSH 与容器内命令使用同一路径；审批仍在工具层生效，收权后底层操作立即被拒；取消与超时回收；断网验证；跨 Attempt 不可见 |
| 安全回归 | 执行容器内读取 `/proc`、凭据路径、工具桥 socket、其他工作区、Worker 环境变量均失败；执行容器无法连接工具桥；出网失败；工作区内指向外部的符号链接（含把 `output/` 本身换成链接）在文件工具、产物收集与检查点复制中均被拒绝；`setsid`、`nohup` 留下的进程与进程数耗尽都不能让后续工具在容器非静止时执行；白名单外的可执行文件被拒绝 |
| P2 真实验收 | Mac mini 在目标 DSH 版本下逐场景留证；C 档放开时另行验收：模型写脚本经 `bash` 运行并生成 Office 产物、`run_in_background` 被拒绝、`job_*` 工具不可见 |

Mock、探针或 P1 通过不能代替 P2。

**2a 的覆盖（2026-10-27）：** 单元 `execution-container.test.ts`（`bash -c` 是唯一接受的 shell 形式、叠加层停用与插入项、容器参数含单文件上限）、`builtin-tools.test.ts`（装配方式、Skill 不能声明）、`runtime-adapter.test.ts`（无执行容器时拒绝带 `bash` 的 Manifest、Runtime 说明）；集成 `builtin-tools.integration.test.ts`（员工对话仅在执行容器可用时装配 `bash`，紧急停用同样生效）；真实 DSH + 真实 Docker `execution-container.e2e.test.ts`（opt-in）：`bash` 以服务用户在容器内运行并写入共享工作区、DSH 不另行要求审批、Worker 环境变量/工具桥 socket/`DSH_HOME`/其他 Attempt 工作区/项目文件在容器内不可见、出网失败、根文件系统只读、`setsid`/`nohup` 残留在下一个工具前已清除、`bash` 超过自身时限（`timeoutMs`）时平台中断请求并整组杀掉容器内进程、`run_in_background` 被拒绝、`job_*` 不可见、只有 `rg` 与 `bash` 到达容器且逐条审计；`execution-container-startup.integration.test.ts` 覆盖叠加 `dsh-bash-local` 后的启动准入（`bash` 仍独占调度）。未覆盖：P2、Office 产物、用户取消 Run 时 `bash` 的端到端回收（执行器层的中断已由真实 Docker 用例覆盖）。

## 10. 后续方向（不在本方案范围）

以下内容不是 C 档的前提，需要时另行立项，届时以本方案第 3 节的事实与探针为背景：

- **模型网关与 MCP 代理：** 见[模型路由方案第 7 节](model-routing-plan.md#7-第二阶段模型网关另行立项)。Worker 改为只持有短期令牌，缓解 DSH 自身被提示词注入或漏洞攻破时的长期凭据暴露。执行容器的环境变量由执行器固定（4.2），模型可执行的代码本就接触不到 Worker 凭据，网关不是放开 C 档的前提。
- **Worker 进容器：** 隔离 DSH 自身漏洞的纵深防御。可沿用 3.4 的加固姿态与预编译只读 `tsx` 缓存；macOS 上工具桥需经虚拟机内中继容器（3.3），Linux 可绑定挂载宿主 socket（未验证）。需解决 Worker 镜像体积（2.0 GB 源码检出）与禁止共享可写缓存的问题。
- **独立账号的执行器组件与其他部署形态：** 出现 Linux 单机或 Kubernetes 部署时，执行器拆为独立组件（rootless Docker / Podman，或仅限本命名空间 Pod 的 RBAC），新增对应 `ExecutionBackend` 实现，可选 gVisor/Kata。Mac mini 上 Docker Desktop 按登录用户运行，账号隔离需专用账号运行容器运行时（如 colima），需单独验证。
- **持久化 bash、终端：** remote 实现需补 `spawnTerminal`，可能需要会话级容器。
- **受控联网：** `web_fetch` 与执行容器出网经平台出口代理，域名白名单与逐请求审计。
- **D 档后台任务：** C 档稳定后另行评审（第 6 节）。
