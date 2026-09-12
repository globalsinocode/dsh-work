# 项目工作规范

开始开发前阅读 [架构总览](docs/development/overview.md)、[内部端口与契约](docs/development/internal-ports.md) 和 [开发与测试](docs/development/development.md)。

## Agent 执行统一使用 DSH

- 员工对话、管理端安装助手和其他系统 Agent 均通过既有 Run/Attempt、Runtime Adapter 与 DeepSeek Harness（DSH）链路执行。
- 禁止新增第二套 Agent 执行逻辑：不得在前端、业务后端或独立服务中绕过 DSH，直接调用模型 API 实现 Agent 对话、工具调用循环或多步推理；不得引入并行的 Agent 执行框架。
- 平台负责身份、权限、业务状态、持久化、调度和受控工具；DSH 负责单次 Attempt 内的 Agent Loop。业务任务重试、恢复和工具事务不应演变成另一套模型执行循环。
- 对话安装 Skill 必须复用 DSH 驱动安装助手，下载、校验、保存版本等操作由平台工具完成。DSH 能力不足时完善现有适配链路或 DSH，不能另建执行引擎补位。
- DSH 不可用时明确报告不可用，禁止自动降级为直接调用模型的 Agent 路线。测试替身仅用于测试和原型，不得成为生产备用执行引擎。

详细职责及评审要求以架构总览的“Agent 执行引擎统一”章节为准；新增方案、代码与文档必须遵守该约束。
