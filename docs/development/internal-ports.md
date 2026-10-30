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
| Agent 独立执行身份（AE-02） | [迁移 0064～0069](../../server/migrations/0064_execution_principals.sql)、[Agent 服务](../../server/src/modules/agent/postgres-agent-service.ts)与[授权服务](../../server/src/modules/authorization/postgres-authorization-service.ts) | human/agent/system Principal 分库存储；执行授权与治理负责人及可见角色分离，新 Agent 有基础运行资格，业务角色与平台数据范围须显式授权。默认策略下路径参数逐次受控、仅限当前隔离 Run 工作区的 DSH 基础文件工具无需 Agent 业务授权；挂载输入、企业数据和收紧后的工具策略仍受当前授权约束。Task/Manifest 固定发起、执行及披露身份；工具、审批和审计标记执行者，当前授权在执行边界复核。`requested_by` 始终是人类请求者；已完成结果仍按当前人类/Workspace ACL 读取 |
| Agent 数据平面（AE-03） | [迁移 0072](../../server/migrations/0072_agent_data_plane.sql)、[受控数据服务](../../server/src/modules/agent-data/postgres-agent-data-service.ts)、[管理 API](../../server/src/http/admin/agent-data-routes.ts)、[开发者契约](agent-data-plane.md) | 固定通用表与安装实例；AgentSpec 声明经发布检查后才在 DSH Bridge 注入状态/记录工具，集合与 Grant 由管理员治理；不可变版本、提案审核、状态转换、保留删除及 `task-result/v1` 记录引用已接通。真实 DSH/OIDC P2 尚未留证 |
| Agent 主动任务（AE-05） | [迁移 0074](../../server/migrations/0074_agent_owned_routines.sql)、[规则服务](../../server/src/modules/automation/agent-routine-service.ts)、[管理与接收路由](../../server/src/http/admin/agent-routine-routes.ts) | Agent Principal 拥有独立 routine，批准时固定版本、Workspace、输入、预算与授权上限；调度器复用现有所有者锁，受理时创建无 Session Task/Run/Attempt 并由 DSH 执行。执行记录持久化去重键、触发来源、跳过原因与结果投影，按原 Task 固定的接收人和 Workspace 及当前空间授权读取历史回答；活动期复核停用和收权，通用重试不接受主动任务来源。外部事件生产者、真实 DSH/OIDC 和通知仍需独立验收 |
| 对象与执行授权 | [PostgresAuthorizationService](../../server/src/modules/authorization/postgres-authorization-service.ts) | Workspace、Agent/Skill/Tool Version 与数据范围逐层校验，默认拒绝 |
| Skill 安装计划 | [AdminSkillInstallationService](../../server/src/modules/skill/admin-skill-installation-service.ts) | 固定来源、生成依赖计划、绑定管理员确认、原子保存草稿并记录激活/脚本试运行证据；C7 prepareLink 无 Run，确定性导入与助手共用平台实现，发布能力独立复核 |
| 通用管理对话与任务调度 | [AdminAssistantService](../../server/src/modules/admin/application/admin-assistant-service.ts) | 通过 DSH 进行普通对话；已有草稿展示文案允许一次最终确认，其他变更绑定委派确认与最终计划确认；行锁内版本复核及重启结果收敛不变 |
| dsh-work 内置执行/平台工具 | [platform-tool-bridge](../../server/src/modules/runtime/platform-tool-bridge.ts)、[分类与契约目录](../../server/src/modules/runtime/platform-tool-contracts.ts) | 执行工具由 Manifest 声明，平台工具按 Run purpose 注入；为当前 Attempt 暴露显式授权处理器，严格校验输入/输出、当前授权、超时、输出大小和串行约束；不进入普通 Tool Binding，不承载 Agent Loop |
| MCP Connector 治理与执行 | [PostgresToolConnectorService](../../server/src/modules/tool/postgres-tool-connector-service.ts)、[AgentRuntimePort](../../server/src/modules/runtime/runtime-types.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | 复用 Connector 管理；Streamable HTTP Server 整体发现并自动生效，健康且能力快照已同步的 Connector 默认对全部 Agent 可用；Attempt 固定能力摘要并复核当前状态；凭据值只进入 Worker 环境，实际调用由 DSH 执行并按 MCP Tool 留审计；不创建平台 Tool Version/Binding |
| 内置工具注册表 | [builtin-tools](../../server/src/modules/runtime/builtin-tools.ts)、[DSH 工具策略](../../server/config/dsh/dsh-work-tool-policy.js) | DSH 原生工具与 dsh-work 平台工具的唯一来源，随代码发布：名称、来源、读写效果、风险、装配方式（默认、Agent 开启、按运行内容、按管理用途、项目空间）与约束。Agent 版本保存联网搜索与项目任务管理开关；Runtime 配置保存紧急停用清单（仅 DSH 工具） |
| dsh-work 平台工具 | [platform-tool-bridge](../../server/src/modules/runtime/platform-tool-bridge.ts)、[契约目录](../../server/src/modules/runtime/platform-tool-contracts.ts)、[项目任务工具](../../server/src/modules/workbench/application/project-task-tools.ts) | 激活 Skill、Python 执行与经验申请按运行内容装配，管理工具按 Run purpose 注入，项目任务工具按团队空间运行场景装配（S6）；为当前 Attempt 暴露显式授权处理器，严格校验输入/输出、当前授权、超时、输出大小和串行约束；不承载 Agent Loop |
| 容器执行（执行隔离 1a/1b/1c） | [ExecutionBackend](../../server/src/modules/runtime/execution-backend.ts)（docker 实现见 [docker-execution-backend](../../server/src/modules/runtime/docker-execution-backend.ts)）、[ContainerExecutor](../../server/src/modules/runtime/container-executor.ts)、[AttemptExecutionContainers](../../server/src/modules/runtime/attempt-execution-containers.ts)、[remote-subprocess-gateway](../../server/src/modules/runtime/remote-subprocess-gateway.ts)、[DSH remote subprocess 插件](../../server/config/dsh/dsh-work-remote-subprocess.js) | 业务服务内唯一调用容器运行时的代码；调用方只传固定字段，容器姿态由后端固定，只运行配置的锁定镜像（成果解析的一次性沙箱须为 `name@sha256:` 仓库摘要；执行镜像另可用本地镜像 ID `sha256:…`）。成果解析沙箱占用独立的 2 个槽位，不传环境变量。执行容器为必需（执行隔离 4.9）：DSH 的 `ctx.subprocess` 经本 Attempt 工具桥的 `/subprocess/exec` 落到该 Attempt 的执行容器：该端点不是 Agent 工具、不计入工具调用次数，每次复核当前授权；`cwd` 须在 Attempt 工作区内（按解析后的真实路径比较），`argv[0]` 只允许 DSH 自带的 ripgrep 并映射为镜像内 `rg`，容器环境变量固定、不转发 DSH 环境；每条命令写入 `run.container.command` 审计（不含输出）。执行容器按 Attempt 惰性创建、Attempt 结束删除，数量受 Runtime 并发上限约束，不占全局槽位。“静止”保证（1c）：可能留下进程的命令（`rg` 以外）以及失败、超时或取消的命令结束后先清扫容器，未确认干净即删除，下次命令再创建；清理完成前 `waitUntilIdle` 为 busy，`/authorize-execution` 先等待空闲（最多 3 秒，超时拒绝本次工具调用），静止无法恢复时 Attempt 以 `EXECUTION_CONTAINER_UNRECOVERABLE` 失败。Attempt 结束时先停止工具桥、等待空闲并删除执行容器再收集成果（任一步失败则 Attempt 失败且不收集），持久化等待的检查点也先等待空闲；检查点读取与成果发布先确认 `output/` 本身是工作区内的真实目录（[workspace-directory](../../server/src/infrastructure/storage/workspace-directory.ts)） |
| Python 执行并入执行容器（执行隔离 1b②） | [ExecutionContainerPythonRunner](../../server/src/modules/runtime/execution-container-python.ts)（含 `resolvePythonCall`） | 镜像含 `python3` 时，`python_execute` 经 `AttemptExecutionContainers.exec` 以 `python3 -I -B <入口>` 在本 Attempt 容器内运行，`cwd` 为 Skill 目录，`env` 只允许 `DSH_SKILL_DIR`/`DSH_INPUT_DIR`/`DSH_OUTPUT_DIR`（绝对路径，后端校验），输出目录为工作区 `output/`，回列本次新增或修改的顶层文件；超时返回 124、平台终止返回 137。没有每次调用一个容器的模式（执行隔离 4.9）。依赖核对：用启动时 `inspectPythonPackages` 读出的包（PEP 503 规范化名称） |
| 工作区容量与回收（执行隔离 4.7） | [workspace-usage](../../server/src/modules/runtime/workspace-usage.ts)、[attempt-workspace-retention](../../server/src/modules/runtime/attempt-workspace-retention.ts)、`AttemptExecutionContainers` | 只计量正在执行命令的 Attempt 自己的工作区（`lstat` 不跟随链接，按已分配块计，超过 5 万项按超限）；命令开始前与执行中检查数据卷剩余空间，不足即拒绝（`EXECUTION_DISK_LOW`）或终止；执行中工作区超过 2 GiB 且高于命令开始时即终止，结果带 `limit` 与固定说明，命令审计同样记录；命令后超过 4 GiB 时 Attempt 以 `EXECUTION_WORKSPACE_LIMIT` 失败。计量或剩余空间检查出错不阻止命令。Adapter 在 Attempt 结束（容器回收之后）写 `attempt-end.json` 并删除非失败 Attempt 的 `workspace/`；`sweepAttemptWorkspaces` 跳过本进程仍在执行的 Attempt，无结束记录的目录按最后修改时间超过 3 天清扫 |
| 二进制成果解析（执行隔离 2b-3） | [ArtifactTextExtractorPort 与容器实现](../../server/src/modules/workbench/application/container-artifact-text-extractor.ts)、[解析脚本](../../server/config/execution/extract_artifact_text.py) | 内容服务发布成果时把一轮的 PDF/DOCX/XLSX/PPTX 交给端口，容器实现经 `ContainerExecutor.runPythonSandbox` 用执行镜像运行平台脚本（Python 沙箱姿态，独立的 2 个槽位，限时 60 秒）；输入为按序号命名的只读副本，运行中输出超过每个输入两个普通文件或字节上限、出现子目录或链接即停止容器并整批记为失败；宿主只读回普通文件（`lstat`，不收链接与硬链接）、校验 UTF-8 与类型、规范化并限 512000 字符。逐文件失败返回固定原因码并记为失败解析；容器本身失败时抛错，内容服务照常发布、不写解析记录，由 `backfillBinaryArtifactExtractions` 在启动后后台补解析。解析器版本 `exec-office-v1`；Run 输入挂载接受 `m4-basic-v1` 与 `exec-office-v1`；未配置端口（执行容器不可用）时二进制成果没有解析文本。预览（2b-5）：成果查询经 [artifact-text-preview](../../server/src/modules/workbench/application/artifact-text-preview.ts) 对 Office/PDF 返回 `textPreview`/`textPreviewError`，`readArtifactText` 先按下载口径鉴权（`artifactFileId`），再读最新解析记录并按摘要校验文本 |
| MCP Connector 治理与执行 | [PostgresMcpConnectorService](../../server/src/modules/tool/postgres-mcp-connector-service.ts)（`McpScopePort`）、[AgentRuntimePort](../../server/src/modules/runtime/runtime-types.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | 复用 Connector 管理；Streamable HTTP Server 整体发现，登记时的清单即生效，之后新增或输入 Schema 变化的 Tool 须管理员确认；Agent Version 显式选择 Connector（`selected`/`none`）；Attempt 固定生效清单摘要并复核当前状态；调用方传入使用范围，MCP 模块不读取 Agent 表；凭据值只进入 Worker 环境，实际调用由 DSH 执行并按 MCP Tool 留审计；不进入内置工具注册表 |
| 持久化等待与动作审批 | [PostgresPersistentWaitService](../../server/src/modules/run/postgres-persistent-wait-service.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | DSH 权限请求绑定动作、精确参数与摘要、资源、执行身份、数据版本和有效期；检查点有界保存此前工具结果、输出工作文件和未提交部分回答，当前 Attempt 进入 waiting 并释放 Worker。批准先复核当前授权、检查点完整性、有效期与未知副作用，再从不可变检查点创建新 Attempt；重复决定、迟到旧 Attempt、拒绝、超时、撤权和取消均收敛到持久化事实及终态事件。 |
| Agent 经验迭代 | [PostgresControlledMemoryService](../../server/src/modules/memory/postgres-controlled-memory-service.ts)、[经验迭代管理路由](../../server/src/http/admin/experience-iteration-routes.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | 员工端候选提交、提案读取、授权查询及撤回入口和 Workbench API 已移除。Agent 只能从显式获准工具在 Run/Attempt 中提出短期申请；成功 Attempt 的申请按稳定 `agent_id` 进入管理端，管理员核对 Agent Version、Run、Attempt 后批准或拒绝。批准创建不可变经验版本，后续 Attempt 固定引用；不得自动改写 Soul、Skill、Tool、权限或权威业务事实。专属质量评测与显式回滚仍是后续门禁。 |
| 受控 Agent 委派 | [PostgresAgentDelegationService](../../server/src/modules/run/postgres-agent-delegation-service.ts)、[RunOrchestrationService](../../server/src/modules/run/run-orchestration-service.ts)与[DSH Adapter](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) | `delegate_agent` 是 dsh-work 内置执行工具，只在 Agent Version 配置精确已发布目标时进入 Manifest。服务锁定活动父 Run，按父 Attempt + 请求摘要幂等创建无 Session 子 Task/Run；子 Task 共用根预算范围，授权为目标当前授权与父角色/数据快照上限交集，团队空间要求目标 Agent 当前成员关系。深度、并行、超时有界；受理和 Attempt 领取在 Runtime 行锁下计算当前占用并预留同步子任务席位；普通任务因预留而领取失败时调度泵继续扫描后续子任务。委派 Task 禁止通用重试，父任务终止递归取消，启动恢复对账遗留关系。子任务仍走统一 DSH 链路；`task-result/v1` 只有在全部必要回执均完成时才允许 `achieved`，未解决回执保持 `unverified`，失败回执、运行失败或取消为 `not_achieved`；父 Task 的委派工具回执仅为 `accepted`。 |

## API 与运行契约

- [Workbench OpenAPI](openapi-workbench.json)：`/api/workbench/v1`。
- [Admin OpenAPI](openapi-admin.json)：`/api/admin/v1`。
- [Runtime Manifest](runtime-manifest.schema.json)：不可变输入、能力、文件、知识与权限快照。
- [Run Event](run-event.schema.json)：标准可展示事件，不包含隐藏推理和凭据。

接口修改必须同步消费者、Schema 和相应测试。公开 API、内部 TypeScript 类型和 DSH ACP 是不同边界，不应直接复用上游内部对象代替产品契约。

`GET /tools`、`GET /tools/catalog`、`POST /tools/sync` 与 `GET /tools/bindings` 是 DSH 普通内置工具的管理边界，只返回稳定 Connector `connector-dsh-workspace` 下的普通业务工具记录。`POST /tools/sync` 一次发现并持久化当前 Profile 的普通业务工具，新增或契约变化生成不可变 Tool Version；文件工具 `read_image`、`str_replace_editor` 与网络工具 `web_search` 在 dsh-work 路径、命令和查询参数约束下自动准入。`web_fetch` 因 DSH 尚无连接层私网地址与重定向防护，保留目录记录但不可准入，执行策略也拒绝调用。DSH Agent 协作工具（如 `subagent`、`send_message`）和 Runtime 控制工具（如 `workflow`、`exit_plan_mode`）不进入普通工具列表，历史记录强制停用且撤销 Binding。其他未完成平台安全准入的工具以 `admissionStatus=unavailable` 保留在目录并强制停用，不生成活动 Binding，也不进入 Agent 可选清单。同步未再发现的旧工具同样转为不可用并撤销活动 Binding。已准入 DSH 工具的业务使用授权在 Agent Version 中通过精确工具引用、可见角色和数据范围配置；工具记录中的默认角色、范围和审批策略是平台固定安全上限，不是要求管理员重复配置的第二个业务授权入口。上面四个接口与目录同步、绑定列表都固定只对 `connector-dsh-workspace` 生效；运行时解析允许的连接器范围另由部署配置 `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS` 显式给出（缺省只含该连接器），两者不是同一个边界。dsh-work 内置执行/平台工具由代码契约目录管理；MCP 外部工具由 Connector 的自动生效发现快照、健康状态和能力摘要门禁管理，二者均不写入普通工具列表。
内置工具不是可管理的数据：不存在工具目录同步、逐工具授权或绑定修订。每次 Attempt 由 `agentBuiltinToolNames` 按 Agent 版本的 `web_search_enabled` 生成 DSH 工具清单，加上按运行内容需要的平台工具，以及（无 purpose 的员工运行中）按 `project_tasks_enabled` 与 `projectTaskToolMode`（团队空间人发起为 `read-write`、定时执行为 `read`）装配的项目任务工具，以及（员工侧 Agent 运行、本次启动的执行容器可用时，`executionToolNames`）`bash`，再去掉 Runtime 配置 `disabled_tools` 中的工具，写入 Manifest `tools`（`name@1.0.0`）；DSH 工具策略只放行该清单。会话摘要、项目档案员与管理运行另行编译 Manifest，不装配 `bash`。工具清单确定后再决定输入挂载（执行隔离 2b-4）：有解析文本的文件挂 `input.file_mounts`；装配了 `bash` 时另挂 `input.original_mounts`（只含文件引用、摘要与大小，编译器拒绝不带 `bash` 或带额外字段的原始挂载），字节由 Runtime Adapter 经 `loadRuntimeOriginal`（内容服务 `readRuntimeOriginal`，按 Run 的 `run_input_files` 绑定读取）在初始授权复核后写入 `input/original/` 并校验；没有解析文本又无 `bash` 的输入在创建 Attempt 前拒绝。`run_input_files.extraction_id` 对只挂原始文件的二进制成果为空（迁移 0101）。Runtime Adapter 没有执行容器时拒绝带 `bash` 的 Manifest（`EXECUTION_CONTAINER_UNAVAILABLE`），不降级到宿主执行。Skill 的 `allowed-tools` 按名称匹配注册表（忽略大小写与下划线，`WebSearch` → `web_search`），声明联网搜索的 Skill 只能被开启联网搜索的 Agent 引用；项目任务工具、管理用途工具与 `bash` 不能由 Skill 声明（`allowed-tools` 中的 `Bash` 仍记为不支持的依赖）；注册表以外的工具（如 `web_fetch`）一律不可用。

DSH 内置工具目录不读取常驻共享快照。`AgentRuntimePort.listTools()` 每次启动一个短生命周期、无平台工具桥、无 MCP、空工具授权的隔离 ACP 会话；dsh-work 的受信 Tool Policy 仅在显式目录探测模式下，于 DSH `agent/session-start` 后调用该 Agent 作用域的 `ctx.tools.schemas(agent)`。Adapter 只接受与本次 Session ID 匹配且摘要正确的 v3 目录，读取后关闭 Worker 并删除临时目录。普通 Attempt 会移除目录发布环境变量，不能覆盖管理目录；DSH 外部依赖本身不作修改。

`GET /connectors` 是 MCP 管理边界，只返回外部 MCP Connector。平台稳定连接 `connector-dsh-workspace` 通过 `GET /runtimes/dsh-tool-connector` 在 Runtime 运维详情中只读展示，检查使用 `POST /runtimes/dsh-tool-connector/check`；不得从 MCP 页面为其提供新增、Token 或删除操作。租户当前可用的外部 MCP Connector 最多 20 个；登记、重新启用和检查恢复健康共用租户级事务锁及容量门禁，保证解析给任一 Agent Version 的集合不会超过 Runtime Manifest 上限。

DSH Tool Version 持久化 `outputValidation`、`retryPolicy`、`concurrencyPolicy` 和 `completionSemantics`。dsh-work 内置执行/平台工具由契约目录编译严格 JSON Schema，并在 Unix socket 桥两侧执行校验；DSH 包装器对非 2xx 响应抛出错误，不把错误正文当成成功结果。由于 DSH ToolRuntime 对普通 `Error` 只保留 `message`，包装器同时把 `code/retryable/effect_state` 以 `DSH_WORK_TOOL_ERROR` 前缀投影到模型可见消息，并保留同名属性供直接调用方使用。DSH 原生文件/任务工具的输入由 DSH 与平台路径策略约束，但结构化输出尚未穿过平台验证边界，目录明确发布 `outputValidation=unavailable` 及不可验证标记 Schema。提升验证级别前须接通实际输出校验，不能只修改目录字段。
服务启动时通过 `AgentRuntimePort.listTools()` 读取一次 DSH 当前工具目录并与注册表比对，缺失的 DSH 工具在 `GET /runtimes/builtin-tools` 中报告（`catalog.missingTools`），读取失败时报告错误；比对结果不改变执行行为。目录探测启动一个短生命周期、无平台工具桥、无 MCP、空工具授权的隔离 ACP 会话；dsh-work 的受信 Tool Policy 仅在显式目录探测模式下，于 DSH `agent/session-start` 后调用该 Agent 作用域的 `ctx.tools.schemas(agent)`。Adapter 只接受与本次 Session ID 匹配且摘要正确的 v3 目录，读取后关闭 Worker 并删除临时目录。普通 Attempt 会移除目录发布环境变量。

`GET /connectors` 是 MCP 管理边界，只返回外部 MCP Connector。内置工具通过 `GET /runtimes/builtin-tools` 在 Runtime 运维详情中只读展示，停用清单随 `PATCH /runtimes/configuration` 的 `disabledTools` 保存（省略时保留当前清单）。

平台内置 Skill（[方案](../design/builtin-skills-plan.md)）同样随代码发布：`BuiltinSkillCatalog`（`server/src/modules/skill/builtin-skills.ts`）在启动时从 `server/config/builtin-skills/` 加载并按 `versions.lock.json` 校验，不写入 Skill 表。员工侧派发（`AttemptDispatcher.dispatch`）用 `RuntimeAgentSnapshot.coveringSkills`（Agent 固定与会话选择的根 Skill 及其 `skills.covered_builtin_scenarios`）与 `RunOperationsPort.getRuntimePolicy().disabledBuiltinSkills`（`runtime_configurations.disabled_builtin_skills`）解析本次装配集合，以内联 Skill 追加到 Manifest `skills`/`skill_instructions` 之后，未装配的写入 `builtin_skill_exclusions`。执行前复核用 `installedSkillReferences` 从 Manifest 重建附加 Skill，内置 Skill（ID 前缀 `dsh-work-`，见 `domain/builtin-skill-ref.ts`）不进入依赖闭包与空间能力授权；Runtime Adapter 在 `activate_skill` 时经 `disabledBuiltinSkills` 回调拒绝被紧急停用的内置 Skill。管理接口：`GET /skills/builtin` 只读展示，`PATCH /skills/builtin-coverage` 设置覆盖场景，停用清单随 `PATCH /runtimes/configuration` 的 `disabledBuiltinSkills` 保存（省略时保留）。租户内 MCP Connector 总数不设上限；单个 Agent Version 最多选择 20 个，与 Runtime Manifest 上限一致。

dsh-work 平台工具由契约目录编译严格 JSON Schema，并在 Unix socket 桥两侧执行校验；DSH 包装器对非 2xx 响应抛出错误，不把错误正文当成成功结果。由于 DSH ToolRuntime 对普通 `Error` 只保留 `message`，包装器同时把 `code/retryable/effect_state` 以 `DSH_WORK_TOOL_ERROR` 前缀投影到模型可见消息，并保留同名属性供直接调用方使用。DSH 原生文件/任务工具的输入由 DSH 与平台路径策略约束，但结构化输出尚未穿过平台验证边界；提升验证级别前须接通实际输出校验。

平台桥错误外层为 `error.code/message/retryable/effect_state`。处理器在任何写入前发现的参数或业务前置条件失败必须抛出有类型错误，才能保留可纠正消息和 `not_started`；未标记的写入处理器异常保守记为 `TOOL_RESULT_UNKNOWN`。只读安全工具超时可标记重试；写入超时、取消或执行后冲突按契约表达未知效果。`serialized` 表示同一 Attempt 内同名工具不允许重叠执行，冲突在第二个处理器启动前返回。写入平台工具按 Task 自动登记 Operation：`completionSemantics=completed` 落完成回执，`accepted` 保留异步受理状态，超时或执行后无法确认落 `unknown`；重复动作不会再次进入处理器。

PF-01 的 Task/Operation 仓储提供外部动作的持久化事实：`operation_key` 防止同一 Task 重复受理，`parameter_digest` 防止同键换参，`accepted/completed/failed/unknown` 区分受理、完成、失败和效果未知。`unknown` 不是失败或可安全重试的同义词，只能由平台管理员依据权威外部状态核对转为 `completed` 或 `failed`。`POST /task-executions` 受理无 Session 的 API/event Task，查询、取消和重试接口沿用现有 Run/Attempt/Runtime Adapter/DSH；Runtime Manifest 固定 `task_id`，Artifact 可归属 Task 并按当前 Workspace 与 Task 所有人重新鉴权。

PF-02 的预算账户以 `tasks.budget_scope_task_id` 标识共享范围；根 Task 指向自身，PF-06 子 Task 显式指向根范围。`task_budget_accounts` 保存累计时长、工具次数和输出字节上限，`attempt_budget_usage` 保存每次预占、结算/释放、测量来源与终态。`RunRepository.createAttempt` 在同一事务锁定账户、汇总已结算与活动预占并拒绝超额；Runtime 终态事件在状态转换前精确结算，数据库触发器为取消、重启和异常路径提供一次性保守兜底。Runtime Manifest 的 `budget` 快照必须与 Task 账户及 `limits` 一致。

`cumulativeBudget` 可用于会话 Run 与无 Session Task；自动任务既有 `inputTemplate.budget` 同时固定为该次 Task 的累计上限并收紧单 Attempt limits。时长、工具和输出字节为 hard；Token 只接受 Runtime 完整上报，缺失时返回 `unavailable` 和 null，不从文本估算；成本保持 unavailable。`maxTokens`、`maxCostAmount`/`costCurrency` 返回 422 `TASK_BUDGET_UNSUPPORTED`，超出剩余额度返回 409 `TASK_BUDGET_EXCEEDED`。

PF-03 的 MCP 契约使用现有 Connector 作为配置、健康、启停和删除入口，`mcp_connector_profiles` 保存平台生成的 Server 命名空间、发现快照及当前生效摘要。新增页面先调用不落库的连通测试；正式登记必须再次通过 DSH 发现至少一个 Tool，成功后才在一个事务中保存 Connector、能力快照和可选凭据，客户端不能提交“测试通过”标记绕过复核。健康且能力快照已同步的 Connector 默认对租户内全部 Agent 可用，不建立 Agent→Connector 或逐 Tool Grant。`none` 与 `bearer` 仍是连接器级凭据，全体获准调用共用一个上游身份。`user_oauth` 的访问令牌按员工主体加密保存，Attempt 只注入本次人类主体的令牌；未授权不回退到连接器凭据。平台不按员工身份过滤 MCP 返回体。`credential_secrets` 保存由 `DSH_CREDENTIAL_MASTER_KEY` 加密的连接器级 Bearer 与可选 OAuth 客户端密钥密文；员工访问令牌单独存放在 `mcp_user_credential_secrets`；查询接口只返回状态，不回显明文。旧 `dsh-managed` 引用保留 Connector 并降级，重新录入时为目标 Connector 建立新的独立凭据引用；历史上共享同一引用的其他 Connector 不受本次 Token 变化影响。Runtime Manifest 的 `mcp_connections` 只固定连接标识、公开端点、认证类型及能力摘要，不包含密钥；执行前和活动期以当前 Connector 状态及摘要重新校验。服务端按凭据 ID 解密 Token，并以环境变量注入每 Attempt DSH MCP Patch；DSH 策略只放行当前 Attempt 固定的 `mcp__<serverName>__*` 命名空间。轮换覆盖独占密文并递增版本，人工停用状态保持不变；发现写回事务先锁 Connector，再独立读取最新凭据版本，旧版本结果不得改变 Connector 或能力快照。删除采用受控软删除：所有 Agent 后续解析立即移除该 Connector，活动 Binding 撤销、关联 Tool 停用、独占密文删除；Connector/Profile/健康检查及 `mcp_invocation_audits` 保留，所有活动查询和 Runtime 解析过滤 `deleted_at`。`mcp_invocation_audits` 记录实际 Tool 名、参数摘要、Run/Attempt 和结果。当前只支持 Streamable HTTP Tools；Resources、Prompts 与 stdio 明确不可用。

PF-04 使用 `waiting` 作为 Run 的非终态等待状态和来源 Attempt 的不可恢复终态。`run_checkpoints` 固定来源 Attempt、Manifest 摘要、Runtime 版本、恢复策略、关联键、有效期及有界恢复上下文；上下文包含精确待执行参数、已完成工具结果、输出工作文件和未提交部分回答，并以独立摘要校验。DSH 兼容协议只传工具调用 ID 时，Adapter 从 Attempt 外的可信策略日志取得原始参数并核对摘要；`approval_mode=never` 不捕获恢复检查点。审批先以内部 `preparing` 保存，只有收到 `run.waiting` 后才与 Run、Attempt 的等待状态在同一事务中转为管理端可见的 `pending`。来源 Attempt 在此之前终止时立即取消准备中审批及活动检查点；创建新审批也会清理被当前 Attempt 取代的遗留记录。DSH 没有恢复原 ACP Session 的安全接口，因此平台不声称恢复原 Worker：等待时关闭 Worker，批准后重新校验输入、Agent/工具/MCP 绑定、当前身份授权、检查点完整性及批准有效期，再以 Manifest `resume` 创建新 Attempt、恢复工作文件并向 DSH 提供续办上下文；输出路径允许安全 Unicode 文件名，同时拒绝遍历、控制字符和反斜杠。相同决定与相同 `resolutionKey` 幂等返回；相反决定或不同键返回 `APPROVAL_CONFLICT`。同一审批只消费一个检查点且批准过期后不能消费动作，过期处理只可终止仍为当前来源 Attempt 的 Run；新参数或数据版本重新申请。来源 Attempt 存在 `unknown` 外部操作时拒绝恢复，须先按 PF-01 查询权威系统并收敛回执。等待 Run 会阻止 Session/Workspace 归档，服务重启保留等待事实；审批超时扫描、人工拒绝、用户取消与系统撤权均写入终态事件并结束等待。

员工与管理端 Agent 均通过同一 Run/Attempt、AgentRuntimePort 和 DSH 适配链路执行，不能通过新增 API、Gateway 或业务服务另建直接调用模型的 Agent Loop。职责与评审要求见 [架构总览：Agent 执行引擎统一](overview.md)。

## 运行与恢复规则

工具目录返回 `allowedRoleIds`（稳定角色标识）与 `allowedRoles`（展示名称）；授权预检只使用前者，不按名称匹配执行身份。团队 Agent 的工具依赖包含 `tool_refs` 和封存 `binding_refs` 中的工具。升级迁移 `0079` 为仍有效的 `agent_member` 来源补齐缺失的工具来源及有效授权，包含旧会话固定的已发布版本；不将未知来源猜测为成员授权，不恢复已停用/移除成员或被撤销的来源，补齐后沿用成员撤权和空间授权修订机制。

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

执行容器为必需（执行隔离 4.9），只在启动时检查：DSH 预检通过后在一次性容器（执行容器姿态）中检查执行镜像（`DSH_WORK_EXECUTION_IMAGE`）的工具链（[execution-toolchain](../../server/src/modules/runtime/execution-toolchain.ts)：`bash`、`rg`、`soffice`、`pdftoppm` 必需，`pdftotext`、`pandoc`、`python3` 及 pandas、openpyxl、python-docx、python-pptx 与 Noto CJK SC 字体可选；只取工具标识与版本号，Runtime 说明中的“运行命令”一节据此列出平台撰写的工具说明）、按 label 清扫遗留容器、生成执行容器叠加层并以叠加后的组合重跑 DSH 预检，再读取工具目录核对 DSH 的实际调度（`dshScheduling`）：注册表工具与 `bash` 中只有 `read`、`read_image`、`web_search` 可并行，其余必须独占，未报告也按不满足处理；任一步失败时不构建 DSH Adapter：Runtime 为 `UnavailableRuntime('execution-container')`，所有 Agent 运行在创建 Run/Attempt 前以 `EXECUTION_CONTAINER_UNAVAILABLE` 失败，DSH 子进程不在宿主执行；`executionCapabilities.executionContainer` 报告 `unavailable`，原因只写服务日志。DSH 本身不可用时同样报告 `unavailable`。旧开关 `DSH_WORK_EXECUTION_CONTAINER` 与 `DSH_WORK_PYTHON_*`、`DSH_WORK_EXECUTION_MAX_CONTAINERS` 已删除，设置时只在启动日志中提示被忽略。运行中途不切换。叠加层停用 `subprocess`、`bash-sandbox`、`permission` 与 `tool-jobs`，插入 remote subprocess 与 `dsh-bash-local`；平台只接受 DSH 自带 ripgrep 与 `bash -c <命令>` 两种 argv，分别在镜像内的 `rg`、`bash` 中执行。管理端内置工具状态（`/runtimes/builtin-tools`）带 `executionContainer.status`（`available`/`unavailable`），Runtime 页面据此说明运行是否可用。

发布脚本的严格 DSH 预检保持不变；核心就绪不能替代上线前的真实执行验收。

## 首次管理员认领意图（C10）

`GET /auth/admin/bootstrap` 是显式首次认领入口，默认关闭，仅全新安装临时开放。普通登录与刷新仅要求基础身份 Scope；认领 Scope 从不成为持续登录条件。`oidc_login_transactions.login_purpose` 由服务端写入并在回调时消费，不能从回调参数读取。初始化是否已消费只查询应用/环境账本，不计数当前管理员。新迁移为 `0042_oidc_login_bootstrap_intent.sql`，保留全部旧认领和身份数据。

## 场景试运行契约

管理端既有测试接口可选传入 `scenario`，平台验证后固定为 Manifest `test_scenario`；只允许 `admin-skill-test` 使用。默认调用不改变严格策略。场景级验证结果使用 `scenario-v1` 证据策略，发布需要当前配置下的完整能力覆盖；不得将部分场景证据标成完整严格测试。请求例子、断言支持范围和迁移说明见 [开发与测试](development.md) 中的 Skill 验证与发布门禁。

## 个人历史（B3）

`PostgresConversationRepository.listSessionsForUser()` 为本人历史入口，Session 去重与授权过滤均在 SQL 中完成。默认只读个人范围，`scope=all` 包含本人仍可读团队会话。`getSessionForUser` 共用该查询；旧 Run、团队共享会话入口不被替代。`readableWorkspacePredicate` 是空间行别名 `w` 的公共 SQL 权限片段，不替代 HTTP 层身份与功能鉴权。完整字段以 Workbench OpenAPI 与类型定义为准。

## 我的文件（B4）

`PostgresContentService.listPersonalFiles/getPersonalFile` 统一查询本人默认工作区内的资料、会话附件和成果版本；仍以 file_objects 为不可变对象，来源由关联投影。新 `/files` 上传不接收 Workspace 目标。`DELETE /files/:fileId` 是逻辑移除，旧下载路径和 Runtime 输入检查仍复用原鉴权。没有独立文件库或新的执行路径。

## 内容生命周期（B5）

`archiveSession` 保留旧方法和 `archived` 字段，但产品语义为从历史移除，不物理删除。公共读取策略及账号停用语义见 [功能规则](feature-rules.md)；`/content-policy` 返回固定策略版本。团队归档只读与个人移除不混用。

## 管理助手低风险确认（C6）

风险白名单、判定位置与旧计划兼容见 C6 批次评审记录（仓库外留证）。仅现存 Agent 草稿的四个展示字段可由通用助手直接生成计划；systemPrompt、权限、发布、Runtime 仍走两次确认。`confirmationMode` 是服务端计划的只读投影，不接受调用方传入。

## 独立账号认证

正式部署始终注册账号密码认证，AI Hub 配置完整且有效时另外注册 OIDC 与目录同步。未配置或配置无效的可选 AI Hub 不阻塞独立认证；配置错误记入启动日志，公开接口不暴露细节或密钥。基础身份配置、可信入口、Session Secret 和生产 HTTPS 校验仍必须通过。

个人自动任务按持久化用户的 `identity_provider` 复核后台身份：AI Hub 用户必须具有可用配置和信任窗口内的成功目录同步，配置缺失、无效或目录过期时拒绝启用、触发及执行期复核；独立账号不依赖 AI Hub，但仍检查账号、租户和当前授权。

`RequestIdentity.identityProvider=local-password` 由服务端产生，后续角色、数据范围、Run/Attempt 和 DSH 授权保持原路径。独立账号和 AI Hub 账号分别创建、分别授权，不进行绑定或姓名/邮箱匹配。旧绑定凭据不删除，但不能用于 AI Hub 用户的密码登录、改密或重置。新账号和管理员重置的密码必须先通过 `/auth/{audience}/password` 修改，否则业务 API 返回 `password_change_required`；改密、撤销所有旧会话和签发当前门户的新会话在同一事务内完成；响应设置新的 HttpOnly Session Cookie，并返回原同源访问地址，前端直接进入系统，无需再次登录。改密失败不签发会话、不跳转。

新建独立账号统一使用手机号或邮箱；`POST /api/admin/v1/identity/login-account/check` 仅允许平台管理员检查格式和占用情况，创建事务仍会重新检查独立账号与已同步 AI Hub 的登录账号，重复返回 `local_account_exists`。手机号兼容 `+86` 并统一为大陆 11 位，邮箱忽略大小写；已有用户名继续兼容登录，不按资料邮箱绑定身份。

认证接口见 [认证 OpenAPI](openapi-auth.json)，管理接口见 [Admin OpenAPI](openapi-admin.json)。`/auth/{audience}/configuration` 返回当前能力 `mode`、`localEnabled`、`aiHubEnabled`；`mode` 表示已加载的提供方能力，不是管理端可选设置。API 按提供方 Cookie 分流，双 Cookie 拒绝；登录完成撤销当前门户另一提供方旧会话，过期凭据不跨提供方降级。

管理端登录设置页面、`GET/PATCH /api/admin/v1/identity/login-settings` 和 `POST /api/admin/v1/identity/users/:userId/local-account` 已移除。旧 `system_settings.identity.login` 记录保留但不再读取，不触发启动切换或会话撤销。部署默认自动启用独立认证，旧 `DSH_WORK_AUTH_MODE=local/oidc` 仅兼容、不改变能力选择；原 `prototype` 模式已移除，设置后服务拒绝启动。详见 [独立登录指南](../release/local-authentication.md)。

员工授权列表和授权变更响应返回只读 `loginAccount`：独立账号取凭据用户名，AI Hub 取已同步的 subject（当前上游以登录账号作为 subject）。列表搜索同时匹配两类账号；`username` 保持仅用于独立凭据管理，账号展示不改变身份归属。邮箱、最近活跃和活动会话来自既有资料与会话记录，AI Hub 用户标识和目录同步时间在详情查看。
