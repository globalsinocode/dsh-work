# dsh-work

> 面向企业员工的 AI Agent 工作台，基于 DeepSeek Harness（DSH），统一承载企业知识查询、只读业务工具、文件分析、成果交付与运行治理。

## 项目背景

企业知识、业务数据和文件通常分散在知识库、ERP、MES 及员工本地工作环境中。员工需要在多个系统之间查询、整理和重复加工数据，通用 AI 工具又不能在缺少身份、权限、审计和数据边界的情况下直接访问企业资源。

dsh-work 为这些能力提供统一的企业级入口：员工以自然语言发起任务，平台在服务端识别身份和权限，调用经过治理的知识、只读业务工具与文件处理能力，并交付可追溯的回答、分析结果和文件成果。

## 产品定位

dsh-work 是面向企业员工的统一 AI Agent 工作台，同时提供独立的管理后台。员工工作台负责对话、工作空间、文件和成果体验；管理后台负责 Agent、Skill、Tool、Runtime、权限、用量与审计治理。

平台负责身份、业务对象、权限、运行编排和审计事实。DSH 作为可替换的执行内核，只处理单次 Attempt 内的模型与 Tool 调用编排，不承担产品数据库、企业身份或长期业务凭据管理。

## 核心功能

- 统一对话入口：通过自然语言发起企业知识查询、业务查询和文件分析任务；
- 个人与团队工作空间：组织对话、文件、成果和协作上下文，并执行成员权限控制；
- 文件与成果：上传和分析常见办公文件，保存来源、版本和下载权限；
- Agent 与能力治理：管理 Agent、Skill、预置 Tool/Connector 和模型路由的版本与可用范围；
- 运行与调度：以 Session、Run、Attempt 和 Runtime Manifest 组织可取消、可重试、可追踪的执行链路；
- 企业身份与权限：使用 AI Hub 统一登录并同步员工资料，在应用内配置角色、功能权限和业务数据范围；
- 审计与运营：记录运行、模型、Tool、成果和管理操作，提供用量、健康与异常追踪。

## 产品边界

- 企业系统接入以只读、类型化 Tool 为默认方式，不允许 DSH 直接连接 ERP/MES 数据库；
- 员工不能直接访问 DSH、任意 Shell、任意 SQL 或长期业务凭据；
- Tool、Connector 和模型能力由平台统一治理，不由员工绕过平台自行安装；
- 产品 Session、Run、文件、成果和权限事实由 dsh-work 持有，不依赖 DSH 内部对象；
- 逻辑模块用于划分职责和依赖，不默认拆分为业务微服务。

## 设计原则

- 一个入口：员工通过统一工作台使用企业 AI 能力；
- 服务端可信：身份、权限和操作人均由服务端建立，不能由浏览器声明；
- 版本不可变：已发布能力和运行快照可追溯，重试不会覆盖历史 Attempt；
- 最小权限：企业能力默认只读，Tool 使用 Allowlist，敏感数据按范围过滤；
- Runtime 可替换：业务对象只依赖稳定的 Runtime Adapter 和标准 Run Event；
- 默认可审计：运行和治理操作保留结构化、脱敏的审计事实。

## 架构概览

```mermaid
flowchart TB
  User[企业员工 / 管理员] --> WB[员工工作台]
  User --> Admin[管理后台]
  WB --> API[Workbench API]
  Admin --> AdminAPI[Admin API]
  AIHub[AI Hub<br/>OIDC 身份与员工目录] --> API
  AIHub --> AdminAPI

  subgraph App[dsh-work Node.js 模块化单体]
    API --> Authz[本地角色 / 权限 / 数据范围]
    AdminAPI --> Authz
    Authz --> Domain[Workspace / Session / Run / 治理模块]
    Domain --> Adapter[Runtime Adapter]
    Domain --> Gateways[Model / Connector / Artifact 模块]
  end

  Domain --> PG[(PostgreSQL)]
  Adapter --> Worker[独立 DSH Worker]
  Worker --> Gateways
  Gateways --> Enterprise[模型、企业系统与文件存储]
```

两个 Vue 应用独立构建并使用两个 API Audience；服务端长期保持模块化单体。每个 Attempt 默认使用独立 DSH Worker 子进程，模块边界不等同于微服务边界。完整设计见 [产品与系统架构总览](docs/development/overview.md)。

## 仓库结构

```text
apps/
├── workbench-web          # 员工工作台（Vue 3）
└── admin-web              # 管理后台（Vue 3 + Element Plus）
packages/                  # Design Token 与共享无状态组件
server/                    # Node.js / TypeScript 模块化单体
├── migrations/            # PostgreSQL 显式迁移
└── src/modules/           # 领域、应用与适配器模块
docs/                      # index、development、release、design、history
scripts/                   # 功能分组校验、Runtime 探针、CI 与发布部署
e2e/                       # Playwright 浏览器冒烟
```

## 本地启动

使用 Node.js 22.19+ 或 24+，以及根目录 `package.json` 指定版本的 pnpm，先在项目根目录安装依赖：

```bash
pnpm install --frozen-lockfile
```

### 无需 AI Hub 的本地原型模式

只开发页面或体验业务原型时，无需启动 AI Hub、PostgreSQL 或 DSH，执行：

```bash
NODE_ENV=development DSH_WORK_AUTH_MODE=prototype DSH_WORK_DATABASE_URL='' DSH_WORK_SERVER_HOST=127.0.0.1 pnpm dev:all
```

该命令同时启动后端、员工端和管理端，并覆盖已有 `.env` 中的对应配置。原型模式使用内存数据和受控测试身份，重启可能丢失编辑结果，不提供持久化及真实 Agent 执行，不能用于生产。

### 使用已有环境配置

需要持久化、真实 Agent 执行或 AI Hub 登录时，按 [开发与测试](docs/development/development.md) 配置环境后执行 `pnpm dev:all`。也可在不同终端分别启动后端、员工端和管理端：

```bash
pnpm dev:server
pnpm dev:workbench
pnpm dev:admin
```

默认访问地址：

- 后端：`http://localhost:4190/health`
- 员工端：`http://localhost:4174/workbench`
- 管理端：`http://localhost:4180/overview`

## 文档

- [文档导航与维护规则](docs/index/README.md)
- [产品与系统架构总览](docs/development/overview.md)
- [Agent 设计规范](docs/development/agent-design-standard.md)
- [开发与测试](docs/development/development.md)
- [Mac mini 部署手册](docs/release/mac-mini-deployment-runbook.md)
- [数据模型](docs/design/data-model.md)
- [内部端口契约](docs/development/internal-ports.md)

开发启动和验证命令见开发与测试；接口、配置及部署操作统一在 `docs/` 维护。
