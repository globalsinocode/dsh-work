# 内部端口与契约

两个前端只调用各自 API；服务端通过明确的接口协作。下表链接实际类型和实现，避免维护与源码不一致的伪接口副本。

| 边界 | 权威来源 | 约束 |
| --- | --- | --- |
| Runtime 启动、取消、事件、健康与关闭 | [AgentRuntimePort](../../server/src/modules/runtime/runtime-types.ts) | 一个 Attempt 一个隔离 Worker；DSH 版本由 Runtime Lock 决定 |
| Run、Attempt、事件与重启恢复 | [RunRepository](../../server/src/modules/run/run-repository.ts) | 租户隔离、幂等、终态不可回退；事件先落库后发送 |
| 模型 Provider、路由与凭据引用 | [ModelGovernanceRepository](../../server/src/modules/model/model-governance-repository.ts) | Attempt 固定路由快照；Agent 不单独配置模型策略 |
| 凭据存储 | [SecretStorePort](../../server/src/modules/model/secret-store-port.ts) | 当前 DSH 适配器不读取或覆盖实际密钥，引用存在不等于凭据已验证 |
| 身份与本地授权上下文 | [RequestIdentity](../../server/src/modules/identity/types.ts) | 用户、角色、数据范围和操作人只从服务端产生 |
| 对象与执行授权 | [PostgresAuthorizationService](../../server/src/modules/authorization/postgres-authorization-service.ts) | Workspace、Agent/Skill/Tool Version 与数据范围逐层校验，默认拒绝 |
| Skill 安装计划 | [AdminSkillInstallationService](../../server/src/modules/skill/admin-skill-installation-service.ts) | 固定来源、生成依赖计划、绑定管理员确认、原子保存草稿并记录激活/脚本试运行证据 |
| 通用管理对话与任务调度 | [AdminAssistantService](../../server/src/modules/admin/application/admin-assistant-service.ts) | 通过 DSH 进行普通对话和意图提案；绑定第一次调度确认、专用助手操作计划、第二次写入确认、行锁内版本复核及重启结果收敛 |
| Attempt 平台工具 | [platform-tool-bridge](../../server/src/modules/runtime/platform-tool-bridge.ts) | 为当前 Attempt 暴露 `prepare_skill_installation`、`activate_skill`、`python_execute` 等显式授权处理器；不承载 Agent Loop |

## API 与运行契约

- [Workbench OpenAPI](openapi-workbench.json)：`/api/workbench/v1`。
- [Admin OpenAPI](openapi-admin.json)：`/api/admin/v1`。
- [Runtime Manifest](runtime-manifest.schema.json)：不可变输入、能力、文件、知识与权限快照。
- [Run Event](run-event.schema.json)：标准可展示事件，不包含隐藏推理和凭据。

接口修改必须同步消费者、Schema 和相应测试。公开 API、内部 TypeScript 类型和 DSH ACP 是不同边界，不应直接复用上游内部对象代替产品契约。

员工与管理端 Agent 均通过同一 Run/Attempt、AgentRuntimePort 和 DSH 适配链路执行，不能通过新增 API、Gateway 或业务服务另建直接调用模型的 Agent Loop。职责与评审要求见 [架构总览：Agent 执行引擎统一](overview.md)。

## 运行与恢复规则

- 使用稳定事件 ID，按持久化的全 Run 顺序支持 `Last-Event-ID` 续传；不能仅按单 Attempt 序号恢复整个 Run。
- Token、Tool 和计量信息来自受控 Session 日志/Telemetry 投影，不从回答文本猜测，不直接导出未经脱敏的运行轨迹。
- 取消和重启须收敛到确定终态；重试新增 Attempt，旧事件不得覆盖当前 Attempt。
- 文件路径使用受控存储键；输入只读、成果显式收集，下载重新鉴权。
- 业务角色与数据范围留在本地；AI Hub 专用协议仅进入身份模块，外部身份变化不覆盖本地授权历史。

具体运行环境见 [Runtime 指南](../release/dsh-runtime-delivery.md)，验证命令见 [开发与测试](development.md)。

## 执行能力故障隔离（C9）

Runtime 端口的可选 `assertAvailable(manifest?)` 在受理、编译与恢复队列时检查能力。`UnavailableRuntime` 仅抛出 503 `RUNTIME_UNAVAILABLE`，不提供 Mock、模型调用、事件或回答。`CapabilityGuardedRuntime` 只委托既有 DSH 适配器，不维护 Agent Loop；Python 预检失败只拒绝显式依赖 `python_execute` 的任务。

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
