# 开发与测试

## 本地启动

使用兼容项目的 Node.js（22.19+ 或 24+）和根目录 `package.json` 中 `packageManager` 指定的 pnpm：

```bash
pnpm install --frozen-lockfile
```

### 页面与业务原型

不需要 AI Hub、PostgreSQL 或 DSH。以下变量会覆盖已有 `.env` 中的对应值，避免误连完整运行环境：

```bash
NODE_ENV=development DSH_WORK_AUTH_MODE=prototype DSH_WORK_DATABASE_URL='' DSH_WORK_SERVER_HOST=127.0.0.1 pnpm dev:all
```

若默认端口已有 OIDC/开发数据库服务，浏览器冒烟应改用独立端口并显式关闭数据库，避免 Playwright 复用真实环境：

```bash
DSH_WORK_AUTH_MODE=prototype DSH_WORK_DATABASE_URL='' DSH_WORK_WORKBENCH_PORT=4274 DSH_WORK_ADMIN_PORT=4280 DSH_WORK_SERVER_PORT=4290 VITE_ADMIN_URL=http://localhost:4280 VITE_WORKBENCH_URL=http://localhost:4274 pnpm test:e2e
```

- 员工端：`http://localhost:4174/workbench`
- 管理端：`http://localhost:4180/overview`
- 后端：`http://localhost:4190/health`

原型模式使用进程内数据和受控测试身份，不提供完整持久化及真实 Run。重启可能丢失编辑结果，不能用于生产。各服务也可分别用 `pnpm dev:server`、`pnpm dev:workbench`、`pnpm dev:admin` 启动。

### 持久化与真实执行

1. 准备独立的开发 PostgreSQL 数据库。
2. 若没有 `.env`，从 [配置模板](../../.env.example) 创建；已有配置只修改所需字段。设置实际 `DSH_WORK_DATABASE_URL`。
3. 按 [Runtime 指南](../release/dsh-runtime-delivery.md) 配置独立 DSH checkout、精确版本与模型凭据；模板里的开发电脑路径需替换。
4. 业务开发可继续使用 `DSH_WORK_AUTH_MODE=prototype`；需要真实员工与权限管理时按 [身份指南](../release/ai-hub-sso-integration.md) 切换 `oidc`。身份管理路由只在 OIDC 与数据库都启用时注册。
5. 执行 `pnpm dev:all`。服务启动会自动运行 SQL 迁移并预检 DSH/Python；执行能力故障隔离见 [内部契约](internal-ports.md#执行能力故障隔离c9)；也可单独执行 `pnpm --filter @dsh-work/server db:migrate`。

本地完整模式与生产部署使用两套环境文件，且允许 DSH Runtime 目标不同：

- 本地开发使用仓库根目录 `.env`，默认对应 [`.env.example`](../../.env.example) 中的开发兼容 Runtime，可显式设置 `DSH_RUNTIME_COMPATIBILITY=legacy-0.1.1-rc.2`。
- 生产部署使用 `runtime.env`，从 [`deploy/runtime.env.example`](../../deploy/runtime.env.example) 复制，必须匹配生产主 Lock 的正式 Runtime，且 `DSH_RUNTIME_COMPATIBILITY` 必须保持未设置。

不要把生产 `runtime.env` 直接复制到本地，也不要把本地 `.env` 当作生产模板。两者的 DSH 路径、版本锁、认证入口和端口约束都不同。

只做业务功能升级无需启动或修改 AI Hub。SSO、目录、Bootstrap、凭据及身份映射修改必须另外联调；原型身份不能证明生产权限正确。生产禁止回退到 Prototype。

## 自动化验证

统一质量入口是 `pnpm ci:check`，具体脚本以 [package.json](../../package.json)、[服务端脚本](../../server/package.json) 和 [CI 工作流](../../.github/workflows/ci.yml) 为准。

| 改动范围 | 主要验证命令 |
| --- | --- |
| 完整本地质量门禁 | `pnpm ci:check` |
| 文档、契约与架构 | `pnpm verify`、`pnpm check:architecture` |
| 类型、UI 与代码规范 | `pnpm typecheck`、`pnpm lint` |
| 前端组件、Store 和 API 体验 | `pnpm test:m5:frontend`、`pnpm test:m5:api` |
| Runtime 与模型治理 | `pnpm test:m1`、`pnpm test:m2` |
| 身份 | `pnpm test:sso`、`pnpm test:sso:integration` |
| 权限与安全 | `pnpm test:m5:security`、`pnpm test:m5:security:integration` |
| 故障与恢复 | `pnpm test:m5:faults`、`pnpm test:m5:faults:integration` |
| 容量 | `pnpm test:m5:capacity:integration` |
| 浏览器冒烟 | `pnpm exec playwright install chromium`、`pnpm test:e2e` |

`pnpm verify` 统一运行四组静态检查，也可用 `pnpm verify contracts runtime` 选择范围：

- `project`：必要文件、文档链接、测试命令及 CI 接线。
- `contracts`：API 路径、错误字段、Runtime Schema 和合成测试数据结构。
- `runtime`：版本锁、环境模板、生产兼容限制与探针入口。
- `security`：身份与授权边界、子进程凭据隔离及安全迁移约束。

历史 `verify:m*` 命令已替换为这个入口；函数名、页面文案等重复字符串校验由对应行为测试覆盖。原有 `test:m*` 测试命令继续保留并接入 CI。静态检查不代表行为测试成功；`pnpm test:scripts` 验证检查器的拒绝场景和探针流程，不连接 AI Hub、数据库或真实模型。

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

PostgreSQL 集成测试必须显式指定专用可丢弃测试库，禁止使用开发业务库或生产库：

```bash
DSH_WORK_TEST_DATABASE_URL='postgres://<test-user>:<test-password>@127.0.0.1:5432/dsh_work_test' pnpm test:sso:integration
```

其他 `test:*:integration` 使用同一测试变量，按修改模块选择。`pnpm ci:check` 不包含 PostgreSQL 集成测试和浏览器 E2E；GitHub Actions 另启动 PostgreSQL Service、运行各集成套件，再执行 E2E。

Playwright 会启动服务，并在非 CI 模式复用已有服务。若只验原型页面，先停掉不匹配的开发实例，并用上述原型环境变量运行 `pnpm test:e2e`。不要将复用的真实环境误认为隔离测试。HTTP/SSO 测试需要临时监听本机端口；`listen EPERM` 表示执行环境限制，应在允许本地监听的环境重跑。

## 必测场景与数据

[mvp-fixtures.json](fixtures/mvp-fixtures.json) 保存合成角色、空间、业务记录、知识和文件元数据，不能视为真实企业接口。服务端种子与前端原型 ID 以各自代码为准，不假定 fixture 已自动导入所有环境。

- 个人空间与团队空间的会话、文件和成果访问；非成员、跨用户及跨数据范围访问拒绝。
- Agent、Skill 测试后发布、版本锁定与回滚；精确 Tool Allowlist 不被 Skill 间接扩大。
- 文件上传、解析、Run 关联、来源与成果版本、下载鉴权；路径穿越、伪造签名和超限文件拒绝。
- 取消、超时、Worker 崩溃、模型/Tool/网络故障；幂等请求不重复执行，只有失败 Run 可重试并生成新 Attempt。
- 服务重启后活动 Attempt 失败收敛、排队任务恢复；SSE 使用 `Last-Event-ID` 重放，旧 Attempt 事件不能覆盖当前重试状态。
- 审计脱敏、凭据隔离、DSH 子进程环境白名单、权限变化即时生效。
- 容量测试覆盖 1/3/5 并发与 50 Run 排队，记录受理/完成延迟、CPU、RSS、磁盘和失败率。模拟 Runtime 跑分不能推导真实模型吞吐或生产并发。

测试时间用带时区 ISO 8601，业务 ID 尽量稳定；不提交真实员工、业务正文、凭据或敏感二进制附件。真实模型探针及升级验证命令统一见 Runtime 指南。

本轮安全修复的范围、兼容约定和单独回归入口见 [批次 0/1](review-batch01.md)。

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

主分支要求 `M6 quality gate`。普通 push 只运行 CI；人工发布、Release watcher、首次安装及回滚统一按 [部署手册](../release/mac-mini-deployment-runbook.md) 执行。已发布 Release、主分支 CI 成功和远端部署完成是三个独立事实。
