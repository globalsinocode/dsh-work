# Agent 规范与当前实现差异清单

**初次核对：** 2026-09-19；**实施范围更新：** 2026-09-23<br>
**阶段状态：** 平台基础能力的代码建设阶段收口；本清单保留为规范差异与实施记录。PF-07 全量 P2 仍是独立的目标版本发布验收事项，不标记为完成，也不阻止无关新任务的开发。<br>
**代码基线：** 初次核对为 `3f4f4bf`；本文同时记录生命周期实现映射与通用参考 Agent。B-01～B-05 与 PF-01～PF-06 已达到代码级；PF-07 的矩阵、测试入口和验收记录模板已建立。[双账号隔离环境的本轮进度](pf07-oidc-isolated-progress-2026-09-23.md)已覆盖一个真实 OIDC 身份的 MCP 写入/回执，以及私人受控记忆的发布、检索与撤回；第二身份的实际 Run、其他能力和故障撤权矩阵仍待验收。[较早的本地真实链路核对](pf07-real-chain-check-2026-09-23.md)只覆盖单身份 DSH 与外部 MCP 只读调用。此前 P2 只有口头结论且早于当前平台能力，不能作为 PF-07 验收；全量 P2 门禁未通过。完成记录与剩余范围见第 4、5 节。<br>
**规范入口：** [Agent 设计规范](agent-design-standard.md)。<br>
**范围：** 核对契约与执行实现，并运行本轮相关单测和专用一次性 PostgreSQL 集成测试。不将历史报告或受控 Runtime 测试等同于浏览器、真实 DSH 或 OIDC 验收。

## 1. 结论与状态口径

已有统一 DSH 执行、严格 AgentSpec 包格式、真实工具绑定修订、精确依赖、当前授权、基础预算、轻量自动任务和可核验任务结果外层。B-05/I-08 已补自动任务 AC-20～24 的 P1 浏览器证据，并形成账号、团队成员、输入文件、固定能力和授权服务故障的阶段矩阵；文件/工具绑定领取边界、活动期文件撤权、成果提交前团队撤权、授权故障分类及结果端点直接证据均已进入 `12435b0`。平台通用权限/故障矩阵及 Agent 专属 `AgentEvaluationSuite v1` 发布门禁已达到代码级闭环；此前 P2 只有口头结论，无可复核的环境、版本、Run/Attempt、验收人和限制记录。当前 PF-07 P2 不能据此标为通过。真实高级模型能力、外部异步写操作、持续执行及其他按需扩展仍未启用。

| 状态 | 本文含义 |
| --- | --- |
| 已实现（代码级） | 已定位相应执行分支及相关测试；只限明确列出的范围，不代表 P2 验收 |
| 部分实现 | 存在基础，但尚未覆盖该条规范的全部要求 |
| 未实现（核对范围内） | 相关契约/入口缺少该能力，不能以规划或展示字段推定存在 |
| 不适用当前范围 | 可选能力尚未启用，不作为基础 Agent 的缺陷；启用前须完成门槛 |

### AI 员工目标增量（2026-09-23）

[规范第 3 节](agent-design-standard.md#3-ai-员工统一目标架构)已确认独立 AI 员工的目标架构。以下是该目标相对既有 PF-01～PF-07 的新增实施项；PF-07 真实验收仍单独开放。实施时每项同步契约、消费者、必要迁移及分层证据，不能因本表或规范文字标为已支持。

| 编号 | 状态与实施内容 | 验收边界 |
| --- | --- | --- |
| AE-01 定义与 Soul | **已实现（代码级）。** 包与配置入口统一到根目录 `SOUL.md`，`dsh-work.ai/v2` 严格 Schema 只接受该文件；配置编辑生成相同 AgentSpec，试运行/发布固定正文与摘要；无 Skill/Tool 的基础 Agent 可创建，其他授权字段仍独立管理 | 包解析 71/71、发布治理专用 PostgreSQL 集成 23/23、管理端组件 102/102、P0 原型浏览器 1/1 通过；覆盖旧路径、缺失文件和空依赖的草稿/检查/试运行。P1 浏览器与真实 DSH/OIDC 验收仍待留证 |
| AE-02 独立 Principal | **代码级已实现，P2 待验收。** `execution_principals` 持久化 human/agent/system；Task、Manifest、动作审批、MCP/外部操作和授权审计分别归因发起人、执行者与批准人。Agent 角色及数据授权独立存储，创建时不从可见角色继承；入口、领取、活动工具调用、恢复和提交按当前人类披露范围、Agent 授权、Workspace 与固定上限求交。管理端可停用和收权；既有已完成结果依当前人类/Workspace 读权限保留，不因事后停用 Agent 抹去审计证据 | 一次性 PostgreSQL、Runtime 和 P1 管理端浏览器验证身份区分、默认无授权、显式授权、停用与收权。真实 DSH/OIDC、多账号、外部 MCP 效果及故障注入仍须 P2 留证；不能以 P1 代替上线验收 |
| AE-03 Agent Data | **暂缓，留待后续开发。** 发布数据集 JSON Schema 与 ACL，建立记录/不可变版本及来源引用；经受控工具查询、提案、更新和状态转换，`task-result` 增加可核验记录版本引用 | Schema、范围、并发期望版本、幂等、保留期及结果授权均可复现；外部权威数据与 `unknown` 回执不被误标完成 |
| AE-04 Agent-owned Memory | **代码级已实现，P2 待验收。** PF-05 已审核记忆按稳定 Agent 身份供同一 Agent 的后续定义版本检索，匹配的旧版逻辑键在同名修订时归一；固定引用在执行前复核当前身份、来源、目标 ACL 与撤回状态。Agent Version 显式引用 `propose_memory@1.0.0` 后，DSH 只能暂存 7 天提案；员工从本人成功 Attempt 选择并核对内容，自行确定范围和期限，管理员审核后才能检索。发布试运行仅返回 `trial_only`、不持久化；每次 Attempt 只把本次获准记忆投影为只读 `memory.md` | 一次性 PostgreSQL、Runtime、前端组件、P0 原型浏览器、契约与静态检查覆盖提案幂等、来源、同意、审核、当前 ACL、私人/团队隔离、撤回、保留期、版本及恢复复核；真实 DSH/OIDC 的提案→同意→审核→引用及收权链路仍需 P2 留证，不能用合成测试代替 |
| AE-05 主动任务 | **待实施。** 复用现有 Task/预算/调度/DSH，增加 Agent Principal 拥有的版本化 routine；心跳仅为可选巡检预设 | 时间/事件去重、授权上限、并发、停用、跳过原因、结果接收及审计可核验；不改变现有员工个人自动任务语义 |
| AE-06 管理与发布验收 | **待实施。** 统一展示身份/Soul/能力/数据/记忆/主动任务/发布及运行审计；扩展版本固定、评测和 P1/P2 验收 | 新旧入口均遵守单一 Run/Attempt → DSH 链路，合成环境与真实 DSH/OIDC 证据分开；PF-07 未完成项仍独立追踪 |

AE-02 保留两条语义边界：`requested_by` 继续指向人类请求者，不能冒充 Agent；`approved_by_principal_id` 是未来任务级批准槽位，PF-04 动作批准归各自审批记录。已完成的历史结果是不可变证据，读取仍复核当前人类账号与 Workspace 权限；Agent 事后停用阻断新动作，不擦除有权用户对旧结果的访问。待补的是当前目标环境的真实 DSH/OIDC、多账号和外部工具 P2 证据。

**实施顺序调整（2026-09-23）：** AE-03 不作为 AE-04 的前置条件，暂不建立通用数据集、记录或 `data.*` Tool。AE-04 仅处理带来源、同意、审核与当前 ACL 的非权威偏好/经验；业务状态、结构化台账和外部主数据不得写入记忆。AE-03 后续独立实施，AE-06 涉及数据集的管理与验收须等待 AE-03 交付。

## 2. 十二条逐项核对

| 规范 | 状态与代码证据 | 测试证据及不足 | 后续动作 |
| --- | --- | --- | --- |
| AS-01 对象分离 | **已实现（B-03 后）**。[Agent 服务](../../server/src/modules/agent/postgres-agent-service.ts)的草稿/发布与 `getRuntimeSnapshot`、[Run 类型](../../server/src/modules/run/run-types.ts)已分离目录、版本和 Attempt；发布计划/封存/Attempt 现引用真实 `tool_binding_revisions` 修订（B-03/I-04），不再使用固定占位 | [发布集成用例](../../server/src/infrastructure/postgres/agent-release-governance.integration.test.ts)覆盖候选修订、封存、绑定 pin 固定、漂移拒绝与发布；[绑定集成用例](../../server/src/infrastructure/postgres/tool-binding.integration.test.ts)覆盖修订物化/轮换/撤销 | 保留 `agentVersionId`；跨环境独立发布验证留待 P2 |
| AS-02 精简定义 | **基础已实现，高级能力待启用**。[包解析器](../../server/src/modules/agent/agent-package.ts)仅接受分层清单；配置与 ZIP 共用持久化 AgentSpec。当前输入/输出为 text，上下文为 recent；未知字段、旧别名与冲突直接拒绝。模型要求已进入路由和 Runtime 准入、Attempt 固定及恢复复核 | 解析与发布用例覆盖严格格式、依赖、定义保存/分叉；编排集成覆盖三入口的模型/Runtime 不匹配。受控 Runtime 正例验证快照，不证明真实高级能力 | 真实 DSH 目前拒绝 long-context/structured-output；启用前接通实际执行约束并留证。任务结果语义由 B-04 补齐 |
| AS-03 统一执行 | **已实现（现有生产接线）**。[main](../../server/src/main.ts)组装 Runtime；[编排服务](../../server/src/modules/run/run-orchestration-service.ts)的员工、管理、发布试运行均创建 Attempt；[Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)启动 ACP Worker | [执行能力测试](../../server/src/modules/runtime/execution-capabilities.test.ts)、[Adapter 测试](../../server/src/modules/runtime/runtime-adapter.test.ts)覆盖不可用、取消和故障；本次未运行真实 DSH | 维持单链路；每种新增入口均追踪实际接线，发布前验证目标 Runtime |
| AS-04 状态与上下文 | **PF-05 与 AE-04 代码级已实现受控记忆**。[Manifest 编译器](../../server/src/modules/runtime/manifest-compiler.ts)限制历史、文件、知识和固定记忆引用；[受控记忆服务](../../server/src/modules/memory/postgres-controlled-memory-service.ts)以 Agent 稳定身份、来源授权、提案、员工同意、候选审核、不可变版本、当前 ACL 和撤回传播管理跨任务记忆；Adapter 将本次摘录投影为只读 `memory.md` 并标成非权威参考 | PostgreSQL、Runtime/Schema、员工端与管理端测试覆盖提案、提交、审核、权限交集、跨版本引用及撤回；真实 DSH Prompt、OIDC 身份变化与等待中撤回留 P2 | 具体 Agent 仅在模板触发条件成立时显式声明 `propose_memory@1.0.0`；业务主数据、文档原文、会话历史和检查点不写入记忆 |
| AS-05 Skill/Tool/MCP | **PF-03 代码级已实现；真实服务 P2 待 PF-07**。[Connector 服务](../../server/src/modules/tool/postgres-tool-connector-service.ts)复用现有 Connector 模型，按 MCP Server 整体发现、能力快照自动生效、启停及全部 Agent 默认可用；管理端 `MCP 连接器` 只返回外部 MCP，稳定 DSH 内置连接的状态与检查进入 `安全与运维 → Runtimes`；[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)生成每 Attempt MCP Patch；[DSH 策略](../../server/config/dsh/dsh-work-tool-policy.js)按 Server 命名空间放行；Manifest 固定能力摘要但不含凭据 | [MCP 治理集成用例](../../server/src/infrastructure/postgres/mcp-connector-governance.integration.test.ts)覆盖登记自动生效→默认可用→能力变化自动同步→旧 Attempt 摘要阻断→调用审计→停用/删除阻断；Runtime/Schema/策略单测覆盖秘密不落 Patch、仅 Streamable HTTP 和命名空间隔离。尚无目标企业 MCP、真实凭据及真实 DSH 调用 P2 | 不生成 Agent 或 Tool 级 Grant，不生成 Tool Version/Binding，不耦合 Agent 发布；Resources/Prompts/stdio 保持未支持，真实链路纳入 PF-07 |
| AS-06 工具效果契约 | **基础已实现；外部写操作协议待具体能力接入**。Tool Version 持久化输出验证、重试、并发和完成语义；Runtime 目录携带同一契约。平台桥严格校验输入/输出、大小、当前授权、超时与同名串行调用，并区分冲突、不可用、取消及写入结果未知。DSH 原生工具输出明确标为不可验证 | 平台桥单测覆盖严格 Schema、输入/输出错误、收权、调用上限、串行冲突、读超时与写结果未知；DSH 政策测试覆盖目录和错误传播；工具治理集成验证版本契约持久化。尚未用真实外部异步写操作验证业务操作键与状态查询 | I-06 消费动作结果；新增外部写动作时实现业务幂等键、`accepted` 回执/查询和跨 Attempt 核对，不能仅靠 Run 幂等 |
| AS-07 当前权限 | **PF-04 代码级已实现；真实身份与动作 P2 待 PF-07**。main 的 `authorizeExecution` → 编排 `assertCurrentRunAuthorization` → [当前授权函数](../../server/src/modules/run/current-execution-authorization.ts)；平台桥前后复核。DSH 权限请求可进入[持久化等待服务](../../server/src/modules/run/postgres-persistent-wait-service.ts)，审批固定动作、参数摘要、资源、执行身份、数据版本和有效期；恢复前重新鉴权，参数变化重新申请 | [当前授权](../../server/src/modules/run/current-execution-authorization.test.ts)、[用途分流](../../server/src/modules/run/run-orchestration-authorization.test.ts)、[PF-04 集成用例](../../server/src/infrastructure/postgres/pf04-persistent-wait.integration.test.ts)覆盖动作一次性消费、重复决定、撤销与未知副作用；真实多账号收权及目标企业动作仍需 P2 | 保持个人/团队共同安全门槛；只有携带持久化审批与检查点标识且 Run 已进入 `waiting` 的事件才具备跨进程审批语义 |
| AS-08 持久化恢复 | **PF-04 代码级已实现；恢复采用新 Attempt**。Run 增加可恢复 `waiting`，来源 Attempt 的 `waiting` 为不可回退终态；[持久化等待服务](../../server/src/modules/run/postgres-persistent-wait-service.ts)保存不可变检查点、精确动作参数、此前工具结果、Unicode 输出工作文件、未提交部分回答与动作审批，等待时释放 Worker；审批仅在与 Run/Attempt 原子进入等待后可见，批准后经当前授权、有效期、检查点完整性和未知副作用检查创建新 Attempt；无需审批不捕获检查点，准备阶段终止会清理遗留审批，旧审批过期不得影响当前重试 Attempt；拒绝、过期、取消与撤权写终态事件并确定性收敛 | [PF-04 集成用例](../../server/src/infrastructure/postgres/pf04-persistent-wait.integration.test.ts)覆盖激活前拒绝门禁、重启保留、批准后过期、恰好一次恢复、并发相反决定冲突、遗留审批清理、旧 Attempt 隔离和终止路径；[Adapter 测试](../../server/src/modules/runtime/runtime-adapter.test.ts)覆盖仅调用 ID 的 DSH 请求、无需审批的大输出、等待事件、Worker 释放、上下文与 Unicode 工作文件恢复。真实 DSH/OIDC 故障恢复仍需 P2 | DSH 当前没有安全恢复原 ACP Session 的接口，维持检查点重建新 Attempt；新增长流程须显式启用并补真实目标环境验收 |
| AS-09 预算与委派 | **PF-02 累计预算与 PF-06 受控委派均已代码级实现**。Agent Version 固定允许的目标版本及深度、并行、超时；`delegate_agent` 经平台桥创建无 Session 子 Task/Run，沿用当前用户和工作空间，权限取当前授权与父 Attempt 上限交集，预算指向根 Task 范围。父子关系持久化，取消、终态和启动恢复均收敛；子结果使用 `task-result/v1`，仅文本成功标记 `unverified` | PostgreSQL 用例覆盖精确版本策略、幂等、深度、并行、Runtime 容量、根预算、父任务失效、取消与重启对账；Runtime/策略/Schema 测试覆盖工具注册、上下文和严格结果契约；管理端组件覆盖策略保存。真实多 Agent DSH、OIDC 撤权及压力/故障仍留 PF-07 | Token/成本仍为不支持；具体 Agent 只有模板触发且目标版本、最小上下文、预算和失败语义验收完成后才启用委派 |
| AS-10 真实结果 | **基础已实现（B-04）**。[任务结果领域投影](../../server/src/domain/task-result.ts)与仓储/API/前端以 `task-result/v1` 区分执行终态、业务结果、回执、证据和待处理项；成果引用固定到来源 Attempt 与不可变版本 | 领域、PostgreSQL、HTTP、前端及 [P1 浏览器用例](../../e2e/personal-integration/task-result.spec.ts)覆盖已登记成果、仅回答、成果登记缺口和失败路径；仍不能替代具体 Agent 的目标质量评测或真实外部写回执 | 具体 Agent 补目标案例；外部异步写能力接入时补 `accepted` 后状态核对；真实 DSH/OIDC 留 P2 |
| AS-11 版本追溯 | **部分实现**。[迁移 0039](../../server/migrations/0039_agent_release_governance.sql)保存包、候选、试运行和证据；发布事务复核 sealedRevision/最新试运行；RunAttemptRecord 保存 Manifest 摘要和模型路由快照 | 发布集成覆盖修改候选使证据失效、人工判失败阻塞发布、同版本不同内容冲突；覆盖真实绑定修订与封存后漂移拒绝；跨环境变更验证未覆盖 | 与 AS-01 一起补真实发布依赖；小范围启用和目标环境验证仍是发布门槛 |
| AS-12 评测与审计 | **基础契约已实现**。发布服务采用 [`AgentEvaluationSuite v1`](agent-evaluation-template.yaml)，要求 success/invalid_input/permission_denied/prompt_injection/capability_failure 五类案例；候选与版本证据记录契约版本、case Run/Attempt、机器断言和人工 rubric 结论 | 包解析拒绝旧数组、未知版本/字段/断言；发布集成使用 `TrialStubRuntime` 验证五类案例和逐项人工判定。平台故障/安全测试独立维护，真实目标质量与成本仍需具体 Agent/P2 证明 | 为每个拟发布 Agent 替换通用输入/rubric并留 P2；不复制平台通用故障套件，也不将平台生成五案例视为业务验收完成 |

## 3. 已确定的契约决策与具体缺口

### D-01 绑定分离保留现有发布入口

遵循 [Agent 设计规范](agent-design-standard.md)的“定义版本 + 环境绑定修订 → 平台发布版本”逻辑，不新增强制 Release ID。**B-03 起（2026-09-20）计划/封存/Attempt 已从真实 `tool_binding_revisions` 解析**：端点/身份/授权等语义字段变化产生新修订并使旧封存证据失效；原先的固定 `binding-rev-3` 占位已移除（计划项、候选封存依据、版本绑定引用、管理端展示均为真实记录）。

### D-02 包的当前支持与目标格式分开

**当前契约（B-01 基础上由 AE-01 更新）：** `parseAgentPackage` 只接受分层 `agent.yaml`（`apiVersion: dsh-work.ai/v2`、`kind: AgentPackage`、`metadata`、`spec`），经 [agent-package.schema.json](agent-package.schema.json)（Ajv，`additionalProperties: false`）严格校验后归一化为 `AgentSpec`。指令必须经 `spec.instructions` 固定引用包根目录 `SOUL.md`；能力依赖为 `capabilities.skills/tools` 下可为空的 `id@x.y.z` 精确引用；`input`/`output`/`context`/`limits`/`model.requirements`/`evaluation` 均有版本化契约。旧扁平清单、字段别名（display_name、prompt_file、role_ids、skill_refs、tool_refs、max_tokens 等）、未知字段、重复 YAML 键与平台受管字段（凭据、端点、模型路由、执行环境、绑定、授权范围、调度、安装钩子等）一律在解析阶段拒绝，不再有警告后忽略或双格式解析。无 `evals/cases.yaml` 时发布服务仍生成默认案例（带 `origin` 来源标记）；缺少 checksums 时解析给警告，发布检查阻塞；提供清单时须覆盖全部文件（除清单自身）。解析、候选检查与发布是不同阶段，不支持用“平台自动生成摘要”替代 ZIP 发布门禁。配置入口与 ZIP 归一化为同一 `AgentSpec` 并持久化于 `agent_versions.agent_spec`；限额列由 `max_tokens` 更换为 `max_output_bytes` + `max_tool_calls`（迁移 0046），既有行按平台默认值补齐、不回填定义。

**历史记录（2026-09-19，已被 B-01 取代）：** 原基线曾接受扁平清单与字段别名并做冲突校验，详见 I-02 完成记录。2026-09-20“不考虑历史兼容”决策生效后，别名接受、未知字段警告、双格式解析均已移除，不做旧包兼容或渐进迁移。

### D-03 Runtime TypeScript 与 JSON Schema 的原有漂移已修复

原有外置 Skill 字段缺失已由 I-01 修复；B-02 又统一了引用的严格规则。当前 [Runtime 类型](../../server/src/modules/runtime/runtime-types.ts)、编译器与 [Schema](runtime-manifest.schema.json)均支持显式内联/外置形式。本轮新增 `model_requirements` 同步三处，并用有效、未知、重复及错误类型样本验证。历史修复过程见 I-01；新增字段仍须同步生产者与消费者。

### D-04 Session、恢复和预算不因文档改名升级

PF-01 已使 Task/Run 支持有 Session 与无 Session 两种入口；自动任务仍创建独立 Session，现有会话模式继续受支持。PF-04 已增加 Run `waiting`、动作绑定审批和跨进程新 Attempt 恢复；DSH 当前不恢复原 ACP Session，平台以受控检查点重建新 Attempt。

PF-02 在 Task 预算账户上累计跨 Attempt 的可执行时长、工具次数与输出字节，并在 Attempt 创建事务中预占；Manifest limits 继续由 Runtime/DSH 执行。Token 只有 Runtime 同时上报输入和输出时才记录，否则明确为 unavailable；金额和 Token 硬预算均拒绝，不能由文本或输出字节推导。目标 Runtime 的真实执行约束仍需 PF-07 实测。

### D-05 结果状态与证据已独立建模

B-04/I-06 已实现 `task-result/v1` 读时投影：`succeeded` 只表示平台执行终态，`outcome` 独立表达 `pending/achieved/unverified/not_achieved`，并关联回答、工具动作、Artifact 版本、来源 Attempt 和待处理项。自动任务执行列表与对话详情均消费该投影；未从旧文本推断成功，也未另建 Agent Loop。具体业务目标质量及外部异步写回执仍由 Agent 专属案例和能力契约补充。

### D-06 自动任务 P1 第一批已落地，P2 证据待归档

当前仓库有自动任务迁移、服务、日历、触发扫描、API、[P0 浏览器冒烟](../../e2e/automation-smoke.spec.ts)和 [P1 集成旅程](../../e2e/automation.integration.spec.ts)。P1 使用专用可丢弃 PostgreSQL、受控身份与合成 Runtime，覆盖同键去重/准备中断、遗漏展示/失败不重试、账号停用/越权读取、固定版本/暂停及交互容量保留。服务集成仍负责事务、游标、领取竞态和 advisory lock 等底层断言。这些仓库内证据本身不包含真实 DSH、OIDC、目录同步或外部工具；用户已确认 P2 手工执行完成，仍须按生命周期模板归档环境、版本、运行和验收结论后，才能成为仓库内可审计的 P2 记录。

## 4. 具体需要实施的工作

2026-09-20 起按“不考虑历史兼容”组织实施：I-01～I-08 合并为 B-01～B-05。2026-09-21 进一步决定在继续开发具体 Agent 前完成平台基础能力计划，原按需暂缓的 I-09～I-13 与外部异步动作、累计预算纳入 PF-01～PF-07；这些能力先在平台层依序建设，具体 Agent 仍按触发条件选择，不默认启用。B-01/B-02 已清理旧包别名、双格式与旧引用接受，B-03 已落地 default 环境绑定修订。保留 I 编号用于差异追踪；未标完成的要求不能当作已支持能力。工程归属沿用 [AG-03 实施方案](../design/automation-implementation-plan.md)及 [Runtime EX 方案](../design/runtime-execution-optimization-plan.md)。

为便于追踪已有代码和验收目录，保留阶段编号：AG-01 表示 Agent 包与发布，AG-02 表示工具扩展，AG-03 表示轻量自动任务，AG-04 表示受控经验。AG-01/02/04 的后续工作直接以本文 I 编号为入口，无需查阅已删除的总方案；AG-03 与 EX 的细节使用上述现存文档。阶段编号不表示能力已实现或已授权启动。

### 4.1 五个实施包与范围精简

统一取消旧格式双读、历史别名、旧配置转换、旧版本绑定回填、旧 Run 结果展示和新旧版本兼容测试；保留新契约内部的多版本治理、当前授权、能力匹配、并发/幂等、故障恢复及分层验收。必要建表/结构变更仍需实现；不含清库、删除已有文件或历史执行。

| 实施包 | 原工作项 | 仍需实施的内容 | 省去的历史兼容工作 | 当前状态与依赖 |
| --- | --- | --- | --- | --- |
| B-01 统一定义与严格包格式 | I-02 + I-03 | 唯一格式、规范化 AgentSpec、严格字段与依赖校验、文本输入输出/recent 上下文/模型要求；配置与 ZIP 共用契约 | 旧包别名、双格式解析、渐进收紧、旧定义转换与默认值回填 | **基础已实施**：结构与持久化、配置保存/分叉保留定义、模型与 Runtime 准入。高级模型能力实际支持仍待接通；不影响无额外要求的 Agent |
| B-02 统一运行契约与预算 | I-01 + I-07 | 选定唯一引用规则，Schema/类型/编译/存储同口径；同步清理旧读取分支，验证可执行限额和交互容量 | 旧持久化引用接受、存量预算字段转换及旧 Manifest 运行兼容 | I-01 漂移修复完成；`artifact_ref` 唯一引用规则已实施（2026-09-20，Schema/编译器/存储层读写同口径严格模式，旧生成器首尾符号引用不再接受）；I-07 限额核查已实施（2026-09-20，执行矩阵见 I-07 记录；实证修复输出截断静默缺口） |
| B-03 真实绑定与发布追溯 | I-04 | 真实绑定修订、定义/发布/Attempt 关联、变更影响与证据失效；新契约内多版本追溯与回滚 | 旧绑定还原、历史发布记录回填和跨旧格式回滚 | **已实施（2026-09-20，见 I-04 完成记录）**：`tool_binding_revisions` 持久化 + Manifest `tool_bindings` 固定 + 执行复核 + 封存/发布漂移拒绝；多环境独立发布与跨环境差异待真实环境验收 |
| B-04 工具及任务结果契约 | I-05 + I-06 | 工具输入输出/效果/错误、结果外层、回执/成果、统一 API 与 UI；既有工具同步适配 | 新旧工具协议并存、旧 API 适配、旧 Run 展示及从历史文本补结果 | **I-05、I-06 已实施（2026-09-20）**。平台工具执行契约已贯通；`task-result/v1` 读时投影区分执行终态与业务结果（见 I-06 记录）；DSH 原生输出明确标出不可验证边界；外部异步写协议随实际能力接入 |
| B-05 分层评测与验收 | I-08 | 新格式拒绝、任务质量、实时权限、故障/预算、P1 浏览器及真实 P2 证据 | 旧版本兼容、历史回填及迁移正确性测试 | **代码级基础已完成；此前 P2 仅有口头结论**：自动任务 P1 第一批 5/5 已提交；平台权限/故障阶段矩阵已闭环；Agent 专属 `AgentEvaluationSuite v1` 已接入包解析、发布试跑、版本证据与管理端；PF-07 当前版本仍需真实 P2 |

### 4.2 平台基础能力建设顺序

下表保留平台通用能力的建设顺序与完成边界。PF-01～PF-06 已达到列出的代码级范围；PF-07 的目标版本 P2 验收由独立[运行手册](pf07-platform-acceptance.md)和[能力矩阵](agent-platform-capabilities.v1.json)继续跟踪。新任务仍须使用既有 Run/Attempt、Runtime Adapter 与 DSH 链路，不得建立第二套 Agent Loop；使用尚未完成真实验收的能力时，应在该任务发布前完成适用场景的 P2，不以代码级完成代替发布准入。

| 顺序 | 实施包 | 统一平台交付物 | 完成门槛 |
| --- | --- | --- | --- |
| PF-01（已完成，2026-09-21） | 任务与外部操作基础 | 与 Session 解耦但兼容现有会话的 Task/触发来源；稳定关联键；外部动作 operation id、幂等键、参数摘要、`accepted/completed/failed/unknown` 回执及状态查询 | 相同事件/动作不重复生效；结果与 Artifact 有明确归属和读取授权；同步、异步和结果未知可区分 |
| PF-02（已完成，2026-09-21） | 用量与累计预算 | Task 预算范围内的 Attempt/Run 时长、工具与输出累计；Token/成本能力状态；预算预占、结算、并发检查、超限拒绝及不支持能力的明确状态 | 并发不越过总预算；缺少可靠 Runtime 计量时不能宣称硬限制；取消和恢复不重复结算 |
| PF-03（代码级与 P1 已完成，2026-09-22） | MCP 受控接入 | 复用 Connector 的 Streamable HTTP MCP Server 登记、添加前不落库连通测试与服务端复核、平台生成内部标识、Bearer Token 加密入库与轮换、完整 Tool 清单发现与自动生效、全部 Agent 默认可用、已准备 Attempt 的能力摘要漂移门禁、受控删除、DSH 调用和 Tool 级审计；不生成 Agent Grant 或平台 Tool Version/Binding | P1 服务集成与管理端浏览器旅程完成；真实批准服务的发现→自动生效→调用→停用/删除、真实凭据和目标 DSH 证据留 PF-07 P2；Resources/Prompts/stdio 不在当前支持范围 |
| PF-04（代码级与管理端已完成，2026-09-22） | 持久化等待与审批恢复 | Run 等待状态、有界完整检查点、事件关联、动作绑定审批、批准消费有效期、并发决定冲突、遗留审批清理、超时/取消、恢复前重新鉴权、输出文件恢复及旧 Attempt 隔离；无需审批不捕获检查点 | 一次性 PostgreSQL、Runtime Adapter、员工端和管理端测试覆盖重启保留、批准后过期、并发相反决定、旧审批与重试隔离、重复决定、新 Attempt 前端切换、终态事件、迟到旧 Attempt、Worker 释放及未知副作用阻断；真实 DSH 动作审批与真实撤权故障留 PF-07 P2 |
| PF-05＋AE-04（代码级，2026-09-23） | 受控记忆与经验 | Agent Version 可显式声明提案工具；员工从本人成功 Attempt 明确提交候选和来源授权；管理员审核、独立不可变版本、当前 ACL 与稳定 Agent 身份检索、Manifest 固定引用、临时投影、冲突/保留、撤回传播和审计 | 一次性 PostgreSQL、Runtime/Schema、组件与 P0 原型浏览器测试覆盖提案、授权、审核、ACL、版本、引用和撤回；真实 DSH/OIDC 身份变化仍需 P2 留证 |
| PF-06（代码级与管理端已完成，2026-09-23） | 受控 Agent 委派 | 平台受管的精确目标版本允许列表；无 Session 父子 Task/Run；最小显式上下文；当前授权与父快照上限交集；PF-02 根预算；深度/并行/容量预留/超时门禁；委派 Task 禁止通用重试；取消、重启对账和全回执 `task-result/v1` 合并 | 一次性 PostgreSQL、Runtime/Schema/策略、当前授权和管理端组件测试覆盖版本固定、幂等、边界、预算、撤权、重试隔离、满载拒绝与子席位预留、取消、恢复及混合回执结果真值；真实 DSH 多 Agent、真实身份撤权和容量故障留 PF-07 P2 |
| PF-07（部分完成） | 平台基线验收 | [版本化能力矩阵](agent-platform-capabilities.v1.json)、P0/P1 入口和 [验收手册](pf07-platform-acceptance.md)已建立；覆盖无 Session、外部动作、累计预算、MCP、等待/审批、记忆和委派 | P1 已在本地隔离环境运行，目标提交与 CI 结果仍需固定；当前版本 P2 尚须在真实 DSH/OIDC/批准连接上执行并留代码版本、身份、环境、Runtime、Run/Attempt、故障/撤权和结果证据，复核通过后才开放给 Agent 发布 |

**阶段移交：** 本清单不再作为继续新功能开发的排队清单。PF-07 的目标版本真实验收继续开放，由[运行手册](pf07-platform-acceptance.md)跟踪环境、身份、Runtime、Run/Attempt、故障与验收人证据；[本地隔离环境进度](pf07-oidc-isolated-progress-2026-09-23.md)仅覆盖部分场景。此前手工 P2 无原始记录且早于当前能力，不能作为通过依据。发布依赖这些能力的 Agent 时，须完成适用场景并经复核后再开放；平台整体 PF-07 仍未通过。

**PF-01 完成记录（2026-09-21）：** `0050_task_operation_foundation.sql` 建立 `tasks` 与 `task_operations`，`0051_session_neutral_task_execution.sql` 将 Run 和 Artifact 的 Session 关系改为可选并固定 Task 归属。Task 以 `source_type + correlation_key` 幂等，API/event 请求同时固定请求摘要，同键换请求内容会冲突；Task 与无 Session Run 在同一事务受理。Runtime Manifest 必填 `task_id`，`session_id` 可为空。`POST /api/workbench/v1/task-executions` 受理 API/event Task，查询、取消和重试继续使用既有 Run/Attempt、Runtime Adapter 与 DSH；结果、事件和 Artifact 由 Task 查询，Artifact 下载按当前 Workspace 权限和 Task 发起者重新鉴权。

写入平台工具在执行前自动登记 Operation，Task + 动作/参数摘要形成稳定幂等边界；重复投递不会再次进入处理器。同步完成记为 `completed`，异步系统确认受理后保持 `accepted`，明确失败记为 `failed`，执行后无法确认记为 `unknown`。员工端可查询 Task 的 Operation；平台管理员核对权威外部状态后可把 `accepted/unknown` 收敛为 `completed/failed`，终态回执不可改写。

代码级验收覆盖：Session 与无 Session Task、Task/Run 原子受理、关联键复用、同键换参拒绝、平台工具同步回执重放、异步受理不重复执行、未知效果核对、Runtime Manifest、无 Session DSH 编排、Task Artifact 生成/查询/下载及公开 HTTP 契约。真实 OIDC、真实外部写入和目标环境 DSH 属 PF-07 P2 证据，不由单元或一次性 PostgreSQL 绿灯替代。

**PF-02 完成记录（2026-09-21）：** `0052_task_cumulative_budgets.sql` 为每个 Task 建立预算范围和账户，并为每个 Attempt 保存一条预占/结算记录。当前根 Task 自成范围；数据结构允许 PF-06 的子 Task 显式共享根范围，但本项不实现委派。可执行维度为累计时长、工具次数和 UTF-8 输出字节：创建 Attempt 时锁定账户并按 Manifest limits 原子预占，终态按 Runtime/平台证据释放未用额度；排队取消释放全部，活动执行缺少精确回报时按时间戳和预占上限保守结算。重复终态、重复事件或恢复兜底不会二次扣减。

会话 Run、无 Session API/event Task 与自动任务均复用同一账户、Attempt 和 DSH 链路。`cumulativeBudget` 固定在 Task 请求摘要中，时长/工具/输出上限同时收紧单次 Manifest limits；Manifest 固定范围、累计限额、预占和执行能力，编译与持久化边界拒绝不一致。Task 查询返回 limits、usage、reserved、remaining、能力状态及逐 Attempt 来源。Token 只有 Runtime 同时上报输入/输出时才记录；缺失时为 null + `unavailable`，不从回答文本估算。成本没有可核验价格来源，保持 unavailable；Token/成本硬预算明确返回 422，不伪装成已执行。

代码级验收覆盖：迁移幂等、跨 Attempt 结算与重放、共享范围并发预占、取消释放、不支持能力、Runtime Schema/编译一致性、API 单次限额收紧与预算查询、自动任务、故障恢复、安全、共享文件及团队生命周期回归。该 PF-02 证据不覆盖真实 DSH 的 Token 回报、真实模型成本或委派树；PF-06 委派能力现已另行完成代码级实现，其真实多 Agent 证据仍纳入 PF-07。

评审修复补充：升级迁移为既有 queued/running/cancel_requested Attempt 按其固定 limits 建立预占，恢复入口只对可信的历史持久化 Manifest 补无上限累计预算快照，并在重新入队前保存新摘要；新建 Manifest 仍由 Schema 和编译器严格要求 `budget`。精确结算与取消兜底统一按“预算账户 → Attempt 用量”加锁。未声明累计预算的 API 请求保留 PF-01 请求摘要算法，带预算请求使用显式 v2 摘要域。`tool_call_count` 仅在 `usage_source=dsh-session-log` 时作为 Runtime 实测值，证据不可用时按本 Attempt 预占工具上限保守结算。

**PF-03 完成记录（2026-09-21，代码级与 P1）：** `0053_mcp_connector_governance.sql` 在既有 `connectors` 和 `credential_refs` 上增加一对一 MCP Profile 与逐调用审计。管理员登记 Streamable HTTP 服务并发现完整 Tool 清单，平台自动固定规范化清单摘要并立即生效；健康且能力快照已同步的 Connector 默认对租户内全部 Agent 可用，不创建 Agent→Connector 或逐 Tool Grant。MCP Tool 不复制为平台 Tool/Tool Version/Tool Binding，也不进入 Agent Version、候选封存或发布事务。

`0060_remove_agent_mcp_grants.sql` 直接删除旧 Agent→Connector Grant 表；当前没有需要保留的历史授权数据，因此不提供兼容读取、转换或回退路径。管理 API、领域 DTO、前端 Store 和页面权限入口同步删除。

`0054_encrypted_connector_credentials.sql` 在同一 Connector 模块内增加应用层加密凭据表，没有新建凭据管理模块或第二套连接器。MCP 登记接口不再接收人工 Connector ID、`serverName`、所属系统或凭据引用；平台生成内部字段，管理员直接输入一次 Bearer Token。开发和生产均使用 PostgreSQL 密文存储与环境主密钥方案，区别仅在密钥值；Token 可从管理端轮换，查询、详情、审计和运行快照都不返回明文。升级时旧 `dsh-managed` Bearer Connector 保留原 ID 和 Profile 并进入 `degraded`；管理端显示“需要重新录入”。重新录入为目标 Connector 建立独立加密凭据并改绑，旧版共用同一环境变量引用的其他 Connector 继续保留旧引用及降级状态，不会随本次轮换改变。发现开始时固定凭据引用、后端和密文版本；写回事务先锁 Connector，再用独立查询读取锁后版本，轮换期间返回的旧检查结果只留健康检查记录，不覆盖当前状态或能力快照。

`0055_mcp_connector_deletion.sql` 增加 Connector 软删除标记。新增表单必须先调用不持久化 Connector/Token 的 DSH 连通测试，连接字段变化会使结果失效；正式登记接口重新发现并只在成功后原子写入 Connector、能力快照和凭据。列表删除会使所有 Agent 后续运行立即停止解析该 Connector，同时撤销 Binding、停用关联 Tool、销毁独占加密凭据；Connector、Profile、健康检查和调用审计继续保留用于审计。

运行准备把当前健康且已同步的 Connector 和摘要写入 Attempt `mcp_connections`，领取、活动复核和 Worker 启动解析均检查 Connector 状态及摘要一致性。能力列表变化在成功检查后自动成为最新生效快照；已准备 Attempt 因固定旧摘要而在活动复核时失败，新 Attempt 使用最新摘要；停用或删除同样使既有快照在下一次复核失败。管理员只填写名称、端点、认证方式、整体权限范围和可选 Bearer Token；平台生成 Connector ID 与 `serverName`，MCP 不再要求“所属系统”。Bearer Token 由环境主密钥使用 AES-256-GCM 加密后写入 `credential_secrets`，API 仅返回已配置状态；轮换覆盖密文并保留人工停用。Adapter 不使用 ACP `session/new.mcpServers`，而是通过官方 DSH Cordis MCP 插件生成每 Attempt Patch；服务端只在运行边界解密，Patch 只保存环境变量引用，明文经子进程环境传递。DSH 工具策略按 `mcp__<serverName>__*` 放行当前 Attempt 固定的 Server 命名空间，真实调用从 DSH Session Log 投影为 Tool 名、参数摘要、Run/Attempt 和结果审计，成功、失败或取消路径均尝试收集。

代码级验收覆盖：Manifest 类型/Schema/编译一致性、只接受 Streamable HTTP、平台生成标识、Bearer Token 密文存储/运行时解密/轮换、不回显、旧引用原地升级、轮换与发现并发隔离、Patch 不落凭据、Server 命名空间隔离、Connector 登记后对全部 Agent 自动可用、能力变化自动同步、旧 Attempt 摘要阻断、调用审计以及停用和删除。租户可用 MCP Connector 与 Runtime Manifest 共用 20 个上限；登记、重新启用和检查恢复健康均在租户级事务锁下校验，并发请求也不能产生第 21 个健康 Connector。`admin-mcp-connector.integration.spec.ts` 使用一次性 PostgreSQL 与合成发现 Runtime 固化管理端简化登记、Token 轮换、自动生效、全部 Agent 默认可用、Tool 不复制、清单变化自动同步和停用/删除旅程。当前 DSH MCP 插件只提供 Tools，因此 Resources、Prompts、stdio 和包内服务进程明确未支持。目标企业 MCP 服务、真实 Bearer Token、实际模型触发调用、超时/取消及运行中停用或删除仍须在 PF-07 P2 环境留证；本记录不把合成 Runtime 或一次性 PostgreSQL 测试称为真实联调。

评审修复补充：生产使用的 `CapabilityGuardedRuntime` 转发 MCP 发现到原 DSH Adapter。每个 Worker 同时获得 Attempt 固定的生效 Server 摘要，DSH 策略在 Profile 加载、`tools/change` 及调用前按实际 Tool 名称、说明和输入 Schema 重算整体摘要，未重新执行管理端检查时出现的新 Tool 或 Schema 变化也会立即拒绝。发现/健康检查只更新观测结果和能力快照，不覆盖人工 `disabled`，恢复必须显式启用。首次发现会先创建 Runtime 根目录；Session Log 中只有 MCP 调用而没有 usage 时，调用审计继续记录，但 Token 保持 `null/unavailable`，不会作为零消耗上报或结算。

### 4.3 原工作项映射与完成记录

| 工作项 | 对应规范/差异 | 具体交付物 | 前置依赖及归属 |
| --- | --- | --- | --- |
| I-01 修复 Runtime Schema | AS-04/11，D-03 | ~~支持内联/外置 Skill 的一致 Schema、编译校验及正反例~~ **已完成（2026-09-19）** | 可先独立修复；Runtime 契约 |
| I-02 包校验原基线 | AS-02/11，D-02 | 字段规则、冲突检查与反馈 **原基线已完成（2026-09-19）**；新严格格式清理见 B-01 | 可独立；AG-01 包与发布 |
| I-03 落实规范化 Agent 定义 | AS-02/04，D-02/04 | 配置/ZIP 共用定义、输入输出与上下文策略、模型/Runtime 能力校验 | I-01/02；AG 定义及运行准备 |
| I-04 落地真实绑定修订 | AS-01/07/11，D-01 | 绑定修订、发布/Attempt 引用、变更影响与证据失效机制 | 可先做既有能力绑定；与 I-03 接口对齐；AG-01/02 |
| I-05 统一工具契约与结果 | AS-05/06/07 | 输入输出校验、稳定错误、效果/重试语义、既有工具贯通样例 | 既有工具可独立；外部写入依赖 I-04；EX-01 |
| I-06 增加任务结果外层 | AS-10，D-05 | 区分执行终态与业务结果的存储/API/前端投影 **已完成（2026-09-20，`task-result/v1` 读时投影）** | I-03 的输出要求、I-05 的动作结果；EX-01/02 |
| I-07 核实并补齐预算执行 | AS-09，D-04 | 限额执行矩阵、现有限额漏洞修复及边界测试 | 现有时长/工具/输出上限可独立；EX-00、AG-03 |
| I-08 补齐评测和验收证据 | AS-03/07/08/12，D-06 | 评测分层、现有安全/故障回归、自动任务 P1 浏览器旅程、P2 记录 | 现有路径可先验证；新增契约随 I-01～07 增补；AG/EX 共同门禁 |
| I-09 接入外部能力/MCP | AS-05/06/07 | Streamable HTTP MCP Connector 的整体发现与自动生效、全部 Agent 默认可用、DSH 调用、已准备 Attempt 摘要漂移及停用/删除验证 | **PF-03 代码级已完成**；独立于 I-04 平台 Tool Binding 和 Agent 发布，真实服务证据纳入 PF-07；AG-02 |
| I-10 持久化等待与审批恢复 | AS-07/08，D-04 | 安全检查点、等待/恢复协议、动作绑定审批和恢复测试 | 纳入 PF-04；DSH 能力验证、I-04～08、PF-01/02；EX-03A/B |
| I-11 受控记忆与经验 | AS-04/11/12 | 来源授权、候选审核、独立版本、检索及撤回机制 | 纳入 PF-05；I-03/04/08；AG-04 |
| I-12 受控 Agent 委派 | AS-09 | 父子运行关系、权限/预算传播及取消协议 | **PF-06 代码级已完成**；真实多 Agent DSH 与身份/故障证据纳入 PF-07；I-04/06/07/08、PF-01/02 |
| I-13 无 Session 任务入口 | AS-01/10，D-04 | 独立触发来源、任务结果读取与访问授权、统一契约 | 纳入 PF-01；I-03/04/06/08；保持既有对话及自动任务入口 |

以下 I-01/I-02 的完成记录描述当时实现；后续新增范围按五个实施包执行。实施包编号与 P0/P1/P2 验证层级相互独立。

### I-01 修复 Runtime Schema 与实际 Manifest 的漂移

**B-02 后续范围：** 下述完成记录保留事实；其中为旧引用放宽读取规则的兼容处理已随 B-02a 移除（2026-09-20）：`FileSystemSkillArtifactStore.resolveReference` 删除 `LEGACY_REF_PATTERN` 改用写入侧严格 `REF_PATTERN`，`compileRuntimeManifest` 的 `ARTIFACT_REF_PATTERN` 与 `runtime-manifest.schema.json` 同步收紧为包名段首尾字母数字的唯一规则，旧生成器持久化引用（如 `packages/____/<sha>`）在 Schema、编译与加载三处一致拒绝；复审后该规则收敛为共享常量 `domain/skill-artifact-ref.ts` 的 `SKILL_ARTIFACT_REF_PATTERN`（存储层与编译器共同引用，Schema 中的等价 pattern 由 contracts 静态检查固定）；`skill-package.test.ts` 与 `runtime-manifest-schema.test.ts` 的旧格式接受用例已翻转为拒绝。验证：`test:runtime` 59/59、`test:skill-install` 9/9、`m3-orchestration` 12/12、`m4-skill-management` 1/1、`admin-skill-installation` 11/12（1 例真实 DSH 按标记跳过）、typecheck、`pnpm verify` 通过。历史数据不删除；含旧引用形态的持久化记录不再可执行。

**状态：已完成（2026-09-19）。** Schema 已补齐 `artifact_ref`/`instructions_sha256` 及内联/外置条件约束（外置不兼容内联正文缓存、外置文件索引禁止携带 content）；`compileRuntimeManifest` 作为持久化前的实际关口同步 fail-closed，拒绝外置携带 `instructions`/文件 `content`、内联携带 `instructions_sha256` 及未声明字段，`artifact_ref` 对新生成引用要求包名段首尾字母数字（由 `FileSystemSkillArtifactStore` 写入自检保证；读取/编译侧兼容旧版生成器未清理首尾符号的持久化引用），`.`/`..` 遍历段仍拒绝；外置 Skill 的声明文件大小总和在编译期校验，实际文件字节预算由 `FileSystemSkillArtifactStore` 加载侧按 `stat` 预检的实际文件大小执行。结构（Schema）与内容（编译/加载）分工由 `server/src/modules/runtime/runtime-manifest-schema.test.ts` 以同一样本双边界验证（10 例，含 ajv draft 2020-12 严格编译；声明大小预算用例仅编译侧断言）；`test:runtime` 已接入，contracts 静态检查断言外置字段与禁止条件。顺带修复既有 Schema 中 `if` 子 schema 缺 `properties`/`type` 声明的严格模式问题。验证：`pnpm test:runtime` 59/59、`pnpm test:skill-install` 9/9、`tsc --noEmit`、`pnpm verify`、`pnpm check:architecture`、eslint 均通过。未覆盖：Schema 仍未编码编译器的 ID 字符集等细粒度内容规则（属内容边界职责）；模型能力要求字段不在本项。

**2026-09-19 兼容修正：** 复审发现收紧后的 `artifact_ref` 规则使旧版生成器持久化的引用（中文名等落成 `packages/____/<sha>` 等首尾带符号的包名段）在编译与加载两侧被拒，既有 Skill 无法运行；同时 `referenceFor` 先截断到 64 字符而未清理首尾符号，长名称第 64 位恰为 `.`/`-`/`_` 时会生成自检不通过的引用。修复口径：**写入侧保持严格**（`referenceFor` 改为截断后再清理首尾符号，空名回退 `skill`，`put` 仍以严格 `REF_PATTERN` 自检新生成引用）；**读取/编译侧兼容旧格式**（`FileSystemSkillArtifactStore.resolveReference`、`compileRuntimeManifest` 的 `ARTIFACT_REF_PATTERN` 与 `runtime-manifest.schema.json` 同步放宽为段字符集 `[A-Za-z0-9._-]{1,64}`，`.`/`..` 段仍拒绝，越界防护由 resolve 边界检查承担），不做数据迁移即可读取既有持久化引用。复审后进一步加固：外置 Skill 文件索引的声明 `size` 总和在编译期计入 `MAX_SKILL_BYTES` 预算（此前仅加载侧 stat 兜底），`artifact_ref` 与 `instructions_sha256` 校验拆分为独立错误消息。验证：`runtime`/`skill` 模块单测 103/103（含旧格式接受、`.`/`..` 与遍历拒绝、外置声明大小预算用例）、`m4-skill-management` + `admin-skill-installation` 集成 12/12（1 例真实 DSH 用例按标记跳过）、`pnpm typecheck`、`pnpm verify`、`pnpm check:architecture`、`pnpm lint` 均通过。

**改动位置：** [Runtime Schema](runtime-manifest.schema.json)、[Runtime 类型](../../server/src/modules/runtime/runtime-types.ts)、[Manifest 编译器](../../server/src/modules/runtime/manifest-compiler.ts)、[Adapter 测试](../../server/src/modules/runtime/runtime-adapter.test.ts)、[Skill 文件存储](../../server/src/modules/skill/file-system-skill-artifact-store.ts)及 [contracts 静态检查](../../scripts/checks/contracts.mjs)。

1. 按实际用途确定同一契约下的内联与外置 Skill 形式，禁止含糊混用；不通过去掉 `additionalProperties: false` 放宽整个对象。B-02 同步统一引用生成、Schema、编译和加载规则，不再要求接受旧生成器的持久化引用。
2. Schema 增加 `artifact_ref`、`instructions_sha256` 及条件约束：无外置引用时需要正文/文件 content；外置时要求完整引用、摘要与文件索引。同步路径、摘要、文件大小及必填关系；需读取内容才能验证的摘要真实性保留在编译/加载阶段。
3. 使用同一组实际 Manifest 样本验证 Schema 与编译器，明确结构校验和内容校验的分工；将覆盖接入现有契约/Runtime 测试入口，避免 verify 仅检查字段文字。

**完成标准：** 合法内联/外置样本均可运行；缺少摘要、非法引用路径、缺少必要正文、额外字段或索引不一致在对应边界被明确拒绝；不改写历史 Manifest，也不修改 Agent 包格式。通过契约检查与相关 Runtime 测试。

### I-02 明确 Agent 包字段与冲突规则（原基线完成）

**B-01 后续范围：** 下述记录描述已完成的原字段政策。**2026-09-20 起别名接受、未知字段警告与双格式解析已随 B-01 移除**，见 I-03 完成记录与本节末尾的 B-01 实施记录。

**状态：已完成（2026-09-19）。** 扁平清单字段白名单及别名关系固化在[包解析器](../../server/src/modules/agent/agent-package.ts)头部注释与 KNOWN_MANIFEST_KEYS；`apiVersion`/`api_version`/`spec` 结构清单标记单独报“格式不支持”错误而非按未知字段忽略；身份、凭据、端点、模型路由、执行环境、外部能力接入与安装钩子等平台受管字段按 RESERVED_MANIFEST_KEYS 逐项列名拒绝（含 auth_token/bearer_token/jwt/session/cookie 等凭据会话关键字与 proxy/upstream/registry/headers 等连接类关键字）；其余未识别字段警告后忽略（检查反馈路径，不静默吞掉）。同一字段多别名并存按“取值一致警告、不一致拒绝”统一处理（含 cases 内 kind/type、expect/expected、依赖条目 id/name）；列表取值按元素集合比较，元素顺序不视为冲突；`system_prompt` 与 `system_prompt_file` 并存按内容一致性同样处理。tool.yaml 的 `id`/`name` 为不同字段不作别名；描述符 `id`/`name` 与目录名回退值均须符合能力标识规则（`DEP_ID_PATTERN`），非法标识直接拒绝。YAML 解析与对象化（含锚点/别名禁用）全程归入统一 `agent_package_invalid` 422 校验错误，底层库异常不外泄。依赖引用收紧为 `id`/`id@x.y.z`：空条目、`id@` 缺版本、版本非 x.y.z、非法字符集、同 id 多版本声明均明确拒绝；完全相同重复声明去重并警告。声明版本与包内候选版本冲突由“警告并以包内版本为准”改为明确拒绝，报告声明版本与包内版本；`skills/`、`tools/` 下缺描述符文件的目录警告提示而非静默忽略。默认生成案例带 `origin: 'generated'` 持久化标记，发布检查详情提示核对实际业务预期，工作台“检查与案例”页同步展示来源且试运行案例卡片逐条标记“平台生成”；`updateCases` 的 `origin` 由服务端维护——仅沿用既有生成案例 id 的标记，调用方传入的 `origin` 一律忽略，不能伪造或清除。可解析/候选检查通过/可发布三阶段边界保持不变，ZIP 缺摘要仍按发布门禁阻塞。本地样例包 refund-ops-agent 声明版本已修正为与包内候选一致的 0.1.0。验证：`agent-package.test.ts` 34/34、`agent-release-governance.integration.test.ts` 16/16（含受管字段、结构清单、版本冲突、别名冲突、未知字段留痕、YAML 别名错误映射、tool id 校验、origin 服务端维护用例）。未覆盖：`apiVersion/spec` 目标格式未设计；tool.yaml 描述符的受管字段治理属后续准入流水线；未知字段“先警告后收紧”的后续收紧时间点未排期。

**2026-09-19 复审加固：** 针对复审发现的边界问题完成第二轮修复。`requestChanges` 与 `withdrawSubmission` 改为事务内先锁 `agents` 再锁进行中候选行（与 publish/ensureCandidate 同序，避免死锁），状态校验与更新同事务完成，并发提交/发布/撤回不再相互写偏；不存在的 Agent 统一返回 404。`resolveDeclared` 收敛到能力服务的规范断言（`assertPublishedReferences`/`assertAvailableReferences`），未锁版本的声明先解析到平台当前活动/最新发布版本再断言，声明工具版本与平台可用版本不一致（如 `read@9.9.9`）明确进缺失而不再静默改写为平台版本，Skill 运行时依赖工具同样按锁定引用校验；`skillVersionPublished` 私有重复逻辑随之删除。包内能力 id 唯一性在 `consumeDeclared` 显式校验：tool.yaml 的 `id` 可与目录名不同，两个目录声明同一 id 由“Map 静默覆盖”改为明确拒绝。发布检查 `manifest` 项补齐 `AGENT_ID_PATTERN`、`VERSION_PATTERN`（x.y.z）与系统提示词 ≥20 字符校验并给出首个失败原因，常量自包解析器导出复用，与配置入口口径一致。验证：`agent-package.test.ts` 35/35、`agent-release-governance.integration.test.ts` 17/17（专用可丢弃 PostgreSQL）、`pnpm typecheck`、`pnpm verify`、`pnpm check:architecture`、改动文件 eslint、`git diff --check` 均通过；未跑浏览器 E2E 与真实 DSH/OIDC 验收。

**改动位置：** [包解析器](../../server/src/modules/agent/agent-package.ts) 与新增[解析单测](../../server/src/modules/agent/agent-package.test.ts)、[发布服务](../../server/src/modules/agent/postgres-agent-release-service.ts)（生成案例来源标记）、[发布集成测试](../../server/src/infrastructure/postgres/agent-release-governance.integration.test.ts)、[领域类型](../../apps/admin-web/src/types/domain.ts)、[发布工作台](../../apps/admin-web/src/views/AgentReleaseWorkbenchView.vue)（生成案例来源提示）、根与服务端 `package.json`（`test:agent-package` 接入 ci:check）。

1. B-01 定义唯一清单格式、规范字段、显式默认值和长度/类型限制；未知字段、旧别名、未支持格式及受管身份/凭据/端点声明直接拒绝，不保留警告后忽略或双格式解析。原基线已实现的依赖和安全拒绝规则继续复用。
2. 将包内同名依赖的显式版本冲突从“警告并覆盖”改为清楚的失败；同时检查别名字段并存冲突、重复依赖及未解析引用。报告具体字段、声明版本与包内版本，供管理员修正。
3. 保持 Prompt 内联/文件两种现有方式；区分“可解析”“候选检查通过”“可发布”。无案例可生成默认案例，但展示其来源并要求补充实际预期；ZIP 缺摘要仍按当前发布门禁处理。
4. 以最终唯一格式提供有效包、依赖冲突、安全字段误用及不支持格式/字段的拒绝样本，同步管理 API 和导入反馈。格式由 B-01 确定，不要求旧包继续导入；不把 apiVersion/spec 草案误报为当前已实现。

**新决策完成标准：** 只接受选定格式；未知字段和冲突在入库/发布前被拒绝，不因重名替换依赖；同来源版本异内容仍拒绝。新契约解析单测、发布集成及导入旅程通过，不要求旧包兼容用例通过。

### I-03 落实配置和 ZIP 共用的规范化定义

**改动位置：** `server/src/modules/agent/`、[运行准备](../../server/src/modules/run/run-orchestration-service.ts)、[模型治理](../../server/src/modules/model/model-governance-service.ts)、Runtime 类型/编译器、管理 API 与 [Agent 编辑组件](../../apps/admin-web/src/components/AgentDraftDialog.vue)。新定义类型/Schema 的名称与路径在实现时确定。

1. 建立平台内部规范化定义及校验入口，让配置创建和 ZIP 导入映射到同一种内容结构；分别保存可变目录信息、不可变定义及内容摘要，避免不同入口采用不同默认值。
2. 增加版本化的输入要求与输出要求：支持的数据类型、必要参数/文件、结果形式及成果要求；自由文本 Agent 可继承平台默认契约。缺失输入应在 Run 准备阶段反馈；结构不合法的输出不能仅凭成功终态宣称符合契约。
3. 定义上下文策略：允许来源、历史范围和大小、Skill 按需加载、知识/文件引用及来源失效处理。解析后的策略和版本进入执行快照；历史资料始终重新按当前权限使用。
4. 定义模型/Runtime **能力要求**及兼容判断；模型路由继续由平台选择。无兼容路由/Runtime 时拒绝准备，不从包读取 Provider 凭据，也不建立备用模型循环。新契约发布时将解析后的默认值固定进版本，不为旧定义补默认值或保留旧路由分支。
5. 同步持久化、公开契约与管理端只读展示；新字段改变执行语义时推进候选修订，使旧验证证据失效。按新结构同步切换创建、发布和运行消费者，不做历史定义转换；新发布版本保持不可变。

**完成标准：** 相同配置和 ZIP 生成等价规范化定义；无效输入、来源撤回和能力不兼容均有明确拒绝；修改执行字段后必须重新验证。使用新契约 Agent 完成配置→发布→运行回归。

**B-01 原实施记录（2026-09-20；原 v1 指令路径已由 AE-01 替换，模型准入的后续进展见下文）：**

- **唯一包格式与严格 Schema：** [agent-package.ts](../../server/src/modules/agent/agent-package.ts) 只接受 `apiVersion/kind/metadata/spec` 分层清单，由 [agent-package.schema.ts](../../server/src/modules/agent/agent-package.schema.ts) 与 [agent-package.schema.json](agent-package.schema.json)（Ajv 2020，`additionalProperties: false`，TS 常量导出保证零漂移）校验；旧扁平清单、全部字段别名、未知字段、重复 YAML 键、锚点别名及平台受管字段（凭据/端点/模型路由/执行环境/绑定/授权/调度/安装钩子等保留关键字）直接 422 拒绝。
- **规范化 AgentSpec：** 新增 [agent-spec.ts](../../server/src/modules/agent/agent-spec.ts) 定义 `AgentSpec`（metadata、instructions 文件引用+正文、capabilities 精确引用、input/output/context、catalog、limits、evaluation、model.requirements）；`agentSpecFromConfiguration` 将配置表单归一化为 `prompts/system.md` 文件表示，与 ZIP 解析结果同构。
- **持久化：** 迁移 `0046_agent_spec_definition.sql` 将 `agent_versions.max_tokens` 更换为 `max_output_bytes` + `max_tool_calls` 并新增 `agent_spec jsonb`；配置创建/草稿更新/版本分叉与 ZIP 导入四条版本写入路径均固化展开后的 spec；既有行按平台默认值补齐、不回填（不考虑历史兼容）。`timeout_seconds` 语义不变。
- **依赖与运行时：** 依赖仅接受 `id@x.y.z` 精确引用，声明版本与包内候选版本不一致、同 id 多版本均拒绝；运行编排按 `max_output_bytes`/`max_tool_calls` 映射 Attempt 限额，平台策略上限不变。模型能力要求仅声明与校验，路由/凭据仍平台管理，执行侧消费待 B-02/B-03。
- **消费端：** 领域类型、Admin 管理端（domain 类型、AgentDraftDialog、管理视图、发布工作台）、OpenAPI 文档及全部测试夹具切换为 `maxOutputBytes`/`maxToolCalls`。
- **验证：** `agent-package.test.ts` 67/67（重写为新格式套件：严格 Schema、平台字段拒绝、精确依赖、包内候选版本匹配、checksums）；发布治理集成 17/17（专用可丢弃 PostgreSQL）；server + workbench-web + admin-web `tsc --noEmit` 通过；集成夹具原生 INSERT 同步更名。
- **未覆盖：** 浏览器 E2E、真实 DSH/OIDC 验收未运行；`model.requirements` 无运行时消费方；既有 `agent_spec` 为 null 的旧版本行不回填，运行时快照仍由列字段驱动。

**I-03 模型能力准入补齐（2026-09-20，本轮）：**

- 版本快照读取 `agent_spec.model.requirements`；员工运行、自动任务与发布试运行先校验默认路由的全部能力标签，再通过 Runtime 端口核对实际执行目标与能力。目录不满足返回 `MODEL_CAPABILITY_MISMATCH`；Runtime 无法保证返回 `MODEL_CAPABILITY_UNAVAILABLE`，不创建 Attempt，无 Attempt 的 Run 收敛为 failed。
- Attempt 固定 `model_requirements` 与路由 `modelCapabilities`。恢复队列使用固定目标复核当前 Runtime；不兼容时终止 Attempt 并记录错误码。DSH Adapter 直接执行也拒绝未支持要求，避免绕过编排门禁。
- 当前 DSH 使用固定 Profile，未提供可保证的长上下文容量或结构化输出约束，因此两项非空要求均不放行。受控测试 Runtime 的正例仅证明准入及快照接线；真正支持仍需定义容量/输出约束、接通目标模型并完成真实验收。
- 普通文本 Agent 的空要求继续运行；不回填历史定义、不自动切换模型、不增加模型循环。验证与未覆盖范围见第 5 节。

### I-04 落地真实绑定修订与发布追溯

**改动位置：** [工具/连接器服务](../../server/src/modules/tool/postgres-tool-connector-service.ts)、Agent/发布服务、[Run 仓储](../../server/src/modules/run/postgres-run-repository.ts)、[数据库迁移目录](../../server/migrations/)、管理端发布工作台及版本详情。

1. 确定真实绑定的持久化结构：能力版本、批准执行器/连接、凭据引用、身份解析策略、环境、授权上限、修订和内容摘要。Tool 模块维护工具绑定；Agent 发布引用它，不复制端点和密钥配置。
2. 将 `buildPlan` 的固定 `binding-rev-3` 替换为服务端解析出的真实记录；计划明确新增、复用、变化和不兼容项。候选检查、试运行和发布证据绑定同一组修订与摘要。
3. 绑定语义变化创建新修订和新平台发布版本；在发布事务内再次比较候选、绑定及验证依据，阻止并发变更复用旧证据。凭据等价轮换与身份/授权变化分别处理。
4. 新契约下 Attempt 固定实际绑定引用及解析证据，执行时另查当前权限和撤销状态。Session/自动任务不静默改用其他发布版本；绑定不可用时明确失败。这是新系统版本治理要求，不要求继续运行旧格式任务。
5. 直接实现新绑定结构和引用完整性校验，不还原旧绑定或回填历史发布记录。新发布的每项绑定都须有真实依据，缺失则拒绝发布/执行，不能伪造摘要。

**完成标准：** 同定义在两个批准环境可独立发布；换端点/身份后旧证据不能放行；并发改绑定时发布安全失败；历史运行可查原依据，撤权仍即时受执行边界约束。通过新结构引用完整性、发布并发、新契约内回滚和权限集成验证。

**B-03 实施记录（2026-09-20）：**

- **持久化结构：** 迁移 [0047](../../server/migrations/0047_tool_binding_revisions.sql) 新增 `tool_binding_revisions`（租户作用域 id、tool_id/tool_version、revision、connector/executor/endpoint/credential_ref 槽位、identity_policy、environment、allowed_role_ids、data_scopes、approval_policy、content_digest、status ∈ active/superseded/revoked、created_by/at；`(tenant_id, tool_id, revision)` 唯一 + active 索引），并在 `agent_versions`、`agent_release_submissions` 增加 `binding_refs` JSON 列。历史行不回填：首次服务级解析按当前真实配置物化初始修订。
- **语义摘要：** [domain/tool-binding.ts](../../server/src/domain/tool-binding.ts) `toolBindingDigest` 对规范化快照（角色/数据范围排序）取 SHA-256；凭据槽位**标识**入摘要、密钥值从不进入——槽位切换产生新修订，密钥值等价轮换不产生。`DSH_WORK_EXECUTION_TOOL_REFS`（`activate_skill@1.0.0`、`python_execute@1.0.0`）为共享常量，dsh-work 内置执行工具不进绑定表；平台工具按 Run purpose 注入，MCP 外部工具按 Connector 整体治理。普通工具列表及绑定视图只展示 DSH 内置工具。
- **生命周期：** `resolveToolBindings` 在 tools 行锁下物化/轮换（语义漂移 → 旧行 superseded + 新 revision，修订号按工具全局单调）；`setToolStatus` 停用即撤销、启用按当前配置物化新修订；`updateToolPermissions`/`addTool` 同事务维护修订；`assertActiveToolBindings` 复核固定 pin 的 binding_id/tool@version/revision/digest/status=active，并**重算当前真实配置摘要**比对，撤销/取代/漂移/行缺失/错配均按 `permission_denied` 拒绝。
- **Manifest 固定：** `RuntimeManifest.tool_bindings`（`tool`/`binding_id`/`revision`/`digest` 四字段 pin）在 Schema 与编译器双侧校验——未声明字段、非法 `id@version`、重复固定、空 binding_id、非正整数 revision、非小写 sha256 摘要均拒绝；`tools[]`（DSH 运行时名）与 `tool_bindings`（平台引用）为独立命名空间，互不交叉校验。员工会话与发布试运行派发时 `getRuntimeSnapshot` 解析真实修订并写入 Attempt Manifest。
- **执行复核：** `assertCurrentExecutionAuthorization` 在 purpose 分流前统一复核 pin（试运行/管理/员工同口径），`recheckExecutionAuthorization`（领取后、进 Runtime 前）与桥接 `authorizeExecution` 路径同享该门禁；声明 pin 而端口未接线时 fail-closed 为不可用。
- **发布治理：** `runChecks`/`buildPlan` 经 `resolveDraftBindings` 生成真实 `binding` 检查与计划项（与封存依据比较区分 create/reuse/upgrade，解析失败为 blocked）；`startTrial` 将 pin 封存为 `binding_refs`；`executeTrialSteps`/`submitForReview`/`publish` 经 `assertSealedBindings` 复核封存依据（声明平台工具而无依据的历史候选 fail-closed，语义漂移/撤销拒绝）；`binding_refs` 随 `publishDraftWithinTransaction` 的状态翻转同一条 UPDATE 固化（不触碰已发布版本不变约束），并写入版本证据（`平台绑定修订固定` 项含修订号与摘要前缀）。
- **管理端：** `GET /tools/bindings` 仅返回 DSH 内置工具修订（不含密钥值）；`toolGovernance` 的绑定列与治理详情改用服务端记录，旧的内存工具候选与 `candidate-bind-*` 原型已删除。`agentGovernance` 版本绑定徽标由 `agent_versions.binding_refs`/候选 `bindingRefs` 推导，`binding-rev-3` 等伪造占位全部移除。
- **验证：** `tool-binding.integration.test.ts` 6/6（物化/复用、漂移轮换+取代、pin 错配/撤销拒绝、内生工具排除、凭据槽位语义）；`agent-release-governance.integration.test.ts` 20/20（含封存 pin→Attempt manifest 一致性、漂移拒绝发布、重新封存后发布、版本 `bindingRefs` 追溯）；`current-execution-authorization.test.ts` 8/8（含 pin 门禁 fail-closed）；`runtime-manifest-schema.test.ts` 11/11（含双边界 pin 校验）；`test:runtime` 61/61、`m3` 12/12、`m4:authorization` 4/4、`m4:tool` 1/1、`m5-revocation` 29/29、team/automation 集成 42/42、admin-skill-installation 11/11、`admin-web` 87/87、`tsc --noEmit`、eslint、`pnpm verify` 通过。
- **未覆盖：** 多批准环境（`environment` 字段当前固定 `default`，独立发布未验证）；并发绑定变更的竞态发布为事务内复核而非专用并发用例；真实 DSH/OIDC 与浏览器 E2E 未运行；`m4-runtime-operations` 存在 B-03 之前的既有失败（团队 @Agent 成员门禁，与本项无关）。

### I-05 统一工具输入输出、错误与效果语义

**改动位置：** [工具目录](../../server/src/modules/tool/dsh-built-in-tool-catalog.ts)、工具服务、[平台工具桥](../../server/src/modules/runtime/platform-tool-bridge.ts)、[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)；归入 EX-01。

1. 盘点当前批准工具，统一适配新契约，不并存两套输入输出协议：精确版本、输入/输出 Schema、动作性质、资源范围、超时/取消、审批、重试及并发要求。目录、模型可见描述、实际校验和结果投影使用同一版本；对仍不具备结构化输出的工具明确能力边界，不填空 Schema 后宣称完整校验。
2. 在调用前验证输入并由服务端注入身份/资源范围；调用后校验输出结构、大小和成果引用。保持实际调用边界的当前授权，不把模型参数作为授权依据。
3. 定义并映射无权限、参数错误、冲突、暂时不可用、超时、取消和结果未知；移除将不同失败统一描述为“包解析失败”的通用工具路径。错误中的可重试标记不自动触发重试。
4. 首先用已有文件读取/生成工具贯通契约与结果投影。为未来外部写操作定义操作键、受理回执、状态查询和并发前置条件；只有接入该动作时才实现相应业务操作记录与核对程序，不给所有只读工具强加事务台账。

**完成标准：** 已有样例工具从目录到真实调用使用一致契约；非法输出、无权限、超时和成果登记失败可区分。新增外部写动作前另验证同键不重复、跨 Attempt 保持同一业务操作身份、超时先核对效果，不能仅用 Run 幂等证明安全。

**实施记录（2026-09-20）：**

- 新增 `PlatformToolContract` 与固定平台工具契约目录；输入/输出 Schema 以 Ajv 2020 strict 模式预编译。桥接调用在处理器前校验输入并复核当前授权，处理器后再次复核授权、校验输出结构及 UTF-8 序列化字节；Attempt 取消会终止调用。
- 契约声明 `effect`、`retryPolicy`、`concurrencyPolicy`、`completionSemantics`、超时及最大输出字节。`serialized` 工具的同名重叠调用在第二个处理器启动前返回 `TOOL_CONFLICT`；并发只读工具保持可并发。
- 稳定错误外层区分参数/输出无效、前置条件失败、无权限、调用上限、冲突、暂时不可用、取消、只读超时、写入结果未知和普通执行失败，并携带 `retryable`、`effect_state`。管理操作与 Skill/Python 执行前校验使用有类型错误，避免将尚未开始的写入误报为结果未知。DSH 包装器只接受 2xx，并将稳定错误语义投影到 DSH 会保留的 `Error.message`，不再把错误正文作为成功文本。
- `python_execute` 按 Runner 允许的 stdout/stderr 上限和 JSON 最坏转义开销使用 16 MiB 输出字节预算，artifact 名称同步限长；Schema 合法的边界输出不再被二次字节限制拒绝。
- Runtime 工具目录格式升级为 v2；Tool Version 新增输出验证、重试、并发和完成语义并通过迁移持久化。DSH 原生工具当前没有平台可执行的结构化输出验证，因而明确写入 `outputValidation=unavailable` 和标记 Schema；已有非 DSH 工具的输出 Schema 不被迁移覆盖。管理端工具详情和目录展示这些边界。
- **保留边界：** 当前工具均声明 `completed`。没有接入真实外部异步写操作，因此业务操作键、`accepted` 回执、状态查询及跨 Attempt 效果核对仍是新增该类能力的前置条件；本次不虚构通用事务台账。任务级结果与成果登记失败的统一投影由 I-06 实现。
- **验证：** Runtime 71/71（含平台桥 7 项及 DSH 政策 9 项）、工具治理 PostgreSQL 集成 1/1（专用可丢弃数据库）、管理端 17 文件 92 项、全仓 typecheck、lint、`pnpm verify`、`git diff --check` 通过。未执行浏览器 E2E、真实 DSH/OIDC/P2。

### I-06 增加可核验的任务结果外层

**实施记录（2026-09-20）：** 已实施版本化读时投影 `task-result/v1`，不建第二份状态机与结果表——

- **契约与判据：** [task-result.ts](../../server/src/domain/task-result.ts) 的 `deriveTaskResult` 纯函数由持久化权威证据确定性推导：当前 Attempt `run_events` 的 `safe_metadata`、已提交回答消息、**当前 Attempt** 已登记成果数、工具审计、知识来源与 Runtime 错误码。`execution` 保留 Run 终态原值；`outcome` 为 `pending`/`achieved`/`unverified`/`not_achieved`；`receipts` 覆盖 answer/artifact/tool × completed/accepted/rejected/failed/missing；`pendingItems` 列出 `answer_uncommitted`、`artifact_registration_gap`、`no_deliverable`、`no_verified_deliverable`、`output_truncated`、`output_interrupted` 等缺口。非终态 → `pending`；failed/cancelled → `not_achieved`（附错误）；succeeded 且当前 Attempt 至少登记一个成果版本或已完成工具动作回执、其余证据无缺口 → `achieved`；任一证据缺口（含仅登记回答内容）→ `unverified`。模型自述仅作 `primaryOutput` 说明，不构成核验依据；`accepted` 用于工具审批记录（`parameter_summary.decision` 非空的审计行在执行前写入，获准≠完成）与预留的异步外部写受理回执，不计入完成。
- **装配与 API：** `PostgresConversationRepository.mapTask` 统一挂 `task.result`（sources/artifacts/error 移入结果外层）；`GET /api/workbench/v1/runs/{runId}/result` 复用 Run 详情同一行定位、Workbench 授权与团队读门禁，不可访问一律 404，只读不触发执行；自动任务执行列表增 `resultOutcome` 字段，经同一投影推导，无 Run 时为 `null`，受理不视为达成。
- **前端与契约：** ConversationView 消费 `task.result.*`；身份行与「对话详情 → 结果核验」区分列展示业务 outcome、回执、待处理项与遥测证据；`unverified` 显示警示且不出现「目标已达成」。AutomationsView 执行记录分列受理/执行/业务结果。StatusTag 增加 outcome 与回执状态标签。[openapi-workbench.json](openapi-workbench.json) 新增结果路径与 `TaskResult` 系列 schema；Prototype 夹具提供四种 outcome 样例。
- **验证：** `deriveTaskResult` 单测 12/12；PostgreSQL 集成——m3 编排 22/22（含不可变成果版本回执、声明成果未登记 → `unverified`、失败 Run → `not_achieved`）、自动化 13/13（受理≠达成、`resultOutcome` 投影）、团队讨论收权 7/7（`/result` 与详情同一 404 边界）、api-contract 15/15；前端 344/344（含 unverified 不显示「目标已达成」）；P1 浏览器旅程 [task-result.spec.ts](../../e2e/personal-integration/task-result.spec.ts) 3/3（专用可丢弃 PostgreSQL + 合成 Runtime）。**未执行真实 DSH/OIDC/P2**；外部异步写操作的 `accepted` 回执核对仍随具体能力接入。

**改动位置：** Run 类型/仓储/事件投影、[内容服务](../../server/src/modules/workbench/application/postgres-content-service.ts)、[对话 API](../../server/src/http/workbench/conversation-routes.ts)、[Workbench OpenAPI](openapi-workbench.json)、[对话页面](../../apps/workbench-web/src/views/ConversationView.vue)及自动任务结果入口。

1. 在现有 Run 结果上增加版本化结果投影，分别表达执行状态、目标达成情况、主要结果、来源、已完成动作/回执、待处理事项、错误和 Artifact 引用。最终字段和状态枚举先通过接口设计确定，不复制第二份 Run 状态机。
2. 为文本回答、文件生成和工具操作分别定义验证依据；模型自述作为说明，不能直接设置“已验证完成”。未配置业务判据的文本任务允许显示执行结束及未验证状态，不能强迫模型给出虚假确定结论。
3. 结果提交与必要消息/成果登记明确成功顺序和幂等键；失败经现有错误通道可见。Run 成功后的读取失败只影响结果读取，不发起新的 DSH 执行，也不覆盖终态。
4. API、事件消费者和前端统一切换到新结果契约，不增加旧 Run 兼容展示或历史结果回填。前端使用既有组件展示结果、回执和待处理事项，动作提交重新鉴权。

**完成标准：** 模型说完成但必要成果缺失时不显示目标已达成；外部操作仅受理时不显示已完成；重复事件不重复登记结果；未授权用户看不到正文/成果。按照 Spec → Code → Verify → Test → Green 固化员工对话及自动任务结果旅程。

### I-07 核实并补齐预算执行

**实施记录（B-02b，2026-09-20）：** 限额执行矩阵已逐项核实——

| 限额 | 单位/作用域 | 计数/执行位置 | 超限行为 |
| --- | --- | --- | --- |
| Worker 启动超时 | 毫秒，spawn + initialize + session/new | `DshAcpRuntimeAdapter.armDeadline('setup')` | 停止 Worker → `RUN_TIMEOUT`（`timeout_phase=setup`，无 `run.started`） |
| 执行超时 | 秒，`timeout_seconds`，覆盖 prompt 到成果收集全程 | `armDeadline('execution')` | 取消 ACP 会话 + abort 平台桥 + 宽限后强制关闭 → `RUN_TIMEOUT`；已产文本经 `commitInterruptedOutput` 带中断标记提交 |
| 工具调用次数 | 次，单 Attempt | DSH 政策 `tools/pre-execute` 的 `++calls` 覆盖经 `ctx.tools.register` 注册的平台工具与内置工具；平台桥 `++count` 仅计 `/tools/*` socket 调用，同一上限 | 政策 `deny`「已达上限」；桥 403 |
| 输出字节 | UTF-8 字节，单 Attempt | Adapter `onSessionUpdate` 按 `Buffer.byteLength` 截断，多字节字符不拆半 | 截断/丢弃后续分块，`assistant.completed`、`run.completed` 与 `run.failed` 标记 `output_truncated` |
| 输入文件挂载 | ≤5 个、合计 ≤1 MB、只读、`/workspace/input/` | `compileRuntimeManifest` | 编译拒绝 |
| Skill 资源 | ≤64 文件、单 Skill ≤1 MB | `compileRuntimeManifest` + 工件存储 stat 预检 | 编译/加载拒绝 |
| 工具参数体 | ≤64 KB | 平台桥 `readBody` | 422 拒绝 |
| 写入目标 | 仅 `output/`、`.md/.txt/.csv`、realpath 越界拒绝 | DSH 政策 `validateExecution` | deny |
| Runtime 并发 | Worker 数/Runtime | `claimAttempt` 行锁下 `running`+`cancel_requested` 对比 `capacity` | 领取失败保持 queued |
| 自动任务车道 | `min(配置上限, capacity−1)` | `claimAttempt` 车道选项 | 为交互任务保留 1 个 Worker |

**核查结论：** 未发现混用计数绕过——平台工具注册为 DSH 标准工具、经同一 `pre-execute` 管道计数（该前提由锁定的 ACP profile 工具注册契约保证，未做 DSH 内部动态验证；桥侧同上限第二道闸保证平台调用本身不超上限）；无超限后继续执行路径——政策在计数处 `deny`、Adapter 丢弃超字节分块、超时取消会话并强制关闭；无取消中提前释放容量——`cancel_requested` 计入容量直至终态转移；授权探测 `/authorize-execution` 在计数前分流、不消耗工具预算；两处 `++` 递增均同步发生在首个 `await` 之前，无并发越过上限窗口。Allow-list 拒绝的调用不计数（未通过校验不算 Agent 已消耗动作），通过校验后被授权拒绝的调用消耗预算（偏保守，与设计一致）。

**实证修复：** 输出字节截断此前完全静默——超限分块被丢弃后，`run.completed` 与持久化回答无法区分「截断」与「完整」。现 `ExecutionRecord.outputTruncated` 在截断或丢弃分块时置位，随 `assistant.completed`（含超时/关停中断提交路径）、`run.completed` 与 `run.failed` 的 `safe_metadata` 暴露 `output_truncated: true`；未截断时不输出该字段。边界测试：mock Worker 连发 1000 B + 以多字节字符压界的 103 B + 已超限的 50 B 分块，`max_output_bytes=1024` 断言恰收 1024 字节、第二个 `assistant.delta` 恰为压界后的 24 字节且「界」码点完整、第三分块被丢弃、`assistant.completed`/`run.completed` 双事件带标记；既有完整路径断言无 `output_truncated` 字段。验证：`test:runtime` 60/60、typecheck、eslint、`pnpm verify` 通过。

**仍为扩展项：** 累计 Token/成本、跨 Attempt 总预算与无进展检测未实施（本项第 4 条）；模型能力准入已由 I-03 本轮补齐，真实高级能力支持仍未启用。

**改动位置：** Manifest limits、编排与 Scheduler、Adapter/平台工具桥、[DSH 工具政策](../../server/config/dsh/dsh-work-tool-policy.js)、模型用量及相关 UI 说明。

1. 制作限额执行矩阵，逐项标明单位、作用域、计数位置和超限行为：启动/执行时长、内置与平台工具次数、收集文本字节、文件/沙箱限制及并发。区分“截断输出”“拒绝动作”“停止 Worker”和“仅记录用量”。
2. 检查并修复混用内置工具与平台桥时的计数绕过、超限后继续执行、取消中提前释放容量等实际缺口；只有证据证明的问题进入修复，不预设所有路径有缺陷。
3. 为新配置直接定义准确的名称、单位与作用域：输出字节使用明确字节上限，不将 `maxTokens * 4` 估算当作 Token/成本硬限制；不保留旧预算字段转换。新系统内收紧或改变授权上限仍进入候选/任务配置确认及 Manifest 冻结流程。
4. 累计 Token/成本、跨 Attempt 总预算及无进展检测另作为扩展：先验证 DSH 能否提供可靠计量与拦截点，再实现持久化计数、并发预占/结算和取消。能力不足时显示不支持，不由业务后端循环调用模型补齐。

**完成标准：** 已声明的限额在恰好到达和超出边界时均有行为证据；自动任务占满配额时交互任务仍可运行；输出截断不被展示成模型消耗上限。基础限额修复不依赖累计硬预算上线。

### I-08 补齐评测、当前授权与分层验收

**改动位置：** 发布案例与版本证据、现有 Runtime/授权/故障/自动任务测试、[E2E 目录](../../e2e/TEST-CATALOG.md)及发布验收记录；复用现有测试入口。

1. 将评测分为平台通用约束和 Agent 专属目标：平台覆盖权限、取消、恢复与限额；Agent 提供正常、无效输入、越权/注入、结果质量和能力特有失败案例。记录案例版本、自动断言/人工判定、实际结果及证据，不要求每个包复制平台测试。
2. 针对当前链路运行并补缺：个人/团队成员收权、账号停用、文件来源移除、固定能力撤销、授权服务故障；覆盖受理、排队领取、活动工具调用、成果提交和结果读取。以实际工具调用/写入是否被阻止作断言；仅检查 Prompt 或工具隐藏不算通过。
3. 核对 Worker 崩溃、旧 Attempt 迟到事件、取消与领取竞态、锁释放、准备中断、队列恢复及限额；修复本批代码引起的失败。自动任务继续遵守不补跑、不自动重试、不续办中断准备。
4. 自动任务 AC-20～24 的 P1 第一批已固化到 `e2e/automation.integration.spec.ts`：使用专用可丢弃 PostgreSQL、独立身份上下文和受控 Runtime，进程结束时销毁测试库；保留已有 P0 冒烟。当前覆盖同键去重/准备中断、遗漏展示/失败不重试、账号停用/越权读取、固定版本/暂停和交互容量；日历细节、事务/领取竞态仍由服务测试覆盖。其余团队/文件/能力撤权与故障注入继续按第 2、3 条补齐。
5. 为每个拟发布能力单独记录真实 DSH Lock/Adapter/模型、真实身份和批准工具的 P2 结果，覆盖多账号收权、结果/成果和故障。绑定、定义或关键依赖变化时，按影响失效并重做相关证据；缺少目标环境时标记未验收，不用替身填通过。

**完成标准：** 对每条门槛能找到对应测试或人工验收结果，注明环境、版本、运行时间和失败/未覆盖项；用例存在、P1 通过与 P2 通过分别报告。此项为 B-01～04 提供持续回归门禁；取消历史格式兼容、旧数据回填及跨旧格式迁移测试，保留新契约内的版本固定、收权、并发、取消、故障及真实执行验证。

**当前验收矩阵（2026-09-21）：**

| 层级 | 证据入口 | 当前状态 | 尚缺 |
| --- | --- | --- | --- |
| 平台通用约束 | Runtime、授权、故障、包格式、自动任务服务单元/集成套件 | 阶段矩阵见下表；受理、领取、活动执行、成果提交与结果读取已有代码级证据 | 真实身份、目标 DSH 和批准工具留待 P2 |
| Agent 专属目标 | 发布治理的 `AgentEvaluationSuite v1` 与[模板](agent-evaluation-template.yaml) | 五类案例、契约版本、机器断言、Run/Attempt/输出证据及人工 rubric 已接入发布链路 | 平台生成案例仅作起点；每个拟发布 Agent 仍需补真实目标输入、能力特有失败和 P2 结果 |
| P0 浏览器 | `e2e/automation-smoke.spec.ts` | 已实现，验证入口与表单反馈 | 不证明 PostgreSQL、Runtime、OIDC 或 DSH |
| P1 浏览器 | `e2e/automation.integration.spec.ts` | 第一批 5/5 通过；一次性 PostgreSQL + 合成 Runtime/身份 | 继续补第 2、3 条未覆盖的阶段化安全/故障场景 |
| P2 真实验收 | 手工验收记录；自动化路径预留为 `e2e/automation.acceptance.spec.ts` | 此前仅有口头完成结论，无可归档原始记录；自动化 spec 未创建 | 在当前目标版本重新执行真实 DSH Lock/Adapter/模型、OIDC、多账号、批准工具、目标环境容量/故障场景并留验收结论 |

**平台当前授权与故障阶段矩阵（代码级/P1，非 P2）：**

| 对象或故障 | 受理/排队 | 领取后、Runtime 前 | 活动 Worker/工具 | 成果提交 | 结果读取 | 结论与下一缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| 个人账号停用 | `automation.integration.test.ts` 验证触发跳过且不移动游标；自动任务 P1 验证受理拒绝 | `review-a2.integration.test.ts` 验证领取后停用不进入 Runtime | `runtime-adapter.test.ts` 用当前授权门禁验证活动 Worker 停止 | 同一 Adapter 门禁在完成提交前复核 | `team-workspace-discussion-api.integration.test.ts` 验证停用账号读取已知 Run 结果返回 403/`permission_denied` | 代码级闭环；真实 OIDC 会话待 P2 |
| 团队成员移除 | 会话/API 检查成员身份；`m5-revocation-pipeline.integration.test.ts` 清扫 queued/running Run | m5 执行前复核验证不调用 Runtime | m5 清扫取消运行中任务；Adapter 负责停止 Worker | `review-a2.integration.test.ts` 在成果扫描与数据库事务之间移除成员，验证事务拒绝且无 Artifact 版本 | `team-workspace-discussion-api.integration.test.ts` 验证已知 Run 详情与结果均 404 | 代码级闭环；真实 OIDC 多账号仍待 P2 |
| 输入文件移除 | `current-execution-authorization.test.ts` 验证缺失/移除输入 fail-closed | `review-a2.integration.test.ts` 使用真实内容服务验证领取后移除不进入 Runtime | 同一集成套件使用合成 ACP Worker 验证活动期移除后 Worker 停止并以 `AUTHORIZATION_REVOKED` 收敛 | 活动期对象特定用例断言无 `assistant.completed`/`run.completed`；Adapter 另有提交前通用门禁 | 已提交结果保留不可变证据；原输入文件读取继续按文件授权，不因结果存在恢复访问 | 代码级闭环；真实 DSH 与文件存储待 P2 |
| 固定 Agent/工具绑定撤销 | Agent/Tool 发布与运行准备校验固定版本/修订 | `review-a2.integration.test.ts` 验证 Agent 停用及真实工具绑定撤销均不进入 Runtime | `platform-tool-bridge.test.ts` 验证工具执行前后复核及 403 撤权；Adapter 验证活动执行撤权停止 | Adapter 提交前门禁阻止完成事件 | 撤权阻止后续执行，不隐藏有权用户对既有不可变结果的读取 | 代码级闭环；真实批准工具仍待 P2 |
| 授权服务故障 | `automation.integration.test.ts` 验证不写成 skipped、游标不动且恢复后可重试 | `review-a2.integration.test.ts` 验证 503 类故障记为 `AUTHORIZATION_CHECK_UNAVAILABLE`，不伪装撤权 | Adapter 停止 Worker并保留故障分类；平台桥读操作执行前返回可重试 503 | Adapter 阻止完成提交；平台桥写操作执行后返回效果未知、不可自动重试 | HTTP 集成验证授权故障返回 500/`operation_failed`，不伪装为 404 | 代码级边界已固定；目标环境故障注入待 P2 |

固定能力撤销后的既有结果读取、输入文件移除后的结果证据保留是设计行为，不应把能力或来源重新授予给读取者。上述活动期文件用例使用仓库内合成 ACP Worker，证明 Adapter 与 PostgreSQL 授权组合行为，仍不等同于目标 DSH 部署的 P2 证据。

### I-09 按需接入外部能力与 MCP

**状态与归属：** PF-03 代码级平台能力已完成；具体 Agent 仍须满足生命周期模板触发条件。健康且同步成功的 Connector 默认对租户内全部 Agent 开放，不提供 Agent 级授权。不预设同时支持 REST、MCP 和所有沙箱执行器。

**已实施契约：** 管理员在现有 Connector 模块登记 Streamable HTTP MCP Server，直接输入可选 Bearer Token；平台生成内部标识与命名空间，Token 加密入库且不回显。发现完整 Tool 清单并固定整体摘要，成功发现后能力快照自动生效，并默认对租户内全部 Agent 开放。不提供 Agent 或逐 Tool 权限，也不创建平台 Tool Version/Binding。调用经 Runtime Manifest 当前复核和 DSH Server 命名空间策略执行，实际 Tool 调用单独记录参数摘要及结果。清单变化在成功检查后自动更新生效摘要；Resources/Prompts 不因 Tools 接通而开放。

**评审修复：** Connector 详情展示每项 Tool 的名称、描述及输入 Schema；策略与审计按 Attempt 已配置的 serverName 命名空间解析包含双下划线的合法 Tool 名称。发现和清单自动同步均保留人工停用状态；只有健康且能力摘要已同步生效的 Connector 会进入 Agent 的新 Attempt，离线、降级、停用或删除后不再解析并阻止在途调用。

**改动范围与依赖：** Connector、应用层加密凭据存储、Runtime Manifest/Adapter、DSH 工具策略、管理 API/UI 和调用审计。平台 Tool 继续使用 I-04/I-05；MCP Connector 不复用其逐 Tool 版本与 Binding。禁止包内命令启动任意 MCP 进程。

**完成标准：** 代码级门禁已覆盖新增能力自动对全部 Agent 生效、Server 命名空间隔离、摘要变化自动同步与旧 Attempt 拒绝、错误服务/凭据、停用/删除和逐调用审计。真实批准服务的发现→自动生效→调用→停用/删除链路及超时/取消在 PF-07 P2 完成；其他传输和 MCP Resources/Prompts 明确显示未支持。

### I-10 按需增加持久化等待、人工审批与恢复

**状态与归属：** PF-04 代码级平台能力和管理端审批入口已完成。具体 Agent 仍须由生命周期模板触发逐次审批或长流程，不为所有 Agent 默认启用。

**已实施契约：** `waiting` 对 Run 是可恢复状态，对来源 Attempt 是不可回退终态。`run_checkpoints` 固定来源 Attempt、Manifest 摘要、Runtime 版本、恢复策略、关联键、有效期和有界恢复上下文；上下文固定精确待执行参数、此前已完成工具结果、输出工作文件和未提交部分回答，并由独立摘要校验。`run_approval_requests` 固定动作、参数摘要、资源、执行身份、数据版本、决定幂等键与恢复 Attempt。等待关闭当前 Worker。DSH 没有安全恢复原 ACP Session 的接口，因此批准后从检查点创建新 Attempt，在 Manifest `resume` 中携带已校验上下文，Runtime 先恢复工作文件再建立新 Session；新 Attempt 仍经既有 Run/Attempt → Runtime Adapter → DSH 执行。

**门禁与终态：** DSH 仅携带工具调用 ID 时，原始参数来自策略层在询问前写入的可信日志并校验摘要；无需审批的调用直接按策略放行，不捕获或校验持久化检查点。审批记录先处于内部准备状态，`run.waiting` 到达时才与来源 Attempt、Run 原子进入等待并对管理员可见。来源 Attempt 在此之前失败或取消时立即取消准备中审批及活动检查点；重试创建审批前再次清理被当前 Attempt 取代的遗留记录。恢复前重新检查输入、Agent/工具/MCP 绑定、当前身份授权、检查点内容摘要和批准有效期；实际动作消费时再次原子校验有效期。来源 Attempt 有 PF-01 `unknown` 外部操作时拒绝恢复。相同决定且相同幂等键返回既有结果；并发相反决定或不同幂等键返回 `APPROVAL_CONFLICT`。同一检查点最多创建一个恢复 Attempt和消费一个完全相符的动作；动作、参数、资源或数据版本变化会重新申请。旧审批到期只收敛自身记录，只有其来源仍是 Run 当前 Attempt 时才可终止 Run。拒绝、过期、用户取消和系统撤权终止等待并写入员工端可见终态事件。等待 Run 计入活动工作，阻止 Session/Workspace 归档；服务重启保留等待事实，员工端按事件顺序处理，只在首个新 Attempt 事件上合并一次服务端刷新，旧响应和旧 Attempt 事件不能覆盖当前状态。

**验证边界：** Runtime Adapter 测试验证 DSH 兼容请求只携带调用 ID、无需审批且部分回答超过检查点上限时仍可执行、持久化等待事件、Worker 结束、检查点上下文和 Unicode 输出工作文件恢复；一次性 PostgreSQL 验证审批激活前不可处理、等待状态原子激活、重启保留、批准后过期不可消费、批准只恢复一次、并发相反决定返回冲突、准备中遗留审批不阻塞或终止重试、拒绝/过期/取消终态事件、未知效果阻断和旧 Attempt 不可回退；员工端组件验证同一 Run 恢复事件串行处理、只合并一次权威刷新并继续隔离旧事件，管理端组件验证动作绑定事实与决定幂等键。真实 DSH 工具请求、真实 OIDC 撤权和目标环境重启仍在 PF-07 P2 留证；本项不改变 AG-03 轻量默认行为。

### I-11 按需增加受控记忆与经验

**启动条件与归属：** 有跨任务复用需求后进入 AG-04；不把 Session 历史直接迁成自动共享记忆。

**具体实施：** 建立来源授权、候选、审核和经验版本；绑定适用 Agent Version、共享范围、内容摘要及保留规则。候选提炼仍通过 Run/Attempt → DSH；发布由有权负责人确认。检索时检查当前来源与使用范围，Attempt 固定实际引用；来源撤回或权限变化后阻止后续引用，保留必要的受控审计记录。

**改动范围与依赖：** AG-04 领域存储、受控检索/上下文准备、授权、管理员审核及反馈 API；采用 I-03 上下文策略、I-04 发布关联和 I-08 安全评测。

**完成标准：** 未同意的私人内容不提炼共享；跨用户检索不越权；撤回后新运行不再引用；经验升级不自动改 Agent Prompt、工具或权限；记忆与权威业务记录分别展示来源。

**当前实现（PF-05＋AE-04，2026-09-23）：** `0062_controlled_memory.sql` 建立来源授权、候选、逻辑条目、不可变版本和 Attempt 实际引用；`0070_agent_memory_proposals.sql` 增加短期 Agent 提案及来源关联。Agent Version 显式声明 `propose_memory@1.0.0` 才能在 DSH Attempt 暂存提案；发布试运行只返回 `trial_only`，不落库。员工仅可在本人成功 Attempt 核对提案或主动填写内容，并选择范围和保留期；管理端审核后才发布。提交幂等摘要覆盖来源 Attempt、类型、内容、范围、保留期和所选提案，同键并发收敛为一份候选。提交、审核、检索和执行复核均要求来源用户仍有原工作空间访问权；“仅本人”记忆只允许进入本人的个人空间，团队回答不能检索或固定该内容。检索及已固定引用复核均使用当前角色与 Attempt 快照角色的交集，并按当前同意、保留期、用户/空间及稳定 Agent 身份过滤，最多固定三个版本到 `memory_context`；领取、运行和等待恢复再次校验版本、摘要和 ACL。Adapter 将本次获准内容投影为只读 `workspace/memory.md`，最终回答列出实际版本引用。业务主数据、文档原文、Session 历史和检查点不进入记忆存储；撤回或来源撤权阻止后续检索和恢复，管理查询及审核重放隐藏正文，但保留历史审核及已完成 Attempt 引用。

代码级验证覆盖显式同意、审核前不可用、完整请求与并发提交幂等、决定幂等及失效正文隐藏、独立版本、私人记忆与团队空间隔离、来源成员和当前角色撤权、跨用户/空间/角色/Agent Version 隔离、撤回、运行固定来源、Schema 边界和 DSH 非权威提示；员工端候选/撤回、仅发起人提交入口和管理端审核均有组件覆盖，员工与管理主路径另有 P0 页面旅程。目标环境真实 DSH/OIDC、身份变化及等待中撤回仍在 PF-07 P2 留证。

### I-12 按需增加受控委派

**启动条件：** 通过任务效果和成本评估证明需要多个 Agent；先选工具式子任务或控制权移交的一种语义，不同时建设通用编排框架。

**具体实施：** 在现有 Run 体系记录父子关系、固定目标版本、任务输入与最小上下文；子任务权限取父任务允许委派范围与自身当前授权的交集；增加深度、并行和总体预算预占/结算，传播取消。子结果使用 I-06 契约汇入父任务；部分失败、超时及父任务退出有明确处理。所有子任务通过既有 Runtime/DSH 执行。

**改动范围与依赖：** Run 类型/仓储/调度、授权、受控委派工具及结果展示；依赖 I-04/06/07/08。累计预算未能约束子任务时，不开放相应自主委派。

**完成标准：** 子任务不能扩大权限、绕过总预算或在父任务取消后持续产生新动作；循环委派有界；子任务失败不会被父任务汇总成无依据的成功。

**当前实现（PF-06，2026-09-23）：** `0063_controlled_agent_delegation.sql` 为 Agent Version 增加平台受管委派策略，并以 `task_delegations` 持久化根/父/子 Task、Run、Attempt、精确目标 Agent Version、请求摘要、最小上下文、深度、权限上限及终态结果。策略不进入 Agent ZIP 包，也不授予任意目标；管理员只能选择当前已发布的精确版本，并配置最大深度、单父任务并行上限和等待超时。发布候选指纹、草稿分叉、发布工作台和 OpenAPI 同步固定该策略。

DSH 只在策略包含目标时获得 dsh-work 内置执行工具 `delegate_agent`。平台桥严格校验目标、任务和可选上下文，服务端在同一事务锁定活动父 Run、按父 Attempt + 请求摘要幂等、检查并行、Runtime 当前占用与嵌套容量，并预留一个可领取的同步子任务席位，然后创建 `source_type=delegation` 的无 Session 子 Task/Run；普通 Attempt 领取不能抢占该席位，队首普通任务因此留队时调度泵继续扫描后续子任务，满载时拒绝委派。子 Task 使用同一用户和工作空间，`budget_scope_task_id` 指向根 Task；授权取目标 Agent 的当前授权与父 Manifest 角色/数据范围上限的交集，团队空间还要求目标 Agent 当前仍是空间成员。委派 Task 禁止使用会丢失父关系的通用重试，只能由仍活动的父 Agent 重新委派。子 Attempt 继续经过既有编排、Runtime Adapter 与 DSH，不存在第二套 Agent Loop。

深度、目标、权限、父 Attempt 活性和持久化关系在创建及执行期复核；父任务取消、失败、撤权或退出会递归取消活动子任务，服务重启对账会终止父 Attempt 已失效的遗留子任务并收敛已终态结果。子任务返回严格 `task-result/v1`：至少存在一项可核验交付且全部必要 Artifact/Tool 回执均为 `completed` 才能标为 `achieved`；存在 `accepted/unknown` 为 `unverified`，存在失败回执或运行失败/取消为 `not_achieved`。父 Task 对委派工具只登记 `accepted` 回执，不能把工具传输成功误算为父任务目标已达成；父 Agent 仍须依据子结果产出自身可核验交付物。当前代码级验收覆盖策略持久化、未发布目标拒绝、幂等、根预算、权限上限、通用重试隔离、深度/并行/当前容量、子席位预留、父任务失效、取消、重启对账和混合回执结果真值；真实多 Agent DSH、真实 OIDC 角色/成员撤销、容量故障和端到端审计包留 PF-07。

### I-13 按需支持无 Session 的任务入口

**启动条件：** 有独立 API/事件执行需求，且现有独立 Session 无法满足；不是 Agent 规范整理的必做重构。

**具体实施：** 先盘点 Run 创建、Manifest、授权、结果投影、SSE、成果归属及数据库外键对 Session 的依赖；定义可信触发来源、幂等键、发起人与执行身份、Workspace 或其他获准资源归属。通过版本化迁移增加不依赖对话的任务/结果接口和独立访问授权；不把 `session_id` 改为可空后跳过原有授权，也不伪造员工聊天记录。

**改动范围与依赖：** Run、Runtime 契约、HTTP 接入、内容服务及数据库；依赖 I-03/04/06/08。员工/管理对话和 AG-03 独立 Session 仍属受支持业务入口，统一适配新契约，不维护旧 API 兼容层。

**完成标准：** 相同事件重复投递只受理一次；无 Session 结果与成果有明确归属且不可跨用户读取；会话路径回归通过；触发入口变化不产生第二套 Agent Loop。

### 4.4 各实施包的统一交付要求

每项落地时更新对应源码、类型/Schema、必要迁移、API 消费者、相关文档及行为验证；新表/字段命名在实现设计中确定。涉及关键前端旅程先登记 E2E 验收并完成浏览器预演，再固化 spec；UI 实现遵循管理端或员工端对应规范。

验收记录至少包含工作项编号、代码版本、改动范围、新契约生产者/消费者一致性及必要结构变更结果、实际运行的测试及环境、未覆盖项和真实验收状态。已通过检查只在后续变更影响它时重跑；只有相关证据齐备才将工作项改为完成。新增外部写入、身份类型或执行引擎能力超出已确认范围时，先完成具体设计评审。

## 5. 本轮验证范围

文档整理轮（差异清单与规范建立）仅更新 Markdown 文档及入口：`pnpm verify` 的 project/contracts/runtime/security/team-workspace-1a 静态检查通过，`pnpm check:architecture` 通过，`git diff --check` 通过。链接核验中发现自动任务 P1 spec 只是计划路径，已改为引用实际 P0 spec 并明确 P1 缺口。

实施轮在此基础上完成 I-01 与 I-02：I-01 验证 `pnpm test:runtime` 59/59、`pnpm test:skill-install` 9/9、`tsc --noEmit`、`pnpm verify`、`pnpm check:architecture`、eslint 通过；I-02 验证 `pnpm test:agent-package` 35/35、发布治理集成 `17/17`（专用可丢弃 PostgreSQL）、`pnpm typecheck`、`pnpm verify`、`pnpm check:architecture`、改动文件 eslint 通过。各工作项完成记录保留在对应条目。

以上为原实施记录，未包含浏览器 E2E 或真实 DSH/OIDC 验收；表中的测试链接不声明本清单外条目已通过。I-01/I-02 实现已包含于本次读取的提交 `4346633`，本次未核对其推送或发布状态。

2026-09-20 历史文档整理轮仅更新“不考虑历史兼容”的设计范围、五个实施包及对应验收要求；未修改业务代码或删除数据，未重跑上述功能测试。文档检查结果见本次交付记录，该轮文档改动当时未提交。

B-01 原实施轮（同日随后）：`agent-package.test.ts` 67/67、发布治理集成 17/17（专用可丢弃 PostgreSQL）、server/workbench-web/admin-web `tsc --noEmit` 通过；限额字段更名涉及的原生 SQL 夹具已同步。未跑浏览器 E2E 与真实 DSH/OIDC 验收；模型能力要求暂无运行时消费方。

**2026-09-20 当前模型准入实施轮（已包含于 `7faaf4d`）：**

- 单测：模型治理、执行能力、Manifest Schema/编译器、HTTP 错误体验合计 27/27；Runtime Adapter 42/42，共 69 项通过。Adapter 首次在沙箱内因 Unix socket 监听权限失败，在允许本地 socket 的环境复跑通过；使用受控 ACP Worker，未调用真实模型。
- PostgreSQL：发布治理 20/20；编排 20/20（含三入口 × 模型/Runtime 不匹配的六个子用例及恢复拒绝），均使用专用可丢弃数据库。正例固定能力快照；负例不创建 Attempt、不留排队 Run；恢复拒绝记录错误码且不启动 Worker。
- `pnpm typecheck`、`pnpm lint`（含架构和 UI 契约检查）、`pnpm verify`、`git diff --check` 通过。
- 未执行浏览器 E2E、真实 DSH/OIDC/P2；未推送或发布。高级模型能力仍需实际接通及验收。

**2026-09-20 I-05 工具契约实施轮（已包含于 `7faaf4d`）：**

- Runtime 73/73：平台桥覆盖严格 Schema、输入/输出错误、调用上限、当前授权、读超时/写结果未知、串行冲突、超时后底层处理器未结束时保持串行锁、受管冲突/不可用传播、执行前失败与处理器启动后的写入不确定性，并验证 Python Runner 最坏 JSON 转义输出不超出契约预算；DSH 政策 9/9 覆盖目录 v2、超时语义、非 2xx 错误及其模型可见语义传播。
- PostgreSQL 工具治理集成 1/1，使用专用可丢弃数据库验证迁移及新增/读取 Tool Version 契约字段；管理端测试 17 文件 92 项通过。
- `pnpm typecheck`、`pnpm lint`（含架构和 UI 契约检查）、`pnpm verify`、`git diff --check` 通过。
- 该轮未执行浏览器 E2E、真实 DSH/OIDC/P2；提交后未核对推送或发布。外部异步写操作的操作键、受理回执和状态核对随具体能力接入。

**2026-09-20 I-06 任务结果外层实施轮（已提交为 `a263a06`）：**

- 领域单测 `task-result.test.ts` 12/12：非终态/失败/成功三态、成果登记缺口、未提交回答、截断与中断、工具审批与完成回执、无交付物及不可变成果版本引用等判据分支。
- PostgreSQL 集成（专用可丢弃库）：m3 编排 22/22（新增不可变成果版本回执、成果登记缺口 → `unverified`、失败 Run → `not_achieved` 断言）；自动化 13/13（受理不视为达成、`resultOutcome` 投影）；团队讨论收权 7/7（`/runs/{id}/result` 与详情同一授权边界）；m4 知识/通知、 m5 故障套件同步迁移到 `task.result.*` 断言。
- HTTP 契约：`api-contract` 15/15，Prototype 下 `/runs/{id}/result` 与自动化执行列表的 `resultOutcome` 按 503/契约校验，并固定 `/sessions/{id}` 线程与 `/sessions/{id}/summary` 摘要 operation。
- 前端全量测试 344/344：结果核验区、unverified 警示、无「目标已达成」误报；`pnpm --filter './apps/*' --filter @dsh-work/server typecheck` 通过。
- P1 浏览器旅程 `e2e/personal-integration/task-result.spec.ts` 3/3：专用可丢弃 PostgreSQL + 显式合成 Runtime/身份，覆盖已登记成果、仅回答与 `P1-成果缺口` 三条链路。
- 未执行真实 DSH/OIDC/P2 验收；本次只核对到本地提交，未核对推送或发布。外部异步写操作的 `accepted` 回执核对随具体能力接入。

**2026-09-21 B-05/I-08 自动任务 P1 第一批（已提交为 `5268fe3`）：**

- 新增独立 `playwright.automation.config.ts`、`scripts/testing/automation-workbench-browser.ts` 与 `e2e/automation.integration.spec.ts`；专用夹具创建并销毁一次性 PostgreSQL，使用受控身份和合成 Runtime，不接 OIDC、真实 DSH 或模型。
- P1 浏览器 5/5：覆盖同键并发只产生一组 Execution/Session/Run、无 Attempt 准备中断可见；失败不自动重试、遗漏区间可见并须明确再次运行；账号停用在受理时拒绝、另一员工读取 404；发布 v2 后任务仍按钉住版本运行及暂停入口；自动任务车道占满时交互 Run 仍成功，取消后排队自动任务继续。
- 工作台任务卡增加可访问区域名称，测试通过用户可感知角色与名称定位；`PersonalBrowserRuntime` 仅增加测试标记的确定性失败、保持运行和取消收敛，不进入生产装配。
- 可见浏览器预演确认 `/automations` 首屏、空态、导航与新建表单布局正常，必填字段具有可访问名称且未填时创建按钮禁用。自动任务 P1 5/5、既有个人工作台 P1 7/7、自动任务服务集成 13/13、Server 与 workbench-web typecheck、`pnpm lint`、`pnpm verify`、改动文件 eslint、`git diff --check` 均通过。
- 尚未执行真实 DSH/OIDC/P2；该提交未推送或发布。阶段化授权缺口由下一实施轮继续处理。

**2026-09-21 B-05/I-08 权限与故障矩阵（已提交为 `12435b0`）：**

- `review-a2.integration.test.ts` 的真实 PostgreSQL 领取边界从账号/Agent 扩展到输入文件和平台工具绑定：领取后删除输入文件或撤销固定工具修订均不进入 Runtime；授权服务故障保持 `AUTHORIZATION_CHECK_UNAVAILABLE`，不写成撤权。
- 平台工具桥将授权拒绝与授权基础设施故障分开：明确 `permission_denied` 才返回 403/`TOOL_PERMISSION_DENIED`；其他检查故障返回 503/`TOOL_AUTHORIZATION_UNAVAILABLE`。安全读在执行前失败可重试；写处理器已经开始后复核失败标为效果未知且不可自动重试。
- Runtime Adapter 增加活动 Worker 和成果收集阶段的授权服务故障回归：停止执行、无 `assistant.completed`/`run.completed`，错误码保持 `AUTHORIZATION_CHECK_UNAVAILABLE`。阶段矩阵已列出受理、领取、活动执行、成果提交和结果读取的证据及剩余对象特定缺口。
- `review-a2.integration.test.ts` 进一步组合真实 PostgreSQL 与合成 ACP Worker：活动期移除输入文件后 Worker 停止、无完成事件；阻塞成果扫描后移除团队成员，数据库发布事务拒绝且未登记 Artifact 版本。
- `team-workspace-discussion-api.integration.test.ts` 直接覆盖已知 Run 结果端点：账号停用为 403/`permission_denied`，授权基础设施故障为 500/`operation_failed`，团队成员移除为 404/`run_not_found`，三种状态不混淆。
- 当前验证：Runtime 授权相关定向测试 55/55，完整 `@dsh-work/server test:runtime` 77/77；`review-a2.integration.test.ts` 7/7、团队讨论 HTTP 集成 7/7，均使用专用可丢弃 PostgreSQL；完整 typecheck、lint、`pnpm verify` 与 `git diff --check` 通过。该代码提交未推送或发布；后续曾有 P2 手工完成的口头结论，但没有可复核记录，不能用于当前 PF-07。

**2026-09-21 B-05/I-08 Agent 专属评测契约（已提交为 `12435b0`）：**

- 新增 `dsh-work.ai/evaluation/v1` / `AgentEvaluationSuite` 严格格式及可复制模板；拒绝旧数组、未知版本/字段/类型/断言。五类必需案例为正常目标、无效输入、越权、提示注入和能力特有失败。
- 每个案例固定声明 Run/Attempt 已记录、执行成功、输出非空三项机器断言，并提供必需的人工 rubric。试跑保存契约版本、断言结果、Run/Attempt 与输出摘录；机器断言失败直接阻塞，不能由人工结论覆盖。
- 默认候选、ZIP 导入、案例编辑、发布检查、真实 Run/Attempt 试跑、版本证据和管理端展示已同步；提交审核和发布事务均重新验证五类 v1 运行证据，升级前通过的三案例旧记录不能复用。管理端把旧 JSON 识别为不可用证据，保持页面可读并提供重新试运行及已提交候选撤回入口。平台通用权限/故障套件不复制进 Agent 包，通用默认案例仍不是具体 Agent 的业务验收结果。
- 员工主导航契约同步为“新对话、团队空间、自动任务”三个入口；历史对话与我的文件保留受权路由、数据和上下文入口，不在主导航展示。根规范、设计说明、测试目录及 P0 导航断言已同步。
- 当前验证：Agent 包解析 68/68；发布治理集成 22/22（专用可丢弃 PostgreSQL + 合成 Runtime，含机器断言失败和旧证据失效门禁）；管理端治理 Store 12/12、评测证据工具 2/2；隔离 Prototype 个人工作台 P0 2/2。完整 typecheck、lint、`pnpm verify` 与 `git diff --check` 通过。该代码提交未推送或发布；后续曾有 P2 手工完成的口头结论，未留下环境、版本、Run/Attempt、验收人和限制记录，不能用于当前 PF-07。

**2026-09-21 通用 Agent 全生命周期模板（已提交为 `8b3982d`）：**

- 新增与业务场景无关的统一流程：工作定义 → 能力分解 → 扩展判定 → AgentSpec → 能力准入与绑定 → 五类评测 → DSH 试运行 → 审核发布 → 结果核验 → 演进/退役。
- MCP、持久化等待、受控记忆、Agent 委派和无 Session 入口改为模板中的条件扩展轨道；每项均定义触发事实、默认替代方案和必须补齐的设计/验收，不作为所有 Agent 的默认组成。
- 模板包含可复制的 Agent 设计记录、阶段门槛、P2 证据字段和变更失效规则。物料齐套等场景仅作为填写模板和验证通用性的案例，不进入平台主流程定义。

**2026-09-21 生命周期实现映射与通用参考 Agent：**

- 新增十一阶段实现映射：第 1～3 阶段使用设计记录，第 4～9 阶段分别落到 AgentSpec、能力/Binding、发布候选、Run/Attempt 和 `task-result/v1`，第 10～11 阶段由审计、不可变版本、重新发布和停用承担。
- 明确不为未触发的 MCP、持久化等待、记忆、委派和无 Session 入口新增数据库状态或 AgentSpec 空开关；跨版本质量/成本趋势聚合保留为可选运维增强。
- 新增场景无关的通用文本整理助手生命周期记录和受版本控制的严格 Agent 包。参考包无 Skill/Tool、无外部 Binding、无额外模型能力要求，包含五类 v1 评测与完整 checksums；它只证明第 1～6 阶段的文档和包契约，不宣称候选、发布、真实运行或 P2。
- 当前验证：Agent 包解析 69/69（新增仓库参考包解析、摘要和五类案例断言）；全仓 typecheck、lint、`pnpm verify` 与 `git diff --check` 通过。未运行浏览器 E2E、真实 DSH/OIDC 或新增 P2；本轮没有改变前端旅程和生产执行路径。

**2026-09-21 PF-02 用量与累计预算（当前工作区，未提交）：**

- PostgreSQL 仓储与编排验证通过：M2 仓储及升级集成 14/14、M3 编排集成 28/28、自动任务集成 13/13、M4 审计 5/5、通知/错误体验 2/2、Runtime 配置 1/1、M5 安全 4/4、Runtime 故障 2/2、生命周期 20/20、共享文件 18/18、启动恢复 3/3。升级用例从 0051 基线构造旧排队 Attempt；并发用例确定性交错取消与精确结算。测试使用专用可丢弃 PostgreSQL；不等同于真实环境验收。
- 契约与 Runtime 验证通过：Runtime 82/82、M5 API 23/23、全仓 `pnpm typecheck`、`pnpm lint`、`pnpm verify`、`pnpm build`、OpenAPI/Runtime Schema JSON 解析及 `git diff --check`。构建仅有既有 Vite 分块大小提示。
- Skill 安装 PostgreSQL 集成 12 项中 11 项通过、1 项真实 DSH 按标记跳过；覆盖旧版 Skill Attempt 缺少预算快照时的重试升级，新 Attempt 固定完整依赖、模型路由与预算快照。
- 未执行真实 DSH Token 回报、成本计量、真实 OIDC、浏览器 E2E、部署或 P2。Token/成本硬预算仍按能力契约明确拒绝；PF-02 改动保持未提交、未推送，后续提交不得把这些未覆盖项描述为已验收。
