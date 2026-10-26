# Agent 数据平面（AE-03）

Agent 不拥有独立业务表；平台提供固定通用表与安装实例，Agent 在 Run/Attempt 内通过受控工具读写状态与结构化记录。

## 代码入口

- 数据服务：[postgres-agent-data-service.ts](../../server/src/modules/agent-data/postgres-agent-data-service.ts)
- 管理 API：[agent-data-routes.ts](../../server/src/http/admin/agent-data-routes.ts)
- 基础迁移：[0072_agent_data_plane.sql](../../server/migrations/0072_agent_data_plane.sql)
- 表说明：[数据模型](../design/data-model.md) 第 5 节

## 约束摘要

- `AgentSpec.data` 经发布与验证门禁后才在 DSH Bridge 注入工具。
- 记录版本不可变；保留期删除写墓碑，历史 Run 结果仍可引用。
- 集合与 Grant 由管理员治理；真实 DSH/OIDC 端到端验收单独留证。
