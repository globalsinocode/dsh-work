# Agent 规范与当前实现差异清单

**初次核对：** 2026-09-19；**实施范围更新：** 2026-09-20<br>
**代码基线：** 初次核对为 `3f4f4bf`；本次文档更新基于 `4346633`，其中已包含 I-01/I-02 实现。保留已有完成记录，本次未重跑其中的功能测试。<br>
**规范入口：** [Agent 设计规范](agent-design-standard.md)。<br>
**范围：** 静态阅读契约、关键实现与测试用例；不将用例存在、历史报告或状态文案视为本次运行通过。未启动数据库、浏览器、真实 DSH 或 OIDC 验收。

## 1. 结论与状态口径

已有统一 DSH 执行、版本发布、精确依赖、当前授权、文件成果、执行事件和轻量自动任务基础。主要缺口是绑定修订的真实落地、结构化定义与结果契约、工具效果语义、持续执行协议和分层评测覆盖。无需因此另建 Agent 执行引擎。

| 状态 | 本文含义 |
| --- | --- |
| 已实现（代码级） | 已定位相应执行分支及相关测试；只限明确列出的范围，不代表 P2 验收 |
| 部分实现 | 存在基础，但尚未覆盖该条规范的全部要求 |
| 未实现（核对范围内） | 相关契约/入口缺少该能力，不能以规划或展示字段推定存在 |
| 不适用当前范围 | 可选能力尚未启用，不作为基础 Agent 的缺陷；启用前须完成门槛 |

## 2. 十二条逐项核对

| 规范 | 状态与代码证据 | 测试证据及不足 | 后续动作 |
| --- | --- | --- | --- |
| AS-01 对象分离 | **部分实现**。[Agent 服务](../../server/src/modules/agent/postgres-agent-service.ts)的草稿/发布与 `getRuntimeSnapshot`、[Run 类型](../../server/src/modules/run/run-types.ts)已分离目录、版本和 Attempt；[发布服务](../../server/src/modules/agent/postgres-agent-release-service.ts) `buildPlan` 中的 `binding-rev-3` 为固定值 | [发布集成用例](../../server/src/infrastructure/postgres/agent-release-governance.integration.test.ts)覆盖候选修订、封存和发布；没有据此证明绑定修订真实持久化 | 保留 `agentVersionId`；补齐定义、真实绑定修订、发布与 Attempt 的引用及变更验证 |
| AS-02 精简定义 | **部分实现**。[包解析器](../../server/src/modules/agent/agent-package.ts) `parseAgentPackage` 接收扁平字段，校验版本、Prompt、摘要和依赖；尚无统一 AgentSpec 及结构化输入输出/模型能力/上下文策略。I-02 已补字段政策：未识别字段警告、平台受管字段与 `apiVersion/spec` 结构清单拒绝、别名并存冲突拒绝、声明与包内候选版本冲突拒绝 | 发布用例覆盖无案例时默认生成、摘要缺项、版本冲突、缺失依赖；[解析单测](../../server/src/modules/agent/agent-package.test.ts)覆盖字段规则、冲突与旧包兼容。默认生成案例已带 `origin` 来源标记并在检查详情提示核对实际预期 | 结构化输入输出/上下文策略/模型能力契约仍待 I-03；不能直接把草案 `apiVersion/spec` 当作受支持格式 |
| AS-03 统一执行 | **已实现（现有生产接线）**。[main](../../server/src/main.ts)组装 Runtime；[编排服务](../../server/src/modules/run/run-orchestration-service.ts)的员工、管理、发布试运行均创建 Attempt；[Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)启动 ACP Worker | [执行能力测试](../../server/src/modules/runtime/execution-capabilities.test.ts)、[Adapter 测试](../../server/src/modules/runtime/runtime-adapter.test.ts)覆盖不可用、取消和故障；本次未运行真实 DSH | 维持单链路；每种新增入口均追踪实际接线，发布前验证目标 Runtime |
| AS-04 状态与上下文 | **部分实现；长期记忆不适用当前范围**。[Manifest 编译器](../../server/src/modules/runtime/manifest-compiler.ts)限制历史、文件和知识；Adapter 的 `renderSystemPrompt` 按需展示 Skill 目录；[内容服务](../../server/src/modules/workbench/application/postgres-content-service.ts)复核输入；[知识服务](../../server/src/modules/knowledge/postgres-knowledge-service.ts)提供来源 | Adapter 测试覆盖授权知识投影、渐进 Skill、外置资源和历史上限；通用跨任务记忆的来源撤回未在当前链路实现 | 保持现有分层；统一上下文策略与 Schema（见 D-03）；记忆随 AG-04 单独设计 |
| AS-05 Skill/Tool/MCP | **部分实现；外部 MCP 未实现（当前 ACP 入口）**。[工具目录](../../server/src/modules/tool/dsh-built-in-tool-catalog.ts)将未知工具标为不支持；[ACP 客户端](../../server/src/modules/runtime/acp-json-rpc-client.ts) `newSession` 提交 `mcpServers: []`；[平台工具桥](../../server/src/modules/runtime/platform-tool-bridge.ts)为本地受控传输 | 发布用例明确包内 Tool 候选阻塞发布；没有外部 MCP 服务绑定、发现变更及调用验收证据 | 保留当前准入；有外部接入需求再按 AG-02 实现，同一能力治理，不新增 MCP 权限体系 |
| AS-06 工具效果契约 | **部分实现**。[Tool 服务](../../server/src/modules/tool/postgres-tool-connector-service.ts)有输入输出 Schema、审批和超时；目录的 `runtimeToolToCatalogEntry` 为输出使用空 Schema；平台桥调用返回任意结果，没有通用外部操作回执、未知结果与跨 Attempt 动作去重协议 | [工具治理测试](../../server/src/infrastructure/postgres/m4-tool-connector-management.integration.test.ts)验证治理范围；既有 Run 幂等和事件去重不能证明外部副作用恰好一次 | 新写动作开放前补效果、重试、冲突与核对契约；现有本地文件动作按实际语义审查，不强迫接入外部事务系统 |
| AS-07 当前权限 | **部分实现（当前执行复核已接线；通用持久化审批未实现）**。main 的 `authorizeExecution` → 编排 `assertCurrentRunAuthorization` → [当前授权函数](../../server/src/modules/run/current-execution-authorization.ts)；平台桥前后复核。main 的 ACP `permissionDecision` 默认拒绝；目录明确阻塞尚需逐次审批的工具 | [当前授权](../../server/src/modules/run/current-execution-authorization.test.ts)、[用途分流](../../server/src/modules/run/run-orchestration-authorization.test.ts)、Adapter 活动撤权/成果收集时撤权用例已存在；真实多账号收权及每类工具仍需 P2 | 保持个人/团队共同安全门槛；不把 `approval.required/resolved` 当作持久化人工批准；外部能力和审批接入再逐条验证 |
| AS-08 持久化恢复 | **部分实现；等待/检查点未实现（Run 契约）**。RunState 只有 queued/running/cancel_requested/succeeded/failed/cancelled；[Run 仓储](../../server/src/modules/run/postgres-run-repository.ts) `recoverAfterRestart` 收敛活动 Attempt、恢复排队；[自动任务服务](../../server/src/modules/automation/automation-service.ts)处理中断准备 | [编排集成](../../server/src/infrastructure/postgres/m3-orchestration.integration.test.ts)、[故障集成](../../server/src/infrastructure/postgres/m5-runtime-faults.integration.test.ts)、[自动任务集成](../../server/src/infrastructure/postgres/automation.integration.test.ts)覆盖相关状态与竞态；未证明通用副作用恢复 | 维持 AG-03 轻量语义；有长流程需求后随 EX-03 设计等待/恢复/动作核对，不把聊天重放作为恢复 |
| AS-09 预算与委派 | **部分实现；委派不适用当前范围**。Manifest 有时长、输出字节、工具次数；Adapter 限时与截断文本，平台桥计数，DSH 收到 `DSH_MAX_TOOL_CALLS`；Run 仓储的 `claimAttempt` 为自动任务保留交互容量 | Adapter 有执行及启动超时用例，自动任务集成有取消/领取竞态；没有统一累计 Token/成本、重试预算及父子任务预算契约。`maxTokens * 4` 用于输出字节估算，不是模型 Token 拦截 | 标明限制实际效力；需要累计硬预算时单独实现并测试 DSH 边界，委派按需求评审 |
| AS-10 真实结果 | **部分实现**。编排 `persistEvent` 将 `run.completed` 转成 succeeded；Adapter 收集成果并提交回答；内容服务管理版本与权限。没有独立的通用“目标达成/动作未知”结果外层 | Adapter 覆盖成果收集失败/撤权；Run 与文件测试验证执行及成果机制，不能证明所有业务目标达成 | 设计结果外层并同步切换消费者；保留 Run 执行状态，将业务完成、回执和未解决事项独立表达 |
| AS-11 版本追溯 | **部分实现**。[迁移 0039](../../server/migrations/0039_agent_release_governance.sql)保存包、候选、试运行和证据；发布事务复核 sealedRevision/最新试运行；RunAttemptRecord 保存 Manifest 摘要和模型路由快照 | 发布集成覆盖修改候选使证据失效、人工判失败阻塞发布、同版本不同内容冲突；未覆盖真实绑定修订与跨环境变更 | 与 AS-01 一起补真实发布依赖；小范围启用和目标环境验证仍是发布门槛 |
| AS-12 评测与审计 | **部分实现**。发布服务要求 success/invalid_input/permission_denied 三类案例，记录 case Run 与人工判定；运行事件关联 trace/Attempt，记录工具和模型用量 | 发布用例使用 `TrialStubRuntime`；成功终态及非空输出后仍由人判业务预期。平台有故障/安全测试，尚未形成覆盖质量、注入、可靠性和成本的统一 Agent 评测契约 | 分清平台测试与 Agent 专属案例，补评测分层、可复现证据和 P2；不将默认三案例作为完整质量证明 |

## 3. 已确定的契约决策与具体缺口

### D-01 绑定分离保留现有发布入口

遵循 [Agent 设计规范](agent-design-standard.md)的“定义版本 + 环境绑定修订 → 平台发布版本”逻辑，不新增强制 Release ID。后续实现须从真实绑定记录解析计划；固定 `binding-rev-3` 只证明页面计划中有一项文字，不能证明端点/身份/权限发生变化时能锁定及追溯。

### D-02 包的当前支持与目标格式分开

**2026-09-20 起（B-01 已实施）：** `parseAgentPackage` 只接受分层 `agent.yaml`（`apiVersion: dsh-work.ai/v1`、`kind: AgentPackage`、`metadata`、`spec`），经 [agent-package.schema.json](agent-package.schema.json)（Ajv，`additionalProperties: false`）严格校验后归一化为 `AgentSpec`。指令必须经 `spec.instructions` 文件引用；能力依赖为 `capabilities.skills/tools` 下的 `id@x.y.z` 精确引用；`input`/`output`/`context`/`limits`/`model.requirements`/`evaluation` 均有版本化契约。旧扁平清单、字段别名（display_name、prompt_file、role_ids、skill_refs、tool_refs、max_tokens 等）、未知字段、重复 YAML 键与平台受管字段（凭据、端点、模型路由、执行环境、绑定、授权范围、调度、安装钩子等）一律在解析阶段拒绝，不再有警告后忽略或双格式解析。无 `evals/cases.yaml` 时发布服务仍生成默认案例（带 `origin` 来源标记）；缺少 checksums 时解析给警告，发布检查阻塞；提供清单时须覆盖全部文件（除清单自身）。解析、候选检查与发布是不同阶段，不支持用“平台自动生成摘要”替代 ZIP 发布门禁。配置入口与 ZIP 归一化为同一 `AgentSpec` 并持久化于 `agent_versions.agent_spec`；限额列由 `max_tokens` 更换为 `max_output_bytes` + `max_tool_calls`（迁移 0046），既有行按平台默认值补齐、不回填定义。

**历史记录（2026-09-19，已被 B-01 取代）：** 原基线曾接受扁平清单与字段别名并做冲突校验，详见 I-02 完成记录。2026-09-20“不考虑历史兼容”决策生效后，别名接受、未知字段警告、双格式解析均已移除，不做旧包兼容或渐进迁移。

### D-03 Runtime TypeScript 与 JSON Schema 有漂移

[Runtime 类型](../../server/src/modules/runtime/runtime-types.ts)及 `compileRuntimeManifest` 支持 `artifact_ref`、`instructions_sha256`，允许外置 Skill 省略正文及文件 content；[Runtime Manifest Schema](runtime-manifest.schema.json)仍要求 instructions/content，且在 `additionalProperties: false` 下未声明上述外置字段。

这属于已定位的契约同步缺口，应优先修正 Schema 并用内联/外置 Skill、缺少引用摘要、非法路径和额外字段等真实样本验证。当前静态 verify 即使通过，也不代表所有实际 Manifest 能通过 Schema。模型能力要求等新增字段不与这项现有漂移修复混在一起。

**2026-09-19 更新：** 已由 I-01 修复并验证，见对应工作项完成记录。

### D-04 Session、恢复和预算不因文档改名升级

当前 `CreateRunInput.sessionId` 与 `RuntimeManifest.session_id` 必填，自动任务事务中创建独立 Session。此模式继续受支持；不强制为了目标概念移除 Session。Run 没有等待状态，ACP 审批回调也不提供跨进程等待机制。长期等待与无 Session 入口属于明确需求后的扩展。

Manifest 的输出字节限制只截断收集的文本，工具次数还依赖目标 DSH 政策执行；累计 Token、金额、磁盘或跨 Attempt 总预算不能由这些字段推导。目标 Runtime 的执行约束仍需实测。

### D-05 结果状态与证据需要独立契约

当前 succeeded 表示平台执行终态，不能直接作为业务完成标志。后续结果外层应关联已有 Run、消息、来源和 Artifact，而非另建执行状态机；先定义读写消费者及失败语义，再决定统一字段和切换方案，不增加旧 Run 兼容展示。

### D-06 进度文案已落后于代码

当前仓库有自动任务迁移、服务、日历、触发扫描、API 及 [P0 浏览器冒烟](../../e2e/automation-smoke.spec.ts)。[验收目录](../../e2e/TEST-CATALOG.md)中的 P1 `e2e/automation.integration.spec.ts` 仍为计划路径，当前文件不存在。集成文件还包含取消/领取竞态和 advisory lock 释放用例。它们只能证明实现与用例存在；本次不能沿用旧报告宣称已跑绿。相关文档已将“未实施”改为“已有实现，验收状态需分层核对”。

## 4. 具体需要实施的工作

2026-09-20 起按“不考虑历史兼容”组织实施：近期 I-01～I-08 合并为 B-01～B-05 五个实施包，I-09～I-13 五项按需扩展暂缓。保留 I 编号用于差异追踪和已完成记录，不再将它们作为八个独立近期交付批次。I-01/I-02 已按原基线完成，但新决策涉及的旧引用接受、包别名及未知字段警告等清理尚待 B-01/B-02 实施，不能把原完成状态当作新契约已经完成。未标完成的新字段、表与接口均为待设计内容，不表示当前已经支持。工程归属沿用各阶段实施文档（如 [AG-03 实施方案](../design/automation-implementation-plan.md)）及 [Runtime EX 方案](../design/runtime-execution-optimization-plan.md)，此处维护差异对应的工作分解。

为便于追踪已有代码和验收目录，保留阶段编号：AG-01 表示 Agent 包与发布，AG-02 表示工具扩展，AG-03 表示轻量自动任务，AG-04 表示受控经验。AG-01/02/04 的后续工作直接以本文 I 编号为入口，无需查阅已删除的总方案；AG-03 与 EX 的细节使用上述现存文档。阶段编号不表示能力已实现或已授权启动。

### 4.1 五个实施包与范围精简

统一取消旧格式双读、历史别名、旧配置转换、旧版本绑定回填、旧 Run 结果展示和新旧版本兼容测试；保留新契约内部的多版本治理、当前授权、能力匹配、并发/幂等、故障恢复及分层验收。必要建表/结构变更仍需实现；不含清库、删除已有文件或历史执行。

| 实施包 | 原工作项 | 仍需实施的内容 | 省去的历史兼容工作 | 当前状态与依赖 |
| --- | --- | --- | --- | --- |
| B-01 统一定义与严格包格式 | I-02 + I-03 | 唯一包格式、规范化 AgentSpec、严格字段与依赖校验、输入输出/上下文/模型能力要求；配置与 ZIP 共用契约 | 旧包别名、双格式解析、警告后渐进收紧、旧定义转换与默认值回填 | **已实施（见 I-02/I-03 完成记录）**：分层清单 + 严格 Schema + `agent_versions.agent_spec` + 限额列更名；模型能力要求仅声明校验，路由消费待 B-02/B-03 |
| B-02 统一运行契约与预算 | I-01 + I-07 | 选定唯一引用规则，Schema/类型/编译/存储同口径；同步清理旧读取分支，验证可执行限额和交互容量 | 旧持久化引用接受、存量预算字段转换及旧 Manifest 运行兼容 | I-01 漂移修复完成；新规则清理及 I-07 待实施。限额核查可先开展 |
| B-03 真实绑定与发布追溯 | I-04 | 真实绑定修订、定义/发布/Attempt 关联、变更影响与证据失效；新契约内多版本追溯与回滚 | 旧绑定还原、历史发布记录回填和跨旧格式回滚 | 待实施；与 B-01/B-02 对齐，新外部写动作前完成 |
| B-04 工具及任务结果契约 | I-05 + I-06 | 工具输入输出/效果/错误、结果外层、回执/成果、统一 API 与 UI；既有工具同步适配 | 新旧工具协议并存、旧 API 适配、旧 Run 展示及从历史文本补结果 | 待实施；依赖 B-01 输出要求、B-02 执行契约；绑定使用 B-03 |
| B-05 分层评测与验收 | I-08 | 新格式拒绝、任务质量、实时权限、故障/预算、P1 浏览器及真实 P2 证据 | 旧版本兼容、历史回填及迁移正确性测试 | 待补齐，贯穿 B-01～04；保留已有有效安全回归 |

建议从 B-01 的统一格式/定义和 B-02 的运行契约/限额开始；随后完成 B-03、B-04。B-05 随每个实施包运行相关验证，不留到最后一次性补测。五项可选扩展不作为基础发布门槛，也不因减少历史兼容而自动启用。

### 4.2 原工作项映射与完成记录

| 工作项 | 对应规范/差异 | 具体交付物 | 前置依赖及归属 |
| --- | --- | --- | --- |
| I-01 修复 Runtime Schema | AS-04/11，D-03 | ~~支持内联/外置 Skill 的一致 Schema、编译校验及正反例~~ **已完成（2026-09-19）** | 可先独立修复；Runtime 契约 |
| I-02 包校验原基线 | AS-02/11，D-02 | 字段规则、冲突检查与反馈 **原基线已完成（2026-09-19）**；新严格格式清理见 B-01 | 可独立；AG-01 包与发布 |
| I-03 落实规范化 Agent 定义 | AS-02/04，D-02/04 | 配置/ZIP 共用定义、输入输出与上下文策略、模型/Runtime 能力校验 | I-01/02；AG 定义及运行准备 |
| I-04 落地真实绑定修订 | AS-01/07/11，D-01 | 绑定修订、发布/Attempt 引用、变更影响与证据失效机制 | 可先做既有能力绑定；与 I-03 接口对齐；AG-01/02 |
| I-05 统一工具契约与结果 | AS-05/06/07 | 输入输出校验、稳定错误、效果/重试语义、既有工具贯通样例 | 既有工具可独立；外部写入依赖 I-04；EX-01 |
| I-06 增加任务结果外层 | AS-10，D-05 | 区分执行终态与业务结果的存储/API/前端投影 | I-03 的输出要求、I-05 的动作结果；EX-01/02 |
| I-07 核实并补齐预算执行 | AS-09，D-04 | 限额执行矩阵、现有限额漏洞修复及边界测试 | 现有时长/工具/输出上限可独立；EX-00、AG-03 |
| I-08 补齐评测和验收证据 | AS-03/07/08/12，D-06 | 评测分层、现有安全/故障回归、自动任务 P1 浏览器旅程、P2 记录 | 现有路径可先验证；新增契约随 I-01～07 增补；AG/EX 共同门禁 |
| I-09 接入外部能力/MCP | AS-05/06/07 | 一种批准接入类型及完整准入、调用、撤权验证 | 按需；I-04/05/08；AG-02 |
| I-10 持久化等待与审批恢复 | AS-07/08，D-04 | 安全检查点、等待/恢复协议、动作绑定审批和恢复测试 | 按需；DSH 能力验证、I-04～08；EX-03A/B |
| I-11 受控记忆与经验 | AS-04/11/12 | 来源授权、候选审核、独立版本、检索及撤回机制 | 按需；I-03/04/08；AG-04 |
| I-12 受控 Agent 委派 | AS-09 | 父子运行关系、权限/预算传播及取消协议 | 按需；I-04/06/07/08；独立需求评审 |
| I-13 无 Session 任务入口 | AS-01/10，D-04 | 独立触发来源、任务结果读取与访问授权、统一契约 | 按需；I-03/04/06/08；保持既有对话及自动任务入口 |

以下 I-01/I-02 的完成记录描述当时实现；后续新增范围按五个实施包执行。实施包编号与 P0/P1/P2 验证层级相互独立。

### I-01 修复 Runtime Schema 与实际 Manifest 的漂移

**B-02 后续范围：** 下述完成记录保留事实；其中为旧引用放宽读取规则的兼容处理不再是后续要求，统一新规则尚待实现。本次文档不删除该代码或历史数据。

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

**B-01 实施记录（2026-09-20）：**

- **唯一包格式与严格 Schema：** [agent-package.ts](../../server/src/modules/agent/agent-package.ts) 只接受 `apiVersion/kind/metadata/spec` 分层清单，由 [agent-package.schema.ts](../../server/src/modules/agent/agent-package.schema.ts) 与 [agent-package.schema.json](agent-package.schema.json)（Ajv 2020，`additionalProperties: false`，TS 常量导出保证零漂移）校验；旧扁平清单、全部字段别名、未知字段、重复 YAML 键、锚点别名及平台受管字段（凭据/端点/模型路由/执行环境/绑定/授权/调度/安装钩子等保留关键字）直接 422 拒绝。
- **规范化 AgentSpec：** 新增 [agent-spec.ts](../../server/src/modules/agent/agent-spec.ts) 定义 `AgentSpec`（metadata、instructions 文件引用+正文、capabilities 精确引用、input/output/context、catalog、limits、evaluation、model.requirements）；`agentSpecFromConfiguration` 将配置表单归一化为 `prompts/system.md` 文件表示，与 ZIP 解析结果同构。
- **持久化：** 迁移 `0046_agent_spec_definition.sql` 将 `agent_versions.max_tokens` 更换为 `max_output_bytes` + `max_tool_calls` 并新增 `agent_spec jsonb`；配置创建/草稿更新/版本分叉与 ZIP 导入四条版本写入路径均固化展开后的 spec；既有行按平台默认值补齐、不回填（不考虑历史兼容）。`timeout_seconds` 语义不变。
- **依赖与运行时：** 依赖仅接受 `id@x.y.z` 精确引用，声明版本与包内候选版本不一致、同 id 多版本均拒绝；运行编排按 `max_output_bytes`/`max_tool_calls` 映射 Attempt 限额，平台策略上限不变。模型能力要求仅声明与校验，路由/凭据仍平台管理，执行侧消费待 B-02/B-03。
- **消费端：** 领域类型、Admin 管理端（domain 类型、AgentDraftDialog、管理视图、发布工作台）、OpenAPI 文档及全部测试夹具切换为 `maxOutputBytes`/`maxToolCalls`。
- **验证：** `agent-package.test.ts` 67/67（重写为新格式套件：严格 Schema、平台字段拒绝、精确依赖、包内候选版本匹配、checksums）；发布治理集成 17/17（专用可丢弃 PostgreSQL）；server + workbench-web + admin-web `tsc --noEmit` 通过；集成夹具原生 INSERT 同步更名。
- **未覆盖：** 浏览器 E2E、真实 DSH/OIDC 验收未运行；`model.requirements` 无运行时消费方；既有 `agent_spec` 为 null 的旧版本行不回填，运行时快照仍由列字段驱动。

### I-04 落地真实绑定修订与发布追溯

**改动位置：** [工具/连接器服务](../../server/src/modules/tool/postgres-tool-connector-service.ts)、Agent/发布服务、[Run 仓储](../../server/src/modules/run/postgres-run-repository.ts)、[数据库迁移目录](../../server/migrations/)、管理端发布工作台及版本详情。

1. 确定真实绑定的持久化结构：能力版本、批准执行器/连接、凭据引用、身份解析策略、环境、授权上限、修订和内容摘要。Tool 模块维护工具绑定；Agent 发布引用它，不复制端点和密钥配置。
2. 将 `buildPlan` 的固定 `binding-rev-3` 替换为服务端解析出的真实记录；计划明确新增、复用、变化和不兼容项。候选检查、试运行和发布证据绑定同一组修订与摘要。
3. 绑定语义变化创建新修订和新平台发布版本；在发布事务内再次比较候选、绑定及验证依据，阻止并发变更复用旧证据。凭据等价轮换与身份/授权变化分别处理。
4. 新契约下 Attempt 固定实际绑定引用及解析证据，执行时另查当前权限和撤销状态。Session/自动任务不静默改用其他发布版本；绑定不可用时明确失败。这是新系统版本治理要求，不要求继续运行旧格式任务。
5. 直接实现新绑定结构和引用完整性校验，不还原旧绑定或回填历史发布记录。新发布的每项绑定都须有真实依据，缺失则拒绝发布/执行，不能伪造摘要。

**完成标准：** 同定义在两个批准环境可独立发布；换端点/身份后旧证据不能放行；并发改绑定时发布安全失败；历史运行可查原依据，撤权仍即时受执行边界约束。通过新结构引用完整性、发布并发、新契约内回滚和权限集成验证。

### I-05 统一工具输入输出、错误与效果语义

**改动位置：** [工具目录](../../server/src/modules/tool/dsh-built-in-tool-catalog.ts)、工具服务、[平台工具桥](../../server/src/modules/runtime/platform-tool-bridge.ts)、[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)；归入 EX-01。

1. 盘点当前批准工具，统一适配新契约，不并存两套输入输出协议：精确版本、输入/输出 Schema、动作性质、资源范围、超时/取消、审批、重试及并发要求。目录、模型可见描述、实际校验和结果投影使用同一版本；对仍不具备结构化输出的工具明确能力边界，不填空 Schema 后宣称完整校验。
2. 在调用前验证输入并由服务端注入身份/资源范围；调用后校验输出结构、大小和成果引用。保持实际调用边界的当前授权，不把模型参数作为授权依据。
3. 定义并映射无权限、参数错误、冲突、暂时不可用、超时、取消和结果未知；移除将不同失败统一描述为“包解析失败”的通用工具路径。错误中的可重试标记不自动触发重试。
4. 首先用已有文件读取/生成工具贯通契约与结果投影。为未来外部写操作定义操作键、受理回执、状态查询和并发前置条件；只有接入该动作时才实现相应业务操作记录与核对程序，不给所有只读工具强加事务台账。

**完成标准：** 已有样例工具从目录到真实调用使用一致契约；非法输出、无权限、超时和成果登记失败可区分。新增外部写动作前另验证同键不重复、跨 Attempt 保持同一业务操作身份、超时先核对效果，不能仅用 Run 幂等证明安全。

### I-06 增加可核验的任务结果外层

**改动位置：** Run 类型/仓储/事件投影、[内容服务](../../server/src/modules/workbench/application/postgres-content-service.ts)、[对话 API](../../server/src/http/workbench/conversation-routes.ts)、[Workbench OpenAPI](openapi-workbench.json)、[对话页面](../../apps/workbench-web/src/views/ConversationView.vue)及自动任务结果入口。

1. 在现有 Run 结果上增加版本化结果投影，分别表达执行状态、目标达成情况、主要结果、来源、已完成动作/回执、待处理事项、错误和 Artifact 引用。最终字段和状态枚举先通过接口设计确定，不复制第二份 Run 状态机。
2. 为文本回答、文件生成和工具操作分别定义验证依据；模型自述作为说明，不能直接设置“已验证完成”。未配置业务判据的文本任务允许显示执行结束及未验证状态，不能强迫模型给出虚假确定结论。
3. 结果提交与必要消息/成果登记明确成功顺序和幂等键；失败经现有错误通道可见。Run 成功后的读取失败只影响结果读取，不发起新的 DSH 执行，也不覆盖终态。
4. API、事件消费者和前端统一切换到新结果契约，不增加旧 Run 兼容展示或历史结果回填。前端使用既有组件展示结果、回执和待处理事项，动作提交重新鉴权。

**完成标准：** 模型说完成但必要成果缺失时不显示目标已达成；外部操作仅受理时不显示已完成；重复事件不重复登记结果；未授权用户看不到正文/成果。按照 Spec → Code → Verify → Test → Green 固化员工对话及自动任务结果旅程。

### I-07 核实并补齐预算执行

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
4. 完成自动任务 AC-20～24 的隔离浏览器预演，再创建计划中的 `e2e/automation.integration.spec.ts`（当前尚不存在），使用专用可丢弃 PostgreSQL、独立身份上下文和受控 Runtime，显式清理数据；保留已有 P0 冒烟。
5. 为每个拟发布能力单独记录真实 DSH Lock/Adapter/模型、真实身份和批准工具的 P2 结果，覆盖多账号收权、结果/成果和故障。绑定、定义或关键依赖变化时，按影响失效并重做相关证据；缺少目标环境时标记未验收，不用替身填通过。

**完成标准：** 对每条门槛能找到对应测试或人工验收结果，注明环境、版本、运行时间和失败/未覆盖项；用例存在、P1 通过与 P2 通过分别报告。此项为 B-01～04 提供持续回归门禁；取消历史格式兼容、旧数据回填及跨旧格式迁移测试，保留新契约内的版本固定、收权、并发、取消、故障及真实执行验证。

### I-09 按需接入外部能力与 MCP

**启动条件与归属：** 有明确外部能力需求后进入 AG-02；不自动恢复已推迟的全量工具扩展。不预设同时支持 REST、MCP 和所有沙箱执行器。

**具体实施：** 管理员登记批准连接与凭据引用；只接通选定的执行器/传输类型；将发现结果保存为候选并固定服务标识、能力名、契约摘要和版本；经检查/试运行/审核进入既有 Tool Version。调用时由平台过滤 Allowlist、资源范围和网络目标，再经统一 DSH 工具路径执行，记录回执及审计。MCP Resources/Prompts 单独定义访问和信任边界，不因 Tools 接通而默认开放。

**改动范围与依赖：** Tool/Connector、受管凭据、Runtime 工具适配、管理 API/UI；使用 I-04 绑定及 I-05 契约。确认 DSH 实际支持的接入能力，禁止包内命令启动任意 MCP 进程。

**完成标准：** 服务新增工具不能自动获权；同名工具不混淆；契约变更需复核；错误服务凭据、撤权、超时和取消明确失败。完成一个真实批准能力的发现→审核→授权→调用→结果链路，其他类型显示未支持。

### I-10 按需增加持久化等待、人工审批与恢复

**启动条件与归属：** 真实长流程或逐次人工审批需求；先验证 DSH 检查点/恢复能力，再按 EX-03A/B 推进。I-05 的副作用规则及 I-08 的故障验证是前置。

**具体实施：** 定义 Run 等待与 Attempt 结束/恢复关系，增加受控检查点引用、摘要、Runtime 版本和来源 Attempt；同步状态机、Schema、事件与 API。持久化审批绑定动作、参数摘要、资源、身份、有效期和数据版本；拒绝、超时、撤权、重复决定均有终态。长期等待释放 Worker；Worker 丢失后从合法检查点创建新 Attempt，重查输入、绑定和当前权限。按需用事务事件投递和接收端去重保障恢复受理。

**改动范围：** Run 仓储/编排、DSH Adapter、受控文件存储、授权及审批 UI；不在业务后端实现 Agent Loop。存活 Worker 短时审批与跨进程恢复分别验证，不将前者当作后者已支持。

**完成标准：** 同一批准最多产生一次有效继续；参数变化使旧批准失效；服务重启、重复事件与迟到旧 Attempt 不重复动作；未知效果先核对。DSH 不支持安全恢复时保持明确失败，本项不改变 AG-03 轻量默认行为。

### I-11 按需增加受控记忆与经验

**启动条件与归属：** 有跨任务复用需求后进入 AG-04；不把 Session 历史直接迁成自动共享记忆。

**具体实施：** 建立来源授权、候选、审核和经验版本；绑定适用 Agent Version、共享范围、内容摘要及保留规则。候选提炼仍通过 Run/Attempt → DSH；发布由有权负责人确认。检索时检查当前来源与使用范围，Attempt 固定实际引用；来源撤回或权限变化后阻止后续引用，保留必要的受控审计记录。

**改动范围与依赖：** AG-04 领域存储、受控检索/上下文准备、授权、管理员审核及反馈 API；采用 I-03 上下文策略、I-04 发布关联和 I-08 安全评测。

**完成标准：** 未同意的私人内容不提炼共享；跨用户检索不越权；撤回后新运行不再引用；经验升级不自动改 Agent Prompt、工具或权限；记忆与权威业务记录分别展示来源。

### I-12 按需增加受控委派

**启动条件：** 通过任务效果和成本评估证明需要多个 Agent；先选工具式子任务或控制权移交的一种语义，不同时建设通用编排框架。

**具体实施：** 在现有 Run 体系记录父子关系、固定目标版本、任务输入与最小上下文；子任务权限取父任务允许委派范围与自身当前授权的交集；增加深度、并行和总体预算预占/结算，传播取消。子结果使用 I-06 契约汇入父任务；部分失败、超时及父任务退出有明确处理。所有子任务通过既有 Runtime/DSH 执行。

**改动范围与依赖：** Run 类型/仓储/调度、授权、受控委派工具及结果展示；依赖 I-04/06/07/08。累计预算未能约束子任务时，不开放相应自主委派。

**完成标准：** 子任务不能扩大权限、绕过总预算或在父任务取消后持续产生新动作；循环委派有界；子任务失败不会被父任务汇总成无依据的成功。

### I-13 按需支持无 Session 的任务入口

**启动条件：** 有独立 API/事件执行需求，且现有独立 Session 无法满足；不是 Agent 规范整理的必做重构。

**具体实施：** 先盘点 Run 创建、Manifest、授权、结果投影、SSE、成果归属及数据库外键对 Session 的依赖；定义可信触发来源、幂等键、发起人与执行身份、Workspace 或其他获准资源归属。通过版本化迁移增加不依赖对话的任务/结果接口和独立访问授权；不把 `session_id` 改为可空后跳过原有授权，也不伪造员工聊天记录。

**改动范围与依赖：** Run、Runtime 契约、HTTP 接入、内容服务及数据库；依赖 I-03/04/06/08。员工/管理对话和 AG-03 独立 Session 仍属受支持业务入口，统一适配新契约，不维护旧 API 兼容层。

**完成标准：** 相同事件重复投递只受理一次；无 Session 结果与成果有明确归属且不可跨用户读取；会话路径回归通过；触发入口变化不产生第二套 Agent Loop。

### 4.3 各实施包的统一交付要求

每项落地时更新对应源码、类型/Schema、必要迁移、API 消费者、相关文档及行为验证；新表/字段命名在实现设计中确定。涉及关键前端旅程先登记 E2E 验收并完成浏览器预演，再固化 spec；UI 实现遵循管理端或员工端对应规范。

验收记录至少包含工作项编号、代码版本、改动范围、新契约生产者/消费者一致性及必要结构变更结果、实际运行的测试及环境、未覆盖项和真实验收状态。已通过检查只在后续变更影响它时重跑；只有相关证据齐备才将工作项改为完成。新增外部写入、身份类型或执行引擎能力超出已确认范围时，先完成具体设计评审。

## 5. 本轮验证范围

文档整理轮（差异清单与规范建立）仅更新 Markdown 文档及入口：`pnpm verify` 的 project/contracts/runtime/security/team-workspace-1a 静态检查通过，`pnpm check:architecture` 通过，`git diff --check` 通过。链接核验中发现自动任务 P1 spec 只是计划路径，已改为引用实际 P0 spec 并明确 P1 缺口。

实施轮在此基础上完成 I-01 与 I-02：I-01 验证 `pnpm test:runtime` 59/59、`pnpm test:skill-install` 9/9、`tsc --noEmit`、`pnpm verify`、`pnpm check:architecture`、eslint 通过；I-02 验证 `pnpm test:agent-package` 35/35、发布治理集成 `17/17`（专用可丢弃 PostgreSQL）、`pnpm typecheck`、`pnpm verify`、`pnpm check:architecture`、改动文件 eslint 通过。各工作项完成记录保留在对应条目。

以上为原实施记录，未包含浏览器 E2E 或真实 DSH/OIDC 验收；表中的测试链接不声明本清单外条目已通过。I-01/I-02 实现已包含于本次读取的提交 `4346633`，本次未核对其推送或发布状态。

2026-09-20 本轮仅更新“不考虑历史兼容”的设计范围、五个实施包及对应验收要求；未修改业务代码或删除数据，未重跑上述功能测试。文档检查结果见本次交付记录，本轮文档改动未提交。

B-01 实施轮（同日随后）：`agent-package.test.ts` 67/67、发布治理集成 17/17（专用可丢弃 PostgreSQL）、server/workbench-web/admin-web `tsc --noEmit` 通过；限额字段更名涉及的原生 SQL 夹具已同步。未跑浏览器 E2E 与真实 DSH/OIDC 验收；模型能力要求暂无运行时消费方。
