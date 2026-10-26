# 执行隔离与受控 Shell 方案

**状态：** 阶段 1a 已实施（2026-10-26）；阶段 1b 的 subprocess 部分已实施（2026-10-26，开关 `DSH_WORK_EXECUTION_CONTAINER` 默认关闭；单元、集成、本机真实 Docker 与真实 DSH 端到端用例通过），`python_execute` 并入执行容器另作 1b②，待确定脚本路径契约（4.4）；Mac mini 验收均未执行。可执行能力已定以 **C 档**（单次 `bash` 与 Office 工具链）为目标，D 档（后台任务）暂缓（第 6 节）；在阶段 1a–2 实施并通过第 9 节验收前均不可用。<br>
**更新日期：** 2026-10-26（按 KnowWork 源码复核修订：执行通道经平台中转、阶段重排、容器粒度与并发、产品决策新增中间选项；评审修订：审批保留在工具层、路径一致与可执行文件映射、宿主侧符号链接防护、阶段 1 拆分、档位按隔离要求重评；决定以 C 档为目标；简化：执行器改为服务内模块、只实现 docker 后端、容器按一次性容器管理、文件工具审计复用工具层记录、容器环境变量固定、非 C 档内容移至第 10 节后续方向）<br>
**依据：** 当前 Runtime Adapter、Platform Tool Bridge、DSH 工具策略与 Python 执行代码；DSH `0.1.2-rc.1`（`76fda72979`）的 `dsh-sandbox*`、`dsh-fs*`、`dsh-subprocess*`、`dsh-shell*`、`dsh-e2b` 系列源码与 README；KnowWork v0.0.2（`83c763e`）runtime-host 与会话沙箱实现（对照参考）；2026-10-25 两次本地探针（第 3 节）。<br>
**执行基线：** 每个 Attempt 一个独立 DSH ACP Worker，不改变进程模型；不新增执行循环。

## 1. 背景与目标

当前执行隔离分两层，强度不一致：

- **Python 执行**已在容器中：每次 `python_execute` 启动一个断网、只读根、非 root、`cap-drop ALL`、`seccomp`、资源受限、镜像按摘要锁定的临时容器（[功能规则第 6 节](../development/feature-rules.md#6-skill-python-执行)、[python-skill-runner.ts](../../server/src/modules/runtime/python-skill-runner.ts)）。入口只能是已激活 Skill 登记的 `.py` 文件，模型不能提交源码。
- **DSH Worker 本身**作为宿主机上的服务账号进程运行。文件工具的范围由 [dsh-work-tool-policy.js](../../server/config/dsh/dsh-work-tool-policy.js) 在应用层校验（`realpath` 后须位于 `DSH_WORKSPACE_ROOT` 内、写入限于 `output/`），不是操作系统边界。策略缺陷或 DSH 文件工具漏洞的影响面是服务账号可读的整台机器，包括 `DSH_HOME` 中的模型凭据。

同时，`bash`、终端、后台任务等 DSH 原生工具不在[内置工具注册表](../../server/src/modules/runtime/builtin-tools.ts)中，模型也不能执行自己写的代码，数据处理、准确计算、Office 文件生成与转换等能力只能依赖预制 Skill（影响见第 6 节）。

目标：

1. 模型可触达的文件与命令操作落在操作系统级隔离的执行容器中；
2. 受控放开 C 档可执行能力（单次 `bash` 与 Office 工具链，第 6 节）；
3. 模型可执行的代码永远接触不到凭据、平台工具桥和其他 Attempt 的数据；
4. 每次文件与命令操作都经平台鉴权，收权立即生效；命令由平台逐条审计，文件工具调用沿用工具层记录。

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

本方案采用其“执行世界整体替换、经平台中转”的结构与上述工程细节；不采用其沙箱默认姿态、`docker.sock` 挂载方式与共享 DSH 进程模型（dsh-work 保持每 Attempt 一个 Worker 进程）。

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
| `ctx.fs` | `fs-sandbox`（`dsh-fs-sandbox`，继承宿主 `LocalFileSystem`，写入按 `sandbox-policy` 围栏） | 1c 替换；1b 保持 |
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
- **remote fs 可移植性**：KnowWork 的 `remote-fs` 基于 DSH `0.2.1-rc.2`；`0.1.2-rc.1` 的 `FileSystem` 抽象基类存在（3.1），能否直接移植需测试验证（1c）。
- **可选简化：宿主侧安全文件访问（待验证）**：remote fs 的 `stat`、`read`、`write` 等操作改由平台在宿主上直接读写挂载的工作区，只有命令进入执行容器。平台本就需要逐级不跟随符号链接的宿主侧读写能力（产物收集、检查点复制等，4.1），remote fs 可复用同一模块，并省去每次文件操作一次容器 `exec` 的开销。前提是能可靠地逐级不跟随符号链接并防检查后替换：macOS 需 `O_NOFOLLOW_ANY`，Linux 需 `openat2` 的 `RESOLVE_BENEATH`；Node 未直接提供 `openat` 与逐级解析，可能需要小型原生辅助模块。须在阶段 1c 设计评审前验证；不可行则 remote fs 维持在执行容器内 `exec`。

## 4. 方案

### 4.1 执行链路：经平台中转

```text
DSH Worker（每 Attempt 一个，宿主进程）
  工具层：dsh-work-tool-policy 按工具调用复核授权与审批（ask → ACP → 平台），现有机制不变
  本地 filesystem / subprocess 插件停用
  dsh-work-remote-fs / dsh-work-remote-subprocess
        │ 每 Attempt 工具桥（Unix socket 0600 + Attempt 令牌）
        ▼
平台（业务服务）
  操作层：校验 Attempt 令牌与当前授权 → 配额 → 路径与可执行文件映射 → 命令审计
  执行器模块（唯一调用容器运行时的代码，固定参数接口）
        │ exec / archive
        ▼
执行容器（非 root、只读根、默认断网，只挂本 Attempt 工作区，挂载路径与宿主一致）
```

- **Worker 与执行容器之间没有直接通道。** Worker 不需要容器控制权，也不需要第二条网络通道；执行容器不需要访问任何宿主服务。
- **职责分两层：**
  - **工具层（DSH 策略插件）**负责审批。服务端经工具桥收到的是 `exec`、`read`、`write`、`stat` 等底层操作，一次工具调用可能对应多次底层操作，服务端看不到工具调用本身，无法按工具审批，也对不上审批记录的 `resource_ref`，因此审批保留在工具层（3.1）。
  - **操作层（服务端）**负责每个底层操作的令牌与当前授权校验（收权立即生效）、配额、路径与可执行文件映射、命令审计。
- **绕过问题靠隔离解决。** 3.1 中“可直连工具桥的进程可绕过审批”的前提是模型代码能接触工具桥 socket；可执行能力放开后，模型代码只在执行容器中运行，接触不到 socket。
- **试运行不在操作层另做隔离。** 执行容器断网，底层操作没有外部效果；MCP 与平台工具的 `trial_only` 维持现状。
- **审计。** 平台对命令逐条记录（`bash` 与 `python_execute`：命令、退出码、耗时、输出摘要），进入 Attempt 事件。文件工具调用沿用工具层已有记录（3.1：Attempt 事件含工具名与状态，参数在 DSH 会话日志），平台不按底层文件操作另做审计，也不需要把底层操作与工具调用关联。
- **路径一致。** 执行容器把 Attempt 工作区按宿主绝对路径原样挂载（可另提供 `/workspace` 别名），DSH、模型与容器内命令看到同一路径。否则模型从工具输出取得的宿主路径在容器命令中不存在，容器命令输出的 `/workspace/...` 路径交给 DSH 文件工具也对不上。KnowWork 以容器内 `/sessions/<会话 id>` → `/workspace` 符号链接达到同一效果。路径中含租户、Run 与 Attempt 标识，不含凭据。
- **可执行文件映射。** remote subprocess 只接受白名单内的可执行文件：DSH 自带二进制按白名单映射到镜像内同名工具，`@vscode/ripgrep` 的 `rgPath`（平台专用包路径，如 `@vscode/ripgrep-darwin-arm64/bin/rg`，见 3.5）映射为镜像内 `rg`（版本与 DSH 依赖对齐），保证默认工具 `glob`、`grep` 可用（3.1）；其他宿主绝对路径一律拒绝。
- **可执行能力放开时文件操作必须同步改为远程。** 执行容器能运行代码后，可在共享工作区创建指向外部的符号链接，或在检查与使用之间替换路径；DSH 文件工具若仍在宿主执行，`realpath` 校验存在检查与使用之间的竞态。remote fs 的实现方式（宿主侧安全文件访问或容器内 `exec`）视 3.6 的验证结果确定。
- **宿主侧读取工作区逐级不跟随符号链接。** 产物收集、检查点复制、输入挂载、平台工具读写工作区等所有宿主侧操作，逐级不跟随符号链接（或改为在执行容器内读取后交付），只接受普通文件，并防检查与使用之间被替换。KnowWork 在容器内读取，最后一级不跟随即可；dsh-work 在宿主读取，要求更严。
- **remote 插件**按官方 `SubprocessRuntime`、`FileSystem` 接口实现，参照 KnowWork 的 `remote-subprocess`、`remote-fs`；DSH 官方 bash、文件工具与 `present` 原样使用。路径只认本 Attempt 工作区。
- **acp Profile 调整：** 1b 停用 `subprocess`、`tool-jobs`，插入 remote subprocess，`tool-bash` 配置 `enableRunInBackground: false`（[执行容器叠加层](../../server/config/dsh/execution-container.cordis.patch.yml)，追加在部署 patch 之后，作用于 Attempt、工具目录探测、MCP 发现与预检的所有 DSH 进程）。停用 `bash-sandbox`、`permission` 并改挂 `dsh-bash-local` 只在放开 bash 时才需要，留到阶段 2（3.5 已验证可装配）。1c 时再以 remote fs 替换 `fs-sandbox`。patch 不能替换已有条目的包名，只能停用后插入。插件以 `ctx.provide('subprocess', …)` 注册，不引用 DSH 包，与工具策略插件一样以绝对路径装配。
- **执行器模块**：业务服务内唯一调用容器运行时的代码，由现有 [python-skill-runner.ts](../../server/src/modules/runtime/python-skill-runner.ts) 重构而来；只暴露固定参数的接口（固定姿态、白名单镜像、本 Attempt 工作区挂载），其他代码不再直接拼接 `docker` 命令。它与业务服务同进程、同账号，提供的是代码边界而非账号隔离：业务服务被攻破即可控制容器运行时，须在总览中如实标注。独立账号的执行器组件见第 10 节。

### 4.2 执行容器

沿用 Python 沙箱姿态：

| 项 | 要求 |
| --- | --- |
| 账号与权限 | 非 root、`cap-drop ALL`、`no-new-privileges`、`seccomp`；宿主启用 AppArmor 时附加 |
| 文件系统 | 只读根；只挂本 Attempt 工作区（含 `output/`），按宿主绝对路径挂载（4.1）；`/tmp` 与 `HOME`（LibreOffice 等工具的 profile 目录）为限额 tmpfs；LibreOffice 须显式指定 `-env:UserInstallation` 指向可写目录（容器 uid 无 `passwd` 条目时不会使用 `HOME`，见 3.5） |
| 属主映射 | 容器内非 root uid 须能写工作区；Docker Desktop 由文件共享层映射到宿主用户 |
| 网络 | `none` |
| 资源 | CPU、内存（内存+交换相等）、pids、`fsize`、单命令超时、Attempt 总时长 |
| 进程 | `init: true`；命令放入独立进程组，取消与超时整组 `SIGKILL`，容器内看门狗兜底 |
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

## 5. 分阶段

| 阶段 | 内容 | 收益 | 前提 |
| --- | --- | --- | --- |
| 1a（已实施） | 执行器模块与 `ExecutionBackend` 端口（`docker` 实现），由 `python-skill-runner` 重构；`python_execute` 改经执行器（仍为每次调用一个容器）；孤儿清扫（启动时全量清扫，运行中只重试本进程删除失败的容器）；全局并发槽位（`DSH_WORK_EXECUTION_MAX_CONTAINERS`，按服务实例计算，删除确认前占用） | 容器参数集中在一处、经固定接口调用，业务代码不再直接拼接 `docker` 命令 | 不改 DSH |
| 1b①（已实施） | 执行容器模式开关（默认关闭，启动时确定，失败则本次启动退回宿主执行并在健康状态报告不可用）；执行容器（每 Attempt 惰性创建、Attempt 结束删除、启动清扫）；remote subprocess 经工具桥 `/subprocess/exec` 与平台中转（`rg` 映射，`glob`、`grep` 在容器内运行）；固定环境变量；命令逐条审计（`run.container.command`）；进程组终止与容器内看门狗 | 命令类工具进入执行容器 | 1a；3.5 探针 |
| 1b② | `python_execute` 并入执行容器（4.4） | 同一 Attempt 只有一个执行容器 | 1b①；确定脚本路径契约 |
| 1c | remote fs（实现方式视 3.6 宿主侧安全文件访问的验证结果）；宿主侧读取逐级不跟随符号链接 | 文件工具从应用层边界升级为隔离边界 | 1b①；3.6 宿主侧安全文件访问验证；remote fs 在 `0.1.2-rc.1` 上验证 |
| 2 | 放开 C 档：单次 `bash`（关闭后台运行）与 Office 工具链；同步修改总览、功能规则与内置工具注册表（第 6 节） | 模型可“写代码 → 运行 → 看结果 → 修正”，覆盖数据处理、准确计算、Office 文件生成与转换 | 1a–1c 完成（文件操作必须先改为远程，见 4.1）；第 6 节待定事项定案 |

已定以 C 档为目标，1c 是阶段 2 的必要前提，不推迟。1c 单独看安全收益有限（只防 DSH 文件工具自身漏洞），并可能给每次文件操作增加中转延迟，须在 1c 实测并控制。

## 6. 可执行能力：决策与待定事项

**决策（2026-10-26）：以 C 档为目标；D 档暂缓。**

- **C 档范围：** 前台单次 `bash`（`tool-bash` 配置 `enableRunInBackground: false`，不挂载 `tool-jobs`）与执行容器内的 Office 工具链。模型用文件工具写出脚本，再经 `bash` 运行（如 `python x.py`），因此 C 档已覆盖 B 档能力，不另设“提交 Python 源码”的工具。`python_execute` 保持只运行已激活 Skill 登记入口的约束。
- **D 档暂缓的原因：** DSH 后台任务挂在 Worker 进程上，dsh-work 每 Attempt 一个 Worker、执行容器随 Attempt 回收，后台任务在 Attempt 结束时一并终止，只能用于单个 Attempt 内的并行或较长命令；收集模式下 `job_output` 在任务结束前读不到内容（4.3）；中断后不可恢复（第 2 节）。跨轮的长任务需求按定时任务或持久化等待另行设计，不经 D 档解决。C 档稳定后若仍需要 D 档，另行评审。
- **生效条件：** 本决策是目标，不是已支持能力。[总览第 1 节](../development/overview.md#1-产品定位与范围)“MVP 不包含任意 Shell”、[总览 3.6](../development/overview.md#36-工具分类与管理边界)“注册表以外的 `bash` 一律不放行”与[功能规则第 6 节](../development/feature-rules.md#6-skill-python-执行)在阶段 2 交付并验收前继续有效；阶段 2 交付时同步修改总览、功能规则与内置工具注册表。

**不放开时的影响（决策背景）：** 知识查询与企业系统只读查询基本不受影响；MVP 场景 3（文件分析与成果交付）中的准确统计、多表关联、生成格式规范的 Excel/Word、格式转换等，只能依赖预制 Skill，模型无法“写代码 → 运行 → 看结果 → 修正”。

**评估过的档位（已选 C）：**

| 档位 | 内容 | 能力 | 隔离要求 | 体验、审计与改造 |
| --- | --- | --- | --- | --- |
| A | 不放开，常用能力做成平台工具或 Skill | 取决于预制覆盖面 | 无新增 | 不涉及 |
| B | 允许模型提交 Python 源码，在执行容器中运行（不开放 Shell） | 覆盖数据处理、计算、文件生成的大部分需求 | 与 C 相同：Python 可调用 `subprocess`、`os.system`，等同在执行容器中执行任意代码 | 只有 Python 工具链；审计对象是源码，较易阅读；需修改功能规则第 6 节“模型不能提交源码”的约束 |
| C | 放开单次 `bash` 与 Office 工具链 | 加上格式转换、渲染检查等命令行能力 | 同 B | 命令行工具链完整；审计对象是命令行 |
| D | C + 后台任务 | 长时间任务 | 同 B；另需进程数与时长上限 | 受 4.3 收集模式限制 |

B、C、D 的风险由执行容器姿态决定，隔离要求相同，不能因“只放开 Python”而放宽姿态；档位差异在能力面、体验与审计可读性。

**阶段 2 前须定案的事项：**

1. **开关粒度：** 按 Agent 版本开关还是按 Skill 声明。
2. **网络：** 执行容器断网；如需联网，经出口代理访问白名单域名属于第 10 节的后续方向，须另行决策白名单由谁维护。
3. **审批：** 可执行工具的风险分类与审批模式；发布试运行是否允许执行（建议沿用 `trial_only` 隔离外部效果，断网前提下允许执行）。
4. **数据：** 哪些附件与知识检索结果可以进入执行容器；产物只经 `output/` 与交付流程离开。

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
| 文件操作经平台中转增加延迟 | 3.6 宿主侧安全文件访问可省去容器 `exec`；1c 实测后再优化，不为性能绕过服务端关口 |
| 默认工具 `glob`、`grep` 在容器内找不到宿主 ripgrep | 可执行文件白名单映射到镜像内 `rg`（4.1），P1 覆盖 |
| DSH 与容器看到的路径不一致 | 工作区按宿主绝对路径挂载（4.1） |
| 宿主侧读取经工作区内符号链接越界 | 逐级不跟随符号链接、只收普通文件、防检查后替换（4.1），安全回归覆盖 |
| 服务端成为文件与命令操作的单点 | 中转无状态，随 Attempt 终态回收；服务端不可用时 Attempt 失败，不降级为本地执行 |
| 执行器模块与业务服务同进程同账号 | 固定参数接口，镜像白名单，拒绝任意参数；总览如实标注为代码边界而非账号隔离；账号隔离见第 10 节 |
| DSH 升级改变 `ctx.fs`/`ctx.subprocess` 接口 | remote 插件纳入 DSH 升级准入测试 |
| 凭据经环境变量进入容器 | 容器环境变量由执行器固定，忽略传入 env（4.2），安全回归覆盖 |
| 服务崩溃遗留容器 | 启动与周期清扫按 label 删除（4.4） |

## 9. 验证

| 层级 | 内容 |
| --- | --- |
| 单元 | 执行器参数白名单、容器参数生成、固定环境变量、路径映射、可执行文件映射、令牌校验、宿主侧逐级不跟随符号链接、进程组终止、能力报告、孤儿清扫 |
| P1 集成 | 受控 DSH + 假上游：remote fs/subprocess 经工具桥与平台到达执行容器；`glob`、`grep` 在容器内返回与宿主一致的结果；DSH 与容器内命令使用同一路径；审批仍在工具层生效，收权后底层操作立即被拒；取消与超时回收；断网验证；跨 Attempt 不可见 |
| 安全回归 | 执行容器内读取 `/proc`、凭据路径、工具桥 socket、其他工作区、Worker 环境变量均失败；执行容器无法连接工具桥；出网失败；工作区内指向外部的符号链接及检查后替换，在产物收集、检查点复制与平台工具读取中均被拒绝；白名单外的可执行文件被拒绝 |
| P2 真实验收 | Mac mini 在目标 DSH 版本下逐场景留证；C 档放开时另行验收：模型写脚本经 `bash` 运行并生成 Office 产物、`run_in_background` 被拒绝、`job_*` 工具不可见 |

Mock、探针或 P1 通过不能代替 P2。

## 10. 后续方向（不在本方案范围）

以下内容不是 C 档的前提，需要时另行立项，届时以本方案第 3 节的事实与探针为背景：

- **模型网关与 MCP 代理：** 见[模型路由方案第 7 节](model-routing-plan.md#7-第二阶段模型网关另行立项)。Worker 改为只持有短期令牌，缓解 DSH 自身被提示词注入或漏洞攻破时的长期凭据暴露。执行容器的环境变量由执行器固定（4.2），模型可执行的代码本就接触不到 Worker 凭据，网关不是放开 C 档的前提。
- **Worker 进容器：** 隔离 DSH 自身漏洞的纵深防御。可沿用 3.4 的加固姿态与预编译只读 `tsx` 缓存；macOS 上工具桥需经虚拟机内中继容器（3.3），Linux 可绑定挂载宿主 socket（未验证）。需解决 Worker 镜像体积（2.0 GB 源码检出）与禁止共享可写缓存的问题。
- **独立账号的执行器组件与其他部署形态：** 出现 Linux 单机或 Kubernetes 部署时，执行器拆为独立组件（rootless Docker / Podman，或仅限本命名空间 Pod 的 RBAC），新增对应 `ExecutionBackend` 实现，可选 gVisor/Kata。Mac mini 上 Docker Desktop 按登录用户运行，账号隔离需专用账号运行容器运行时（如 colima），需单独验证。
- **持久化 bash、终端：** remote 实现需补 `spawnTerminal`，可能需要会话级容器。
- **受控联网：** `web_fetch` 与执行容器出网经平台出口代理，域名白名单与逐请求审计。
- **D 档后台任务：** C 档稳定后另行评审（第 6 节）。
