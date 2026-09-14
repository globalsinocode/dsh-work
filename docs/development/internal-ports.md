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
