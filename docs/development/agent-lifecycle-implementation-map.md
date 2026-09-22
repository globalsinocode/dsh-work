# Agent 全生命周期实现映射

**状态：** 当前平台实现与[通用 Agent 全生命周期模板](agent-lifecycle-template.md)的核对基线。  
**代码基线：** 与本文件所在提交一致。
**用途：** 说明每个阶段由什么对象承载、哪里执行门禁，以及仍有哪些真实缺口；不把目标设计描述成已支持能力。

## 1. 映射结论

通用主流程已经有一条连续的实现路径。第 1～3 阶段是进入平台配置前的设计记录；第 4～9 阶段由 AgentSpec、能力版本、Binding、发布候选、Run/Attempt 和 `task-result/v1` 承载；第 10～11 阶段由审计、不可变版本、重新发布和停用承载。

第 1～3 阶段不新增数据库状态，也不在 AgentSpec 中增加 MCP、持久化等待、记忆、委派和无 Session 入口的空开关。平台按差异清单 PF-01～PF-07 建设通用实现；具体 Agent 只有扩展触发条件成立时，才声明对应依赖、权限和验收。

## 2. 阶段与实现入口

| 阶段 | 权威对象或记录 | 当前实现入口 | 已执行门禁与证据 | 状态与下一步 |
| --- | --- | --- | --- | --- |
| 1. 工作定义 | 每个 Agent 的生命周期设计记录 | [生命周期模板](agent-lifecycle-template.md)第 2 节 | 目标、范围外事项和完成判据进入评审；运行配置不承载设计理由 | **流程已定义**。具体 Agent 在进入配置前复制记录 |
| 2. 能力分解 | 设计记录；随后固化为 Skill、Tool 和业务服务契约 | Skill/Tool 治理服务、`AgentSpec.capabilities` | 能力版本独立发布；Agent 只引用精确版本 | **已实现基础对象**。能力清单仍由 Agent 负责人填写 |
| 3. 扩展判定 | 设计记录中的逐项决定 | 生命周期模板第 4 节 | 没有触发事实时不进入实现和发布声明 | **流程已定义**。不新增空字段或预建服务 |
| 4. AgentSpec 定义 | 规范化 `AgentSpec` 和不可变 Agent Version | [`agent-spec.ts`](../../server/src/modules/agent/agent-spec.ts)、[`agent-package.ts`](../../server/src/modules/agent/agent-package.ts)、[包 Schema](agent-package.schema.json) | 唯一分层包格式；严格 Schema、路径、摘要、精确依赖和受管字段检查 | **已实现**。配置入口与 ZIP 入口归一化到同一对象 |
| 5. 能力准入与绑定 | 已发布 Skill/Tool Version、`tool_binding_revisions` 与 MCP Connector/Profile | Agent、Skill、Tool/Connector 服务与 Runtime 快照 | 平台 Tool 固定精确版本及绑定修订；MCP 能力快照自动生效并默认对全部 Agent 可用，Attempt 固定清单摘要并复核当前状态 | **已实现基础链路**。MCP 不生成 Tool Version/Binding，也不耦合 Agent 发布；真实外部服务仍需 P2 |
| 6. 评测设计 | `AgentEvaluationSuite v1` | [评测模板](agent-evaluation-template.yaml)、包解析器、发布服务 | 五类案例、固定机器断言和必需人工 rubric | **已实现契约**。平台生成案例必须替换为具体 Agent 的目标输入 |
| 7. 候选检查与试运行 | `agent_release_submissions`、`agent_trial_runs`、Run/Attempt | 发布服务、发布路由、管理端发布工作台 | 固定候选修订与 Binding；统一 Runtime Adapter → DSH；逐项机器和人工判定；旧证据失效 | **已实现**。真实 DSH 结果属于具体 Agent 的 P2 |
| 8. 审核与发布 | 不可变 Agent Version、Submission、`agent_version_evidence` | 发布服务与管理端发布工作台 | 职责分离、发布事务内复核定义/绑定/试运行证据 | **已实现**。人工批准不覆盖失败的机器断言 |
| 9. 运行与结果 | Task、可选 Session、Run、Attempt、Runtime Manifest、`task-result/v1` | Task/API 入口、Run 编排、DSH Adapter、当前授权、结果投影 | 执行前/中/提交前重新鉴权；执行终态与业务结果分离；Artifact/回执缺失时不标记达成 | **已实现基础链路**。具体业务完成仍需 Agent rubric 或工具证据 |
| 10. 监控与演进 | Run/Event/工具审计、版本和发布证据、重新分叉的草稿 | 管理端治理视图、审计与版本服务 | 定义、依赖、Binding 或 Runtime 变化创建新候选并重做受影响证据 | **基础可用**。跨版本质量和成本趋势聚合是后续可选运维能力，不阻塞通用流程 |
| 11. 停用与退役 | Agent `disabled` 状态、不可变历史、自动任务和 Binding 状态 | Agent 状态服务、执行授权、自动任务与 Tool 治理 | 停用后阻止新执行；撤销 Binding；有权用户仍可读取既有审计与结果 | **已实现停用语义**。当前不提供删除不可变版本和审计的“硬退役” |

## 3. 对象边界

| 信息 | 应放位置 | 不应放位置 |
| --- | --- | --- |
| 为什么创建、哪些扩展不启用 | Agent 生命周期设计记录 | AgentSpec 空开关、数据库占位状态 |
| Agent 如何工作 | AgentSpec、Prompt、Skill、Tool 引用 | 平台全局 Prompt 或场景专属 Agent Loop |
| 在哪里、以谁的身份执行 | Binding、平台策略和当前身份 | Agent 包中的端点、凭据或角色授权 |
| 某次执行发生了什么 | Run、Attempt、事件、工具审计、Artifact | Agent Version 可变字段 |
| 是否取得可核验结果 | `task-result/v1`、回执、Artifact、人工 rubric | 模型自述或试运行 `succeeded` 状态 |
| 跨天业务进度 | 权威业务系统或业务台账 | Session 历史、Agent 记忆或 Attempt 检查点 |

## 4. 当前确认的实施范围

本轮用[通用文本整理助手参考记录](reference-agent-lifecycle-record.md)和其受版本控制的 Agent 包验证第 1～6 阶段的交付物能够落到现行严格契约。该参考包不声明外部能力，也不伪造 Binding、发布、Run/Attempt 或 P2 证据。

以下项目已进入平台 PF-01～PF-07 建设计划，但对具体 Agent 仍保持条件触发：

- MCP Streamable HTTP Server 登记、整体发现与自动生效、全部 Agent 默认可用、DSH 调用和 Tool 级审计（PF-03 代码级已完成，真实服务 P2 待 PF-07）；
- 跨 Attempt 的持久化等待状态机；
- 跨 Session 受控记忆；
- Agent 委派及父子预算；
- 跨版本质量或成本趋势聚合。

平台建设顺序和完成门槛以[差异清单](agent-design-gap-analysis.md)第 4.2 节为准。在 PF-07 完成前，这些项目仍是目标能力，不能作为 Agent 已可使用的现行能力。已有 P2 被报告为手工执行，但环境、版本、Run/Attempt、验收人和限制尚未写入仓库；在这些字段归档前，其仓库状态仍是“已执行，证据待归档”。

PF-01 已完成平台基础实现：Task 可由 Session、API 或事件来源幂等受理；无 Session 执行使用同一 Run/Attempt、Runtime Adapter 与 DSH；Manifest、结果和 Artifact 固定 Task 归属；写入平台工具自动登记 Operation，并区分同步完成、异步受理、失败和效果未知；员工端提供受权的 Task/Operation 查询、取消和重试，管理员可在核对权威外部状态后收敛 Operation。

PF-03 已完成代码级平台实现：管理员在现有 Connector 模块登记 Streamable HTTP MCP Server，发现完整 Tools 后自动固定并生效当前摘要；健康且能力快照已同步的 Connector 默认对全部 Agent 可用，不建立 Agent→Connector Grant，也不进入 Agent Version/发布链路；已准备 Attempt 的摘要漂移、停用或删除会在活动复核和调用解析处拒绝；新 Attempt 使用检查后自动生效的最新摘要；DSH 通过每 Attempt Patch 装载当前可用连接并按 Server 命名空间放行；调用审计仍细化到实际 MCP Tool。MCP 不生成平台 Tool Version/Binding。真实批准服务、真实凭据、目标 DSH 和停用/删除演练仍在 PF-07 留存 P2 证据。
