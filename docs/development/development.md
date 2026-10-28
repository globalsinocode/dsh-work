# 开发与测试

## 本地启动

使用兼容项目的 Node.js（22.19+ 或 24+）和根目录 `package.json` 中 `packageManager` 指定的 pnpm：

```bash
pnpm install --frozen-lockfile
```

### 浏览器冒烟（P0）

默认浏览器冒烟由测试专用服务 [`scripts/testing/p0-smoke-server.ts`](../../scripts/testing/p0-smoke-server.ts) 提供接口：内存假数据和测试身份位于 `server/src/testing/`，应用入口 `server/src/main.ts` 不引用它们（`pnpm verify` 的安全检查会拦截）。冒烟使用独立端口（员工端 4274、管理端 4280、后端 4290），不读取 `.env` 的数据库与身份配置，不需要先启动数据库：

```bash
pnpm test:e2e
```

测试不复用已有服务；测试端口占用时会报错。需要换端口可同时指定 `DSH_WORK_WORKBENCH_PORT`、`DSH_WORK_ADMIN_PORT`、`DSH_WORK_SERVER_PORT`，测试会自动同步页面及 API 地址。冒烟服务只监听 `127.0.0.1`，不属于发布产物。

### 开发环境

服务端没有免数据库的内存模式：启动时必须配置 `DSH_WORK_DATABASE_URL`，所有请求都需要登录。旧的 `DSH_WORK_AUTH_MODE=prototype` 已移除，设置后服务会拒绝启动并提示删除。

1. 准备独立的开发 PostgreSQL 数据库。
2. 若没有 `.env`，从 [配置模板](../../.env.example) 创建；已有配置只修改所需字段。设置实际 `DSH_WORK_DATABASE_URL`。
3. 按 [Runtime 指南](../release/dsh-runtime-delivery.md) 配置独立 DSH checkout、精确版本与模型凭据；模板里的开发电脑路径需替换。
4. 不设置 `DSH_WORK_AUTH_MODE`。按 [独立登录指南](../release/local-authentication.md) 初始化首个管理员账号；AI Hub 按 [接入指南](../release/ai-hub-sso-integration.md) 配置后自动可用。
5. 执行 `pnpm dev:all`，默认入口为员工端 `http://localhost:4174/workbench`、管理端 `http://localhost:4180/overview`、后端 `http://localhost:4190/health`。服务启动会自动运行 SQL 迁移并预检 DSH/Python；执行能力故障隔离见 [内部契约](internal-ports.md#执行能力故障隔离c9)；也可单独执行 `pnpm --filter @dsh-work/server db:migrate`。

使用 Bearer 认证的 MCP Connector 前，开发和生产都必须配置 `DSH_CREDENTIAL_MASTER_KEY`。执行 `openssl rand -base64 32` 生成 32 字节 Base64 密钥，并设置 `DSH_CREDENTIAL_MASTER_KEY_ID`（默认 `v1`）。密钥不进入 PostgreSQL 或 Git；数据库只保存 AES-256-GCM 密文、随机 nonce、认证标签和密钥版本。备份或恢复数据库时必须同时通过独立安全渠道备份或恢复对应主密钥，否则已有 Token 无法解密。

本地完整模式与生产部署使用两套环境文件，且允许 DSH Runtime 目标不同：

- 本地开发使用仓库根目录 `.env`，默认对应 [`.env.example`](../../.env.example) 中的开发兼容 Runtime，可显式设置 `DSH_RUNTIME_COMPATIBILITY=legacy-0.1.1-rc.2`。
- 生产部署使用 `runtime.env`，从 [`deploy/runtime.env.example`](../../deploy/runtime.env.example) 复制，必须匹配生产主 Lock 的正式 Runtime，且 `DSH_RUNTIME_COMPATIBILITY` 必须保持未设置。

不要把生产 `runtime.env` 直接复制到本地，也不要把本地 `.env` 当作生产模板。两者的 DSH 路径、版本锁、认证入口和端口约束都不同。

只做业务功能升级无需启动或修改 AI Hub。SSO、目录、Bootstrap、凭据及身份映射修改必须另外联调；冒烟测试身份不能证明生产权限正确。

## 自动化验证

统一质量入口是 `pnpm ci:check`（= `pnpm ci:static` + `pnpm ci:unit`），具体脚本以 [package.json](../../package.json)、[服务端脚本](../../server/package.json) 和 [CI 工作流](../../.github/workflows/ci.yml) 为准。CI 拆成四个并行 Job：`static`（部署配置、静态检查、类型、lint、构建）、`unit`（服务端与双前端单测）、`integration`（全部 PostgreSQL 集成套件）、`browser`（P0 冒烟与各 P1 浏览器旅程）。

服务端测试按文件名自动归类，不再需要逐个登记：`*.integration.test.ts` 属于集成测试，其余 `*.test.ts`（含 `server/config` 下的 `*.test.js`）属于单元测试。新增测试文件放对位置、用对后缀即可进入 CI；使用测试数据库的文件必须以 `.integration.test.ts` 结尾，`pnpm verify` 会检查。

接口文档 `docs/development/openapi-{admin,workbench,auth,mobile-h5}.json` 由单元测试 `server/src/http/openapi-coverage.test.ts` 与代码逐条比对：`main.ts` 经 `register*Routes` 注册的每个接口都必须写进对应文档，文档里的每个操作都必须有实际路由（参数名不同视为同一路径；`/health*` 探针除外）。新增或删除接口时同步修改文档，否则 `pnpm test:unit` 失败；`main.ts` 不得在路由函数之外直接注册接口。

| 改动范围 | 主要验证命令 |
| --- | --- |
| 完整本地质量门禁 | `pnpm ci:check` |
| 服务端单元测试（全部或按目录） | `pnpm test:unit`、`pnpm test:unit src/modules/run` |
| 服务端集成测试（全部或按目录） | `pnpm test:integration`、`pnpm test:integration src/http` |
| 文档、契约与架构 | `pnpm verify`、`pnpm check:architecture` |
| 类型、UI 与代码规范 | `pnpm typecheck`（含 `scripts/` 下的 TypeScript 脚本，见 `server/tsconfig.scripts.json`）、`pnpm lint` |
| 前端组件、Store 和 API 体验 | `pnpm test:m5:frontend`、`pnpm test:m5:api` |
| Runtime 与模型治理 | `pnpm test:m1`、`pnpm test:m2` |
| 身份 | `pnpm test:sso`、`pnpm test:sso:integration`、`pnpm test:local-auth`、`pnpm test:local-auth:integration`；独立账号浏览器旅程运行 `pnpm test:e2e:local-auth`，登录能力与账号来源运行 `pnpm test:e2e:login-options` |
| 权限与安全 | `pnpm test:m5:security`、`pnpm test:m5:security:integration` |
| 故障与恢复 | `pnpm test:m5:faults`、`pnpm test:m5:faults:integration` |
| 容量 | `pnpm test:m5:capacity:integration` |
| 执行容器（真实 Docker 与真实 DSH，opt-in，不进 CI） | `DSH_WORK_EXECUTION_E2E_IMAGE=<执行镜像引用> pnpm --filter @dsh-work/server test:execution-container:e2e`；需要 `DSH_RUNTIME_HOME`、本机 Docker 与 `DSH_WORK_TEST_DATABASE_URL`，镜像用[执行镜像工作流](../../.github/workflows/execution-image.yml)产出的引用（先按摘要拉取）。其中成果解析用例（2b-3）只需要镜像与 Docker。DSH 要求 Node 22.19+ 或 24+，更低版本会在建会话时报 `no adapter registered for provider` |
| 浏览器冒烟 | `pnpm exec playwright install chromium`、`pnpm test:e2e` |
| Agent 验证与发布（冻结、后台并行验证、判定、发布、回滚、重启收敛与车道容量；隔离 PostgreSQL） | `pnpm test:agent-release:integration` |
| Agent 独立执行身份 P1 浏览器集成 | `pnpm test:e2e:agent-principal`（专用可丢弃 PostgreSQL 与受控服务，不并入 P0 冒烟） |
| Agent 定义与默认工具、MCP 范围 | `pnpm test:agent-draft-policy`、`pnpm test:agent-release:integration`、`pnpm test:mcp:integration`、`pnpm test:e2e:agent-capabilities`（后者使用专用可丢弃 PostgreSQL 与合成 MCP） |

`pnpm verify` 统一运行四组静态检查，也可用 `pnpm verify contracts runtime` 选择范围：

- `project`：必要文件、文档链接、测试命令及 CI 接线。
- `contracts`：API 路径、错误字段、Runtime Schema 和合成测试数据结构。
- `runtime`：版本锁、环境模板、生产兼容限制与探针入口。
- `security`：身份与授权边界、子进程凭据隔离及安全迁移约束。

历史 `verify:m*` 命令已替换为这个入口；函数名、页面文案等重复字符串校验由对应行为测试覆盖。原有 `test:m*` 等具名测试命令继续保留，便于针对性运行；CI 统一使用按文件名归类的 `test:unit` 与 `test:integration`，不再逐个登记。静态检查不代表行为测试成功；`pnpm test:scripts` 验证检查器的拒绝场景和探针流程，不连接 AI Hub、数据库或真实模型。

### scripts 目录约定

| 位置 | 职责 |
| --- | --- |
| `verify.mjs`、`checks/` | 统一静态校验入口及分组规则 |
| `check-architecture.mjs`、`check-secrets.mjs` | 架构边界、凭据扫描，作为独立 lint / CI 检查 |
| `runtime/` | 统一 ACP 探针与模拟测试；使用 `pnpm probe --help` 查看六种模式 |
| `ci/` | 部署检查入口和发布安全、Watcher 回归测试 |
| `release/` | 构建发布包与生成 Manifest |
| `deploy/` | 预检、发布、回滚、备份恢复、证书、网络端点和 launchd 管理 |

按功能维护脚本，不再随里程碑新增 `verify-mN` 文件。发布与部署命令仍由 [部署手册](../release/mac-mini-deployment-runbook.md) 统一说明。`render-endpoint-compose.sh` 负责加载环境并验证 Compose，`.mjs` 负责生成配置；证书签发统一使用 `issue-intranet-certificate.sh`。

PostgreSQL 集成测试必须使用专用可丢弃测试库，禁止使用开发业务库或生产库。测试脚本统一经 `--env-file-if-exists=../.env` 读取 `.env` 中的 `DSH_WORK_TEST_DATABASE_URL`（本地指向 `dsh-work-postgres-local` 的 `postgres` 维护库即可，各套件自建一次性库）；也可在命令行显式覆盖：

```bash
DSH_WORK_TEST_DATABASE_URL='postgres://<test-user>:<test-password>@127.0.0.1:5432/dsh_work_test' pnpm test:sso:integration
```

`pnpm test:integration [目录...]` 与其他 `test:*:integration` 使用同一测试变量，按修改模块选择；集成测试逐个文件串行执行。`pnpm ci:check` 不包含 PostgreSQL 集成测试和浏览器 E2E；GitHub Actions 在 `integration` 与 `browser` 两个 Job 中各自启动 PostgreSQL Service 运行它们。

PF-03 MCP Connector 治理使用 `pnpm test:mcp:integration`，在一次性数据库中验证平台生成标识、Bearer Token 加密存储/运行时解析/轮换、整体发现、按 Agent 选定解析、能力变更待确认与确认后摘要变化、取消租户容量上限、逐调用审计以及停用和删除门禁；该命令使用合成 Runtime，不替代真实 Streamable HTTP MCP 与目标 DSH 的 P2 验收。


PF-07 使用 `pnpm test:pf07:matrix` 校验版本化能力矩阵，`pnpm test:pf07:p1` 执行 PF-01～PF-05 的隔离 PostgreSQL 服务回归；真实环境证据与门禁按 [PF-07 验收手册](pf07-platform-acceptance.md) 单独记录。矩阵静态检查或 P1 绿灯不表示 P2 通过。

默认 `pnpm test:e2e` 始终新建上述 P0 冒烟服务，不连接开发数据库，也不复用已登录的开发实例。数据库和真实权限旅程使用各自的 `test:e2e:*` P1 配置与专用可丢弃测试库；P0 通过不表示真实 DSH/OIDC 验收通过。HTTP/SSO 测试需要临时监听本机端口；`listen EPERM` 表示执行环境限制，应在允许本地监听的环境重跑。

## 必测场景与数据

[mvp-fixtures.json](fixtures/mvp-fixtures.json) 保存合成角色、空间、业务记录、知识和文件元数据，不能视为真实企业接口。服务端种子与前端原型 ID 以各自代码为准，不假定 fixture 已自动导入所有环境。

- 个人空间与团队空间的会话、文件和成果访问；非成员、跨用户及跨数据范围访问拒绝。
- Agent、Skill 测试后发布、版本锁定与回滚；内置工具采用代码注册表的显式清单，Skill 只能引用 Agent 可装配的工具，不能间接扩大工具范围；Runtime 紧急停用即时生效。
- 文件上传、解析、Run 关联、来源与成果版本、下载鉴权；路径穿越、伪造签名和超限文件拒绝。
- 取消、超时、Worker 崩溃、模型/Tool/网络故障；幂等请求不重复执行，只有失败 Run 可重试并生成新 Attempt。
- 服务重启后活动 Attempt 失败收敛、排队任务恢复；SSE 使用 `Last-Event-ID` 重放，旧 Attempt 事件不能覆盖当前重试状态。
- 审计脱敏、凭据隔离、DSH 子进程环境白名单、权限变化即时生效。
- MCP Connector 按 Agent Version 的 `selected` 或 `none`（默认）范围装配；新增或 Schema 变化的 Tool 确认前不可调用；旧摘要 Attempt、停用或删除连接在后续调用复核时拒绝，实际 Tool 调用可追溯且凭据不进入 Manifest/Patch。
- 容量测试覆盖 1/3/5 并发与 50 Run 排队，记录受理/完成延迟、CPU、RSS、磁盘和失败率。模拟 Runtime 跑分不能推导真实模型吞吐或生产并发。
- 运行耗时基线：`pnpm report:run-timings`（读取 `DSH_WORK_DATABASE_URL`，只读）按阶段输出样本量、缺失数、p50/p95/最大值与失败率；`--since/--until` 限定时间，`--purpose` 选择员工运行、自动任务、摘要运行或全部，`--json` 输出原始汇总。

测试时间用带时区 ISO 8601，业务 ID 尽量稳定；不提交真实员工、业务正文、凭据或敏感二进制附件。真实模型探针及升级验证命令统一见 Runtime 指南。

跨空间输入、执行前复核和试运行证据隔离的规则见[功能规则](feature-rules.md#1-跨功能约束)，回归入口为 `pnpm test:review:unit` 与 `pnpm test:review:integration`（后者需要 `DSH_WORK_TEST_DATABASE_URL`）。

## 发布与业务验收条件

自动化通过只证明相应工程范围。每个目标环境仍需提供以下验收证据，不沿用历史报告的“已完成”状态：

| 领域 | 必须验证 |
| --- | --- |
| 企业 SSO | 真实员工首登、Bootstrap 幂等、目录停用、至少两名管理员、本地收权、Token 刷新、Platform API 与 OIDC 分别停机后的恢复 |
| 企业连接器与知识 | 真实只读接口、Owner、Schema、权限过滤、版本/生效时间、来源引用；合成知识不能替代 |
| 文件与数据出口 | 企业级恶意文件扫描、正式存储、数据分级、模型出口、保留和清理规则 |
| 生产容量 | 目标硬件上的真实模型、20 MB 文件并发、长对话、真实 Connector 延迟；重新确定并发和超时 |
| 网络与运行故障 | 真实断网、代理/Provider 故障、Worker 与服务重启、宿主机恢复；故障注入单测不替代现场演练 |
| 运维 | TLS、密钥、磁盘/证书/身份依赖告警、异机备份与恢复、应用回滚兼容性、RTO/RPO 和维护窗口 |

主分支要求 CI 的四个 Job（Static checks and build、Unit tests、PostgreSQL integration tests、Browser tests）全部成功，人工发布按同一组检查放行。普通 push 只运行 CI；人工发布、Release watcher、首次安装及回滚统一按 [部署手册](../release/mac-mini-deployment-runbook.md) 执行。已发布 Release、主分支 CI 成功和远端部署完成是三个独立事实。

### 个人工作闭环增量

规则见[功能规则第 2 节](feature-rules.md#2-个人工作区与内容)。运行 `pnpm test:review:batch03:integration`；浏览器分别运行 `pnpm test:e2e` 与带专用测试库的 `pnpm test:e2e:personal`。项目空间 P1 旅程运行 `pnpm test:e2e:project-space`（专用可丢弃 PostgreSQL + 合成 Runtime）。浏览器受策略阻塞时必须记录失败，不得换成 Mock 页面后声称通过。
