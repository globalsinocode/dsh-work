# dsh-work 产品与系统架构总览

**文档状态：** 当前架构基线<br>
**更新日期：** 2026-09-08<br>
**技术形态：** 两个独立 Vue 应用 + 一个 Node.js 模块化单体 + PostgreSQL + 独立 DSH Worker 进程<br>
**身份来源：** AI Hub OIDC（生产/联调）或受控原型身份（本地演示）

本文统一描述 dsh-work 的产品范围、系统边界和长期架构。接口字段、物理表和验证命令不在本文重复维护，分别以可执行契约、SQL 迁移和开发测试指南为准。

Agent 定义、能力依赖、状态、授权、发布和评测的通用要求统一见 [Agent 设计规范](agent-design-standard.md)；代码支持程度及未实现项见[差异清单](agent-design-gap-analysis.md)。本文保留系统职责与执行链的架构边界。

## 1. 产品定位与范围

dsh-work 是部署在企业内网的统一 AI Agent 工作台。员工通过自然语言使用经过授权的企业知识、业务数据和文件处理能力，获得带来源的回答、分析结论和可下载成果；平台管理员通过独立管理后台维护 Agent、Skill、预置 Tool/Connector、Runtime、权限、用量和审计。

MVP 聚焦三类业务场景：

1. 企业知识查询，回答带来源、版本和权限过滤；
2. ERP、MES 等企业系统的只读业务查询；
3. PDF、DOCX、XLSX、CSV、TXT、Markdown 文件的基础分析与成果交付。

MVP 明确不包含：

- 员工自建 Tool、Connector、插件或 MCP；
- 任意 Shell、任意 SQL 或 DSH Web UI 直达；
- 写入 ERP/MES 等高风险业务操作；
- PPT 生成、开放式 Agent 市场和跨企业多租户 SaaS；
- 为了形式上的“平台化”拆分业务微服务。

## 2. 责任边界

| 系统 | 负责 | 不负责 |
|---|---|---|
| dsh-work | 员工体验、Workspace、产品 Session、Run/Attempt、文件、成果、对象权限、运行编排、审计和运营 | 模型内部推理、企业身份主数据、企业系统业务规则 |
| DSH | 单次 Attempt 内的 Agent Loop、Skill 执行、模型/Tool 调用编排、取消和运行事件 | 产品数据库、长期身份、对象权限、业务凭据和企业系统直连 |
| AI Hub | OIDC 身份、环境初始管理员一次性 Bootstrap、基础员工资料与增量员工目录 | dsh-work 的角色、功能权限、数据范围、Session、业务对象和运行状态 |
| 企业系统/模型/存储 | 权威业务数据、模型能力、文件与备份基础设施 | dsh-work 的交互、编排和审计语义 |

关键边界：

- DSH Runtime Session 不等于 dsh-work 产品 Session；
- PostgreSQL 是产品元数据、权限、版本关系和运行状态的事实来源，浏览器 Store、DSH Session Log 和缓存不能替代它；
- Skill 的 `SKILL.md`、参考文件和脚本保存在 `DSH_WORK_DATA_ROOT/skills` 的内容寻址文件夹中；PostgreSQL 只保存相对引用和校验索引，数据库与该数据目录必须成组备份和恢复；
- 企业身份由服务端建立，浏览器传入的用户、角色或操作人字段不能作为授权事实；
- DSH 只能通过受控适配器和平台能力调用模型、Tool 与成果存储；
- AI Hub 不可用时不得绕过登录、Token 刷新或员工目录同步；已有 Session 只在 Access Token 尚未进入刷新窗口时独立使用本地授权，不能把 Session 有效期等同于离线可用时长。

## 3. 架构原则

### 3.1 逻辑边界稳定，物理部署简单

员工工作台、管理后台、身份、Workspace、治理、运行、Runtime Adapter、Model/Connector Gateway、Artifact 和审计是清晰的逻辑边界，但不等于独立服务。MVP 和生产默认都保持一个代码库、一个 Node.js 业务部署单元和一套共享业务事实。

只有以下边界采用独立运行体：

- 员工工作台与管理后台分别构建静态资源；
- 每个 Attempt 默认启动独立 DSH ACP Worker 子进程；
- PostgreSQL、AI Hub、模型 Provider、企业系统和文件存储是外部依赖。

### 3.2 版本不可变、运行可追溯

已发布 Agent Version、Skill Version、Tool Version 和 Attempt Manifest 不可覆盖。每个 Run/Attempt 固定实际使用的版本、模型路由、权限范围、输入文件和来源快照，重试创建新 Attempt，不修改历史 Attempt。

### 3.3 只读与最小权限优先

企业 Connector 首期只读；Tool 必须进入 Allowlist 并经过角色、数据范围、工作空间和版本授权。敏感字段在进入模型或日志前过滤，密钥正文不进入业务数据库、Manifest、前端响应或审计详情。

### 3.4 产品事实与执行轨迹分离

dsh-work 保存可面向用户和治理的业务状态；DSH 保存运行时技术轨迹。ACP 负责程序化控制和已提交回答，允许进入平台的 Tool、Token、时延和状态字段必须经过显式脱敏投影。

### 3.5 Agent 执行引擎统一

所有 Agent 场景统一使用 DeepSeek Harness（DSH），包括员工对话、管理端对话安装 Skill 和其他系统助手。调用路径统一为：前端 → 对应 Audience 的 API → 平台 Run/Attempt → Runtime Adapter → DSH。各场景可以有独立的业务状态、Agent 配置和工具授权，但必须复用同一条执行链路。

- **禁止第二套 Agent 执行逻辑。** 不得在前端、业务后端或独立服务中绕过 DSH，直接调用模型 API 实现 Agent 对话、工具调用循环、多步推理、模型上下文推进或循环内重试；不得为安装助手等场景另引入并行 Agent 执行框架。
- **DSH 持有单次 Attempt 内的执行循环。** 模型交互、工具调用编排与循环上下文由 DSH 负责；平台复用现有 Runtime Adapter 处理启动、取消、超时、事件转换和进程回收。
- **平台持有业务事实和工具实现。** 身份与权限、会话和安装记录、队列调度、Attempt 重试、断线恢复、幂等及审计由平台负责。下载、解包、校验、入库和版本发布是受控业务工具；其确定性流程与事务恢复不属于另一套 Agent Loop。管理端安装工具按管理身份授权，不扩大员工 Agent 的工具权限。
- **模型治理不承担 Agent 执行。** Model 模块及 Gateway 可承担路由、凭据引用、计量和 DSH 调用所需的协议传输，不能自行发起一条绕过 DSH 的业务 Agent 路线。
- **DSH 不可用时禁止绕过。** 需要 Agent 的对话和试运行明确报告不可用，不能自动降级到直接调用模型。已有安装记录和确定性平台管理操作可按自身权限继续工作；这不代表 Agent 仍可运行。
- **扩展现有链路。** 安装助手所需工具调用或资源能力不足时，应扩展现有 Run/Runtime 契约和 DSH 能力。Runtime 可替换表示通过既有端口统一迁移执行内核，不表示允许各业务场景自行选择或维护第二套引擎。Mock Runtime 仅供测试与原型使用，不是生产回退方案。

新增 Agent 功能评审必须追踪到实际 DSH 调用和工具结果回传路径，并检查 Run/Attempt、权限、取消、重试和审计接线。设计稿、安装入库或 Mock 测试通过不能替代真实 DSH 执行验证。本约束同时由仓库根目录 [AGENTS.md](../../AGENTS.md) 提供开发入口。

## 4. 逻辑架构

```mermaid
flowchart TB
  subgraph Client[体验层]
    WB[员工工作台<br/>Vue 3]
    Admin[管理后台<br/>Vue 3 + Element Plus]
  end

  subgraph Access[接入与身份]
    WAPI[Workbench API / SSE]
    AAPI[Admin API]
    Auth[AI Hub OIDC / 员工目录]
  end

  subgraph App[dsh-work 模块化单体]
    Workspace[Workspace / Session / File / Artifact]
    Authorization[本地身份映射 / 角色 / 权限 / 数据范围]
    Governance[Agent / Skill / Tool / Model 治理]
    Orchestration[Run / Attempt / Scheduler / Audit]
    Runtime[Runtime Adapter / Run Event]
    Gateway[Model / Connector / Artifact 边界]
  end

  subgraph Execution[执行面]
    DSH[每 Attempt 独立 DSH ACP Worker]
  end

  subgraph Dependencies[基础设施与企业依赖]
    PG[(PostgreSQL)]
    Models[批准的模型]
    Systems[企业知识 / ERP / MES]
    Storage[本地受控目录 / NAS / 对象存储]
  end

  WB --> WAPI
  Admin --> AAPI
  Auth --> WAPI
  Auth --> AAPI
  WAPI --> Authorization
  AAPI --> Authorization
  WAPI --> Workspace
  WAPI --> Orchestration
  AAPI --> Governance
  AAPI --> Orchestration
  Workspace --> PG
  Authorization --> PG
  Governance --> PG
  Orchestration --> PG
  Orchestration --> Runtime
  Runtime --> DSH
  DSH --> Gateway
  Gateway --> Models
  Gateway --> Systems
  Gateway --> Storage
```

### 4.1 体验层

- `apps/workbench-web`：新对话、历史对话、我的文件、团队空间和用户设置；默认个人 Workspace 隐藏在后台，旧链接与数据归属保留，见 [个人工作闭环](review-batch03.md)；
- `apps/admin-web`：运营、Agent、Skill/Tool、Runtime、Session、权限、模型用量、审计和健康；
- 两个应用拥有独立路由、Pinia、API 客户端、DTO 和构建产物；
- `packages/` 只共享 Design Token 和无业务状态组件，不共享认证状态或业务 Store。

### 4.2 接入与应用层

- `/api/workbench/v1` 与 `/api/admin/v1` 是两个独立 Audience；
- `/auth/workbench/*` 与 `/auth/admin/*` 分别完成登录、回调和退出；
- 服务端在 API 边界建立身份，随后由应用服务执行对象级和数据范围授权；
- Run 编排、Agent/Skill/Tool 治理、知识、文件、模型、运营和身份模块都位于同一 Node.js 模块化单体。

### 4.3 Runtime 与执行层

- Runtime Adapter 只依赖固定的 ACP JSON-RPC stdio 协议；
- Runtime Manifest 使用规范化 JSON 与 SHA-256 固定运行输入；
- 一个 Attempt 默认对应一个隔离目录和一个 DSH Worker 进程；
- Adapter 负责启动、取消、超时、回收、事件转换和错误分类；
- 调度容量、排空/停用、重启恢复和 SSE 游标由 dsh-work 持久化控制。

### 4.4 平台能力层

- Model 模块保存 Provider、模型和路由策略，只持久化凭据引用；
- Connector/Tool 模块保存版本、Schema、风险、角色、数据范围和健康状态；
- Artifact/Content 模块保存文件与成果元数据、不可覆盖版本、权限和存储键；
- 审计与运营投影不保存提示词、回答正文、文件内容或密钥正文。

## 5. MVP 物理部署

```mermaid
flowchart LR
  Browser[企业浏览器] --> Proxy[Reverse Proxy / HTTPS]
  Proxy --> StaticA[员工端静态资源]
  Proxy --> StaticB[管理端静态资源]
  Proxy --> Node[dsh-work Node.js 进程]
  Node --> PG[(PostgreSQL 17)]
  Node --> Files[受控文件目录或企业存储]
  Node --> Worker1[DSH Worker A]
  Node --> WorkerN[DSH Worker N]
  Node --> AIHub[AI Hub]
  Worker1 --> Approved[批准的模型与只读 Tool]
  WorkerN --> Approved
```

目标 MVP 以公司内网 Mac mini 为单节点部署基线：Reverse Proxy 终止 HTTPS，两个前端作为独立静态资源发布，Node.js 模块化单体连接 PostgreSQL，并按活动 Attempt 启动 DSH Worker。每个目标环境都需验证硬件、存储、备份、监控和网络；部署模板不能证明线上状态。

本地开发允许两种模式：

| 模式 | 数据 | 身份 | Runtime | 用途 |
|---|---|---|---|---|
| 原型模式 | 进程内数据 | 受控原型身份 | 不启动真实 Run | 页面预览、确定性 E2E |
| 完整链路 | PostgreSQL | AI Hub OIDC 或受控联调身份 | 固定版本 DSH ACP | 集成、UAT、预生产验证 |

原型模式只能用于开发和演示，不能作为真实企业数据试点的安全基线。

## 6. 核心运行流程

1. 用户通过对应 Portal 发起 AI Hub OIDC Authorization Code + PKCE 登录；
2. 服务端校验 `state`、`nonce`、Issuer、Audience、签名和 Scope，建立加密的服务端 Session；
3. 员工选择个人或团队 Workspace，并创建或继续产品 Session；需要时从员工端 Skill 广场选择一个已发布 Skill；个人空间未显式指定 Agent 时，服务端优先使用平台默认 Agent，并跳过无法满足所选 Skill 工具依赖的候选；
4. 服务端在创建 Session 前校验应用权限、Workspace 成员关系、Agent 可见性、有效数据范围及 Agent/Skill 工具闭包；`activate_skill`、`python_execute` 由 Attempt Manifest 内建授权，其余工具必须由 Agent 显式授权；
5. 创建 Run 和不可变 Attempt，固定 Agent/Skill/Tool/Model、文件、知识来源与权限快照；
6. PostgreSQL 调度在 Runtime 容量内原子认领 Attempt；
7. Runtime Adapter 写入 Manifest 和隔离输入，启动独立 DSH ACP Worker；
8. DSH 执行 Agent Loop，并通过 Allowlist 使用批准的模型与只读 Tool；
9. 标准 Run Event 先持久化，再通过 SSE 推送；断线后使用 `Last-Event-ID` 续传；
10. 回答、Token、Tool、错误、审计和明确发布的 Artifact 形成可追溯事实；
11. 取消、超时、崩溃或重启都收敛到确定性 Attempt 终态，重试创建新 Attempt。

## 7. 核心领域对象与不变量

| 对象 | 含义 | 关键不变量 |
|---|---|---|
| Workspace | 个人或团队工作上下文 | Session、文件、成果必须归属一个 Workspace；团队资源受成员关系约束 |
| Product Session | 用户可继续的业务对话 | 不等于 DSH Runtime Session；锁定 Agent Version，可选锁定一个已发布 Skill Version |
| Run | 一次用户任务 | 幂等创建；拥有一个或多个按序 Attempt |
| Attempt | 一次不可变执行尝试 | 固定 Manifest、模型路由、权限、文件与来源快照；终态不可回退 |
| Run Event | 面向产品的标准运行事件 | 先落库后发送；稳定 ID 与全 Run 顺序；不暴露隐藏推理 |
| Agent/Skill/Tool Version | 已发布治理版本 | 发布后不可修改或删除；运行引用精确版本 |
| File/Artifact Version | 输入与交付成果 | 存储键不使用用户文件名；版本不可覆盖；下载再次鉴权 |
| Audit/Operational Event | 安全与运营事实 | 结构化、可追踪、脱敏；不保存业务正文和凭据 |

详细逻辑关系见 [数据模型](../design/data-model.md)，物理约束见 `server/migrations/`。

## 8. 代码与模块映射

| 架构边界 | 代码位置 |
|---|---|
| 员工体验 | `apps/workbench-web`、`packages/workbench-components` |
| 管理体验 | `apps/admin-web`、`packages/admin-components` |
| 共享视觉基础 | `packages/design-tokens`、`packages/ui-core` |
| Workbench/Admin/Auth API | `server/src/http` |
| 身份与 AI Hub | `server/src/modules/identity` |
| Run 与状态机 | `server/src/modules/run` |
| Runtime Adapter | `server/src/modules/runtime` |
| Agent/Skill/Tool/Model 治理 | `server/src/modules/agent`、`skill`、`tool`、`model` |
| 权限与数据范围 | `server/src/modules/authorization` |
| 文件、成果、对话和工作空间 | `server/src/modules/workbench` |
| PostgreSQL 与迁移 | `server/src/infrastructure/postgres`、`server/migrations` |

依赖方向由 `scripts/check-architecture.mjs` 检查：应用可以依赖共享包，两个前端不能互相依赖；服务端模块通过明确端口协作，不允许前端引用服务端领域类型。

## 9. 身份、安全与数据边界

- 生产/联调身份使用 AI Hub OIDC，Token 加密保存在服务端 Session；Cookie 在 HTTPS 环境启用 Secure；
- Workbench 与 Admin 分别校验 Audience；每次 API 请求从 PostgreSQL 解析当前本地角色、权限、数据范围和授权版本；
- AI Hub 环境中明确指定的初始管理员只可一次性初始化首位本地平台管理员；应用负责人和平台登记人不因此获权，之后所有授权在 dsh-work 管理端维护；
- API 不信任浏览器提交的 `actor`、用户 ID、角色或数据范围；
- Workspace、Agent、Skill、Tool、Connector、文件和 Artifact 都在服务端执行对象级授权；
- DSH 子进程使用环境白名单，应用数据库变量和敏感覆盖项不传入；
- 模型与 Connector 凭据只保存引用，由受管凭据层在服务端或 DSH 边界解析；
- 文件执行扩展名、MIME、大小、签名、路径和工作空间校验，正式环境仍需企业级恶意文件扫描；
- Tool/Connector 默认只读、固定 Schema、超时、字段过滤并记录脱敏审计；
- L2 数据、模型出口、日志保留、备份和销毁参数必须在试点前完成企业评审。

## 10. 当前边界与独立开发

- Agent、Skill、文件、知识、运行、审计和本地授权属于 dsh-work，可独立开发和发布；默认非生产 `prototype` 模式无需启动 AI Hub。
- Skill 已有版本、配置校验、发布和 Agent 固定引用能力；管理端已将手工创建/编辑表单替换为独立「新增 Skill」页签，该页签仅提供 ZIP 上传，链接、明确自然语言和命令格式安装迁入独立「管理助手」页面。管理助手通过 `admin-assistant` DSH Run 处理普通问答和意图提案，管理员第一次确认后才调度 `admin-skill-install`、`admin-agent-manage` 或 `admin-platform-operations` 专用 Run。Agent 与 Runtime 专用助手只生成绑定摘要的精确操作计划，第二次确认且目标状态未变化时才复用既有领域服务写入。Skill 安装继续生成结构化包计划并以一个事务保存根 Skill、同源依赖和依赖图；严格试运行要求所有 Skill 留下真实激活证据，管理员随后发布。资源随版本存储，新的 Attempt 先获得渐进式目录，再通过 `activate_skill` 获取锁定正文和只读资源路径。实现边界见 [管理助手方案](../design/admin-assistant-plan.md)与[对话安装实现](../design/admin-skill-installation-implementation.md)，完整方案见 [Skill 安装方案](../design/skill-installation-plan.md)。
- 管理端已有 Agent 配置/ZIP 候选、封存试运行、逐项确认和发布流程；自动任务已有本人身份、固定 Agent Version、独立 Session 的实现及回归用例。代码和用例存在不代表目标环境真实 DSH、OIDC 或完整 E2E 验收通过，当前核对见[差异清单](agent-design-gap-analysis.md)。员工自助贡献、按对象负责人审核、新工具完整准入和受控经验积累仍属后续范围；当前 Agent/Tool 上传配置由管理员负责，不建设外部开发者生态。未来经验提炼仅生成候选，经确认后发布，不自动修改 Prompt、Skill、脚本、工具或权限，也不共享私人数据与凭据。
- 已有 Skill 的 Python 脚本执行采用 [受控执行方案](../design/skill-python-execution-plan.md)：DSH 调用平台 `python_execute`，每次调用使用摘要锁定、无网络、只读根文件系统和资源受限的临时容器；未配置合规镜像时安装计划标记不兼容，不存在宿主机 Python 或直接模型调用回退。
- Runtime 以单机执行为基线；多节点租约、失联回收和跨节点调度需要另行实现，不能只增加实例就认定已经支持。
- 生产依赖 AI Hub 的 OIDC、`/me`、员工目录和一次性 Bootstrap；专用 Scope、`actor_type`、`business_user` 及数据库提供方标记意味着替换身份平台需要适配和映射迁移。
- 业务角色在本地，但 AI Hub 账号停用或转为平台账号仍会影响访问资格；默认每 900 秒同步，失败会延迟状态传播。
- 管理端当前持续要求 Bootstrap Scope，即使首位管理员已经初始化；凭据轮换须覆盖后续登录和刷新验证。
- `/health` 的 SSO 字段表示配置模式，不是身份服务可用性检测；接口契约与真实双系统故障行为需独立验证。
- 企业只读 Connector、真实知识源、恶意文件扫描、数据出口、目标容量和备份恢复，均需针对部署环境提供证据。合成数据、历史测试与发布成功不能代替业务验收。

开发模式、自动化和上线前验证入口见 [开发与测试](development.md)；身份协议与生命周期见 [AI Hub 接入](../release/ai-hub-sso-integration.md)。

## 11. 生产演进原则

生产化按证据扩展，不预设微服务拆分：

1. 先完成 AI Hub 联调、企业 Connector/知识源、目标主机、存储、备份、监控和 UAT；
2. 容量不足时先测量瓶颈；增加 Node.js 实例或多主机 Worker 前实现并验证租约、抢占、事件归属和失联恢复；
3. 文件规模增长时将本地存储适配器替换为 NAS/对象存储，不改变业务对象；
4. 跨应用治理复用达到门槛后，通过稳定治理端口把 Agent、Skill、Tool、Model、发布和汇总治理迁入 AI Hub；
5. Workspace、产品 Session、Run/Attempt、审批实例、文件、成果和高频运行状态继续由 dsh-work 持有；
6. 只有独立扩缩容、故障域、团队所有权和数据边界同时成立时，才评审拆分部署单元。

## 12. 相关文档

- [文档导航](../index/README.md)
- [Agent 设计规范](agent-design-standard.md)
- [Agent 规范与当前实现差异清单](agent-design-gap-analysis.md)
- [开发与测试](development.md)
- [数据模型](../design/data-model.md)
- [内部端口与契约](internal-ports.md)
- [AI Hub 身份接入](../release/ai-hub-sso-integration.md)
- [DSH Runtime](../release/dsh-runtime-delivery.md)
- [Mac mini 部署手册](../release/mac-mini-deployment-runbook.md)
