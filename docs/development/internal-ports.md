# 内部端口与契约

两个前端只调用各自 API；服务端通过明确的接口协作。下表链接实际类型和实现，避免维护与源码不一致的伪接口副本。

Agent 通用设计与评审要求见 [Agent 设计规范](agent-design-standard.md)；现有类型、Schema 与目标规范的差异见[实现核对](agent-design-gap-analysis.md)。目标字段须经过契约及消费者迁移，不能仅据规范文字直接调用。

| 边界 | 权威来源 | 约束 |
| --- | --- | --- |
| Runtime 启动、取消、事件、健康与关闭 | [AgentRuntimePort](../../server/src/modules/runtime/runtime-types.ts) | 一个 Attempt 一个隔离 Worker；DSH 版本由 Runtime Lock 决定 |
| Run、Attempt、事件与重启恢复 | [RunRepository](../../server/src/modules/run/run-repository.ts) | 租户隔离、幂等、终态不可回退；事件先落库后发送 |
| Task、触发来源、累计预算与外部操作回执 | [TaskRepository](../../server/src/modules/task/task-repository.ts)、[主体迁移 0065](../../server/migrations/0065_task_principal_identity.sql) | Task 关联键和操作键租户内幂等；发起 Principal 由平台推导，首个 Attempt 固定执行 Principal，重试不能更换；任务级批准主体预留为空，动作批准仍以各自记录为准。预算账户固定范围与可执行上限，Attempt 原子预占、终态只结算一次；API/event 请求摘要与外部动作参数摘要固定；`unknown` 必须查询实际效果后才能收敛为完成或失败；不以 Run 成功代替外部操作完成 |
| 模型 Provider、路由与凭据引用 | [ModelGovernanceRepository](../../server/src/modules/model/model-governance-repository.ts) | Attempt 固定路由快照；Agent 不单独配置模型策略 |
| 凭据存储 | [SecretStorePort](../../server/src/modules/model/secret-store-port.ts)、[PostgresEncryptedCredentialStore](../../server/src/modules/tool/postgres-encrypted-credential-store.ts) | 模型 Provider 继续使用外部引用；MCP Bearer Token 以 AES-256-GCM 密文存入 PostgreSQL，主密钥由服务环境提供，明文只在受控运行时解析 |
| 身份与本地授权上下文 | [RequestIdentity](../../server/src/modules/identity/types.ts) | 用户、角色、数据范围和操作人只从服务端产生 |
| Agent 独立执行身份（AE-02） | [迁移 0064～0069](../../server/migrations/0064_execution_principals.sql)、[Agent 服务](../../server/src/modules/agent/postgres-agent-service.ts)与[授权服务](../../server/src/modules/authorization/postgres-authorization-service.ts) | human/agent/system Principal 分库存储；执行授权与治理负责人及可见角色分离，新 Agent 未显式授权时不可执行。Task/Manifest 固定发起、执行及披露身份；工具、审批和审计标记执行者，当前授权在执行边界复核。`requested_by` 始终是人类请求者；已完成结果仍按当前人类/Workspace ACL 读取 |
| 对象与执行授权 | [PostgresAuthorizationService](../../server/src/modules/authorization/postgres-authorization-service.ts) | Workspace、Agent/Skill/Tool Version 与数据范围逐层校验，默认拒绝 |
| Skill 安装计划 | [AdminSkillInstallationService](../../server/src/modules/skill/admin-skill-installation-service.ts) | 固定来源、生成依赖计划、绑定管理员确认、原子保存草稿并记录激活/脚本试运行证据；C7 prepareLink 无 Run，确定性导入与助手共用平台实现，发布能力独立复核 |
| 通用管理对话与任务调度 | [AdminAssistantService](../../server/src/modules/admin/application/admin-assistant-service.ts) | 通过 DSH 进行普通对话；已有草稿展示文案允许一次最终确认，其他变更绑定委派确认与最终计划确认；行锁内版本复核及重启结果收敛不变 |
| dsh-work 内置执行/平台工具 | [platform-tool-bridge](../../server/src/modules/runtime/platform-tool-bridge.ts)、[分类与契约目录](../../server/src/modules/runtime/platform-tool-contracts.ts) | 执行工具由 Manifest 声明，平台工具按 Run purpose 注入；为当前 Attempt 暴露显式授权处理器，严格校验输入/输出、当前授权、超时、输出大小和串行约束；不进入普通 Tool Binding，不承载 Agent Loop |
| MCP Connector 治理与执行 | [PostgresToolConnectorService](../../server/src/modules/tool/postgres-tool-connector-service.ts)、[AgentRuntimePort](../../server/src/modules/runtime/runtime-types.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | 复用 Connector 管理；Streamable HTTP Server 整体发现并自动生效，健康且能力快照已同步的 Connector 默认对全部 Agent 可用；Attempt 固定能力摘要并复核当前状态；凭据值只进入 Worker 环境，实际调用由 DSH 执行并按 MCP Tool 留审计；不创建平台 Tool Version/Binding |
| 持久化等待与动作审批 | [PostgresPersistentWaitService](../../server/src/modules/run/postgres-persistent-wait-service.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | DSH 权限请求绑定动作、精确参数与摘要、资源、执行身份、数据版本和有效期；检查点有界保存此前工具结果、输出工作文件和未提交部分回答，当前 Attempt 进入 waiting 并释放 Worker。批准先复核当前授权、检查点完整性、有效期与未知副作用，再从不可变检查点创建新 Attempt；重复决定、迟到旧 Attempt、拒绝、超时、撤权和取消均收敛到持久化事实及终态事件。 |
| 受控记忆与经验 | [PostgresControlledMemoryService](../../server/src/modules/memory/postgres-controlled-memory-service.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | 员工只能从本人成功 Attempt 主动提交稳定偏好或经验候选，并明确选择使用范围和可使用期限；提交幂等摘要固定来源 Attempt、类型、内容、范围和保留期，同键并发在事务内串行。管理员审核后创建独立不可变版本。新 Attempt 按当前用户、空间、来源空间当前授权、当前角色与 Attempt 快照角色的交集及精确 Agent Version 检索；“仅本人”记忆只进入本人的个人空间。Manifest 固定版本与摘要，Runtime 标记为非权威参考。审核、领取、运行与等待恢复复核来源授权、版本和来源同意；撤回、来源撤权或到期立即阻止未来使用，管理查询和审核重放不再返回正文，历史摘要、审核和实际引用按企业内容保留规则继续可追溯。 |
| 受控 Agent 委派 | [PostgresAgentDelegationService](../../server/src/modules/run/postgres-agent-delegation-service.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | `delegate_agent` 是 dsh-work 内置执行工具，只在 Agent Version 配置精确已发布目标时进入 Manifest。服务锁定活动父 Run，按父 Attempt + 请求摘要幂等创建无 Session 子 Task/Run；子 Task 共用根预算范围，授权为目标当前授权与父角色/数据快照上限交集，团队空间要求目标 Agent 当前成员关系。深度、并行、超时有界；受理和 Attempt 领取在 Runtime 行锁下计算当前占用并预留同步子任务席位；普通任务因预留而领取失败时调度泵继续扫描后续子任务。委派 Task 禁止通用重试，父任务终止递归取消，启动恢复对账遗留关系。子任务仍走统一 DSH 链路；`task-result/v1` 只有在全部必要回执均完成时才允许 `achieved`，未解决回执保持 `unverified`，失败回执、运行失败或取消为 `not_achieved`；父 Task 的委派工具回执仅为 `accepted`。 |

## API 与运行契约

- [Workbench OpenAPI](openapi-workbench.json)：`/api/workbench/v1`。
- [Admin OpenAPI](openapi-admin.json)：`/api/admin/v1`。
- [Runtime Manifest](runtime-manifest.schema.json)：不可变输入、能力、文件、知识与权限快照。
- [Run Event](run-event.schema.json)：标准可展示事件，不包含隐藏推理和凭据。

接口修改必须同步消费者、Schema 和相应测试。公开 API、内部 TypeScript 类型和 DSH ACP 是不同边界，不应直接复用上游内部对象代替产品契约。

`GET /tools`、`GET /tools/catalog` 与 `GET /tools/bindings` 是 DSH 内置工具的管理边界，只返回稳定 Connector `connector-dsh-workspace` 下的记录。dsh-work 内置执行/平台工具由代码契约目录管理；MCP 外部工具由 Connector 的自动生效发现快照、健康状态和能力摘要门禁管理，二者均不写入普通工具列表。

`GET /connectors` 是 MCP 管理边界，只返回外部 MCP Connector。平台稳定连接 `connector-dsh-workspace` 通过 `GET /runtimes/dsh-tool-connector` 在 Runtime 运维详情中只读展示，检查使用 `POST /runtimes/dsh-tool-connector/check`；不得从 MCP 页面为其提供新增、Token 或删除操作。租户当前可用的外部 MCP Connector 最多 20 个；登记、重新启用和检查恢复健康共用租户级事务锁及容量门禁，保证解析给任一 Agent Version 的集合不会超过 Runtime Manifest 上限。

DSH Tool Version 持久化 `outputValidation`、`retryPolicy`、`concurrencyPolicy` 和 `completionSemantics`。dsh-work 内置执行/平台工具由契约目录编译严格 JSON Schema，并在 Unix socket 桥两侧执行校验；DSH 包装器对非 2xx 响应抛出错误，不把错误正文当成成功结果。由于 DSH ToolRuntime 对普通 `Error` 只保留 `message`，包装器同时把 `code/retryable/effect_state` 以 `DSH_WORK_TOOL_ERROR` 前缀投影到模型可见消息，并保留同名属性供直接调用方使用。DSH 原生文件/任务工具的输入由 DSH 与平台路径策略约束，但结构化输出尚未穿过平台验证边界，目录明确发布 `outputValidation=unavailable` 及不可验证标记 Schema。提升验证级别前须接通实际输出校验，不能只修改目录字段。

平台桥错误外层为 `error.code/message/retryable/effect_state`。处理器在任何写入前发现的参数或业务前置条件失败必须抛出有类型错误，才能保留可纠正消息和 `not_started`；未标记的写入处理器异常保守记为 `TOOL_RESULT_UNKNOWN`。只读安全工具超时可标记重试；写入超时、取消或执行后冲突按契约表达未知效果。`serialized` 表示同一 Attempt 内同名工具不允许重叠执行，冲突在第二个处理器启动前返回。写入平台工具按 Task 自动登记 Operation：`completionSemantics=completed` 落完成回执，`accepted` 保留异步受理状态，超时或执行后无法确认落 `unknown`；重复动作不会再次进入处理器。

PF-01 的 Task/Operation 仓储提供外部动作的持久化事实：`operation_key` 防止同一 Task 重复受理，`parameter_digest` 防止同键换参，`accepted/completed/failed/unknown` 区分受理、完成、失败和效果未知。`unknown` 不是失败或可安全重试的同义词，只能由平台管理员依据权威外部状态核对转为 `completed` 或 `failed`。`POST /task-executions` 受理无 Session 的 API/event Task，查询、取消和重试接口沿用现有 Run/Attempt/Runtime Adapter/DSH；Runtime Manifest 固定 `task_id`，Artifact 可归属 Task 并按当前 Workspace 与 Task 所有人重新鉴权。

PF-02 的预算账户以 `tasks.budget_scope_task_id` 标识共享范围；根 Task 指向自身，PF-06 子 Task 显式指向根范围。`task_budget_accounts` 保存累计时长、工具次数和输出字节上限，`attempt_budget_usage` 保存每次预占、结算/释放、测量来源与终态。`RunRepository.createAttempt` 在同一事务锁定账户、汇总已结算与活动预占并拒绝超额；Runtime 终态事件在状态转换前精确结算，数据库触发器为取消、重启和异常路径提供一次性保守兜底。Runtime Manifest 的 `budget` 快照必须与 Task 账户及 `limits` 一致。

`cumulativeBudget` 可用于会话 Run 与无 Session Task；自动任务既有 `inputTemplate.budget` 同时固定为该次 Task 的累计上限并收紧单 Attempt limits。时长、工具和输出字节为 hard；Token 只接受 Runtime 完整上报，缺失时返回 `unavailable` 和 null，不从文本估算；成本保持 unavailable。`maxTokens`、`maxCostAmount`/`costCurrency` 返回 422 `TASK_BUDGET_UNSUPPORTED`，超出剩余额度返回 409 `TASK_BUDGET_EXCEEDED`。

PF-03 的 MCP 契约使用现有 Connector 作为配置、健康、启停和删除入口，`mcp_connector_profiles` 保存平台生成的 Server 命名空间、发现快照及当前生效摘要。新增页面先调用不落库的连通测试；正式登记必须再次通过 DSH 发现至少一个 Tool，成功后才在一个事务中保存 Connector、能力快照和可选凭据，客户端不能提交“测试通过”标记绕过复核。健康且能力快照已同步的 Connector 默认对租户内全部 Agent 可用，不建立 Agent→Connector 或逐 Tool Grant。`credential_secrets` 保存由 `DSH_CREDENTIAL_MASTER_KEY` 加密的 Bearer Token 密文、随机 nonce、认证标签及密钥版本；查询接口只返回“已加密存储”或“需要重新录入”状态。旧 `dsh-managed` 引用保留 Connector 并降级，重新录入时为目标 Connector 建立新的独立凭据引用；历史上共享同一引用的其他 Connector 不受本次 Token 变化影响。Runtime Manifest 的 `mcp_connections` 只固定连接标识、公开端点、认证类型及能力摘要，不包含密钥；执行前和活动期以当前 Connector 状态及摘要重新校验。服务端按凭据 ID 解密 Token，并以环境变量注入每 Attempt DSH MCP Patch；DSH 策略只放行当前 Attempt 固定的 `mcp__<serverName>__*` 命名空间。轮换覆盖独占密文并递增版本，人工停用状态保持不变；发现写回事务先锁 Connector，再独立读取最新凭据版本，旧版本结果不得改变 Connector 或能力快照。删除采用受控软删除：所有 Agent 后续解析立即移除该 Connector，活动 Binding 撤销、关联 Tool 停用、独占密文删除；Connector/Profile/健康检查及 `mcp_invocation_audits` 保留，所有活动查询和 Runtime 解析过滤 `deleted_at`。`mcp_invocation_audits` 记录实际 Tool 名、参数摘要、Run/Attempt 和结果。当前只支持 Streamable HTTP Tools；Resources、Prompts 与 stdio 明确不可用。

PF-04 使用 `waiting` 作为 Run 的非终态等待状态和来源 Attempt 的不可恢复终态。`run_checkpoints` 固定来源 Attempt、Manifest 摘要、Runtime 版本、恢复策略、关联键、有效期及有界恢复上下文；上下文包含精确待执行参数、已完成工具结果、输出工作文件和未提交部分回答，并以独立摘要校验。DSH 兼容协议只传工具调用 ID 时，Adapter 从 Attempt 外的可信策略日志取得原始参数并核对摘要；`approval_mode=never` 不捕获恢复检查点。审批先以内部 `preparing` 保存，只有收到 `run.waiting` 后才与 Run、Attempt 的等待状态在同一事务中转为管理端可见的 `pending`。来源 Attempt 在此之前终止时立即取消准备中审批及活动检查点；创建新审批也会清理被当前 Attempt 取代的遗留记录。DSH 没有恢复原 ACP Session 的安全接口，因此平台不声称恢复原 Worker：等待时关闭 Worker，批准后重新校验输入、Agent/工具/MCP 绑定、当前身份授权、检查点完整性及批准有效期，再以 Manifest `resume` 创建新 Attempt、恢复工作文件并向 DSH 提供续办上下文；输出路径允许安全 Unicode 文件名，同时拒绝遍历、控制字符和反斜杠。相同决定与相同 `resolutionKey` 幂等返回；相反决定或不同键返回 `APPROVAL_CONFLICT`。同一审批只消费一个检查点且批准过期后不能消费动作，过期处理只可终止仍为当前来源 Attempt 的 Run；新参数或数据版本重新申请。来源 Attempt 存在 `unknown` 外部操作时拒绝恢复，须先按 PF-01 查询权威系统并收敛回执。等待 Run 会阻止 Session/Workspace 归档，服务重启保留等待事实；审批超时扫描、人工拒绝、用户取消与系统撤权均写入终态事件并结束等待。

员工与管理端 Agent 均通过同一 Run/Attempt、AgentRuntimePort 和 DSH 适配链路执行，不能通过新增 API、Gateway 或业务服务另建直接调用模型的 Agent Loop。职责与评审要求见 [架构总览：Agent 执行引擎统一](overview.md)。

## 运行与恢复规则

- 使用稳定事件 ID，按持久化的全 Run 顺序支持 `Last-Event-ID` 续传；不能仅按单 Attempt 序号恢复整个 Run。
- Token、Tool 和计量信息来自受控 Session 日志/Telemetry 投影，不从回答文本猜测，不直接导出未经脱敏的运行轨迹；PF-02 缺少完整 Token 回报时明确返回 unavailable。
- 取消和重启须收敛到确定终态；重试新增 Attempt，旧事件不得覆盖当前 Attempt。
- 文件路径使用受控存储键；输入只读、成果显式收集，下载重新鉴权。
- 业务角色与数据范围留在本地；AI Hub 专用协议仅进入身份模块，外部身份变化不覆盖本地授权历史。

具体运行环境见 [Runtime 指南](../release/dsh-runtime-delivery.md)，验证命令见 [开发与测试](development.md)。

## 执行能力故障隔离（C9）

Runtime 端口的可选 `assertAvailable(manifest?)` 在受理、编译与恢复队列时检查能力。`UnavailableRuntime` 仅抛出 503 `RUNTIME_UNAVAILABLE`，不提供 Mock、模型调用、事件或回答。`CapabilityGuardedRuntime` 只委托既有 DSH 适配器，不维护 Agent Loop；Python 预检失败只拒绝显式依赖 `python_execute` 的任务。

Agent 的额外模型要求通过 `assertModelRequirements(requirements, target)` 校验；`target` 为平台固定的 Provider 标识、模型标识与端点。端口必须校验实际执行目标和可保证的能力，不能只转述目录标签；未实现端口而要求非空时，平台按 503 `MODEL_CAPABILITY_UNAVAILABLE` 拒绝。DSH Adapter 当前固定 Profile 没有可验证的长上下文容量与结构化输出约束，因此拒绝两种额外要求，在直接执行及恢复时保持此边界。模型目录缺少要求时返回 422 `MODEL_CAPABILITY_MISMATCH`。无额外要求的 Agent 不受此限制；平台不自动切换路由。

`RuntimeAgentSnapshot.modelRequirements` 来自版本定义；员工/自动任务/发布试运行将其写入 `RuntimeManifest.model_requirements`，并将 `modelCapabilities` 固定到 `ModelRouteSnapshot`。Schema 与编译器只接受不重复的 `long-context`/`structured-output` 名称；省略字段仅表示没有额外要求。准备失败不创建 Attempt，并收敛无 Attempt 的 Run；恢复队列复核固定目标失败时终止既有 Attempt，记录稳定错误码。

`/health/live` 表示进程存活；`/health/ready` 验证核心数据库可达，并报告启动时校验的身份配置与各执行能力状态。DSH/Python 预检失败不否定核心就绪；DB/身份初始化失败仍不监听。就绪不代表实时 OIDC/模型业务联调通过。修复执行配置后需重启重探，不提供自动回退。`/health` 新增 `executionCapabilities`；其 `dshRuntime` 使用 RuntimeHealth 的状态，不再把未连接写成 connected。

发布脚本的严格 DSH 预检保持不变；核心就绪不能替代上线前的真实执行验收。

## 首次管理员认领意图（C10）

`GET /auth/admin/bootstrap` 是显式首次认领入口，默认关闭，仅全新安装临时开放。普通登录与刷新仅要求基础身份 Scope；认领 Scope 从不成为持续登录条件。`oidc_login_transactions.login_purpose` 由服务端写入并在回调时消费，不能从回调参数读取。初始化是否已消费只查询应用/环境账本，不计数当前管理员。新迁移为 `0042_oidc_login_bootstrap_intent.sql`，保留全部旧认领和身份数据。

## 场景试运行契约

管理端既有测试接口可选传入 `scenario`，平台验证后固定为 Manifest `test_scenario`；只允许 `admin-skill-test` 使用。默认调用不改变严格策略。场景级验证结果使用 `scenario-v1` 证据策略，发布需要当前配置下的完整能力覆盖；不得将部分场景证据标成完整严格测试。请求例子、断言支持范围和迁移说明见 [Skill 场景试运行](skill-scenario-trials.md)。

## 个人历史（B3）

`PostgresConversationRepository.listSessionsForUser()` 为本人历史入口，Session 去重与授权过滤均在 SQL 中完成。默认只读个人范围，`scope=all` 包含本人仍可读团队会话。`getSessionForUser` 共用该查询；旧 Run、团队共享会话入口不被替代。`readableWorkspacePredicate` 是空间行别名 `w` 的公共 SQL 权限片段，不替代 HTTP 层身份与功能鉴权。完整字段以 Workbench OpenAPI 与类型定义为准。

## 我的文件（B4）

`PostgresContentService.listPersonalFiles/getPersonalFile` 统一查询本人默认工作区内的资料、会话附件和成果版本；仍以 file_objects 为不可变对象，来源由关联投影。新 `/files` 上传不接收 Workspace 目标。`DELETE /files/:fileId` 是逻辑移除，旧下载路径和 Runtime 输入检查仍复用原鉴权。没有独立文件库或新的执行路径。

## 内容生命周期（B5）

`archiveSession` 保留旧方法和 `archived` 字段，但产品语义为从历史移除，不物理删除。公共读取策略及账号停用语义见 [个人内容生命周期](personal-content-lifecycle.md)；`/content-policy` 返回固定策略版本。团队归档只读与个人移除不混用。

## 管理助手低风险确认（C6）

风险白名单、判定位置、旧计划兼容与证据见 [C6](review-c6-evidence.md)。仅现存 Agent 草稿的四个展示字段可由通用助手直接生成计划；systemPrompt、权限、发布、Runtime 仍走两次确认。`confirmationMode` 是服务端计划的只读投影，不接受调用方传入。
