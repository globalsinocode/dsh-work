# 三方兼容合并能力决策（2026-10-26）

**状态：** 集成执行中  
**基线 SHA：** `origin/dev` `31eeddb` · `tonycc/main` `f7acd10` · 本地 hardening `b17508f` + 材料 `36aebb9`

## 能力决策表

| 领域 | 决策 |
| --- | --- |
| 工作模式 | 保留 globalsinocode + hardening 的团队空间、Composer、附件、文件、通知和导出 |
| 协作模式/项目空间 | 引入 tonycc，作为第二壳和项目能力，不替换工作模式 |
| Agent 管理 UI | 采用 tonycc 的 `AgentDetailView` / `AgentDraftView` 结构，移植现有能力和校验 |
| Agent 发布治理 | 保留现有不可变版本、候选、验证、审核、发布和回滚语义 |
| PF-06 委派 | 保留条件式受控委派；不引入 tonycc 的破坏性删除 |
| AE-03 Data Plane | 保留受控数据能力；不引入 tonycc 的破坏性删除 |
| 内置工具 | 可采用代码化注册，但不得删除 Connector/Binding/MCP 治理和审计 |
| MCP | per-agent 选择与员工 `user_oauth` 同时成立，并在调用时复核当前授权 |
| Agent Loop | 始终走现有 Run/Attempt + Runtime Adapter + DSH，不增加备用执行引擎 |

## tonycc 删除项处理规则

- 旧实现文件可以被新实现替换，但业务契约和测试证据必须保留或迁移。
- `0083_remove_agent_delegation.sql` 与 `0087_remove_agent_data_plane.sql` **不进入**最终迁移序列。
- `0104_builtin_tools_in_code.sql` **不得**删除 `tools` / 绑定修订表；只增加 `web_search_enabled` 与 Runtime `disabled_tools`。
- `0090_agent_level_access.sql` 增加 Agent 级 `visible_role_ids`，**不得**删除 `agent_versions` 上的可见角色与数据范围列。
- `0091_agent_validations.sql` 可新增 `agent_validations` 表，**不得**删除 `agent_release_submissions` 与发布证据表。
- 若新实现无法在不删除受保护能力的前提下工作，按停止条件暂停集成。

## 验收映射（摘要）

| 能力 | 生产者/消费者 | 迁移 | 证据 |
| --- | --- | --- | --- |
| 会话草稿 / clientIntentId | `postgres-conversation-repository`, `tasks` store | `0085_session_drafts` | B1 集成 / e2e conversation-reliability |
| 工作区文件 GC / 选择器 | `postgres-content-service`, `WorkspaceFilePickerDialog` | `0086_workspace_object_gc` | content-workspace contracts |
| 工作区通知 | `workspace-notification-recipient-service`, `NotificationInbox` | `0087_workspace_notifications` | workspace-notifications integration |
| 自动化归档 | `postgres-automation-repository` | `0088_automation_archive_metadata` | automation integration |
| MCP user_oauth | `mcp-user-grant-service`, `external-connections` | `0084_mcp_user_grants` | `mcp-user-grant.integration.test.ts` |
| per-agent MCP | tonycc manifest/scope | `0102_agent_mcp_scope_selected_only` 等 | mcp + agent-capabilities e2e |
| PF-06 委派 | `postgres-agent-delegation-service` | 无删除迁移 | `pf06-agent-delegation.integration.test.ts` |
| AE-03 Data Plane | `postgres-agent-data-service` | 无删除迁移 | `agent-data:integration` |
| 项目空间 / 协作模式 | collab routes, `useProjectSpace` | `0093_project_space` 等 | project-space e2e |

tonycc 文档中的历史 P2 记录**不**视为本次合并的 P2 证据；合并后须在当前提交上重新执行适用 P2。

## 迁移最终序列

- `0082`–`0084`：globalsinocode 已发布（文件名与内容不改）
- `0085`–`0088`：本地 hardening（自原 `0084`–`0087` 重编号）
- `0089`–`0105`：tonycc 非破坏性迁移（跳过委派/Data Plane 删除）
