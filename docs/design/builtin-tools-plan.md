# 内置工具代码化方案

**状态：** 已实施（2026-10-22），实现与本方案的差异见第 7 节。<br>
**日期：** 2026-10-21<br>
**原则：** 系统尚未正式上线，设计与实现尽量简化，不考虑存量数据兼容和历史方案。<br>
**前置：** [MCP 按 Agent 选择与能力变更确认方案](mcp-agent-scope-plan.md)已实施；本方案处理剩余的 DSH 内置工具与 dsh-work 平台工具。

## 1. 决策

1. **内置工具不再是可管理的数据。** DSH 内置工具与 dsh-work 平台工具合并为一张代码注册表，放在 runtime 模块。准入、约束、默认装配都由代码决定，随版本发布。
2. **删除工具治理数据模型。** 删除 `tools`、`tool_versions`、`tool_binding_revisions` 及种子连接器 `connector-dsh-workspace`，以及 Agent 版本上的 `binding_refs` 和 DSH 部分的 `tool_refs`、工作空间的工具能力授权、工具目录同步和逐工具权限接口与页面。
3. **工具不按角色授权。** 内置工具只作用于当前 Run 工作区，输入文件由挂载授权控制，不再叠加工具级角色或数据范围。
4. **联网搜索按 Agent 开关。** `web_search` 会把查询发到外网，是唯一触及工作区以外的内置工具，改为 Agent 版本上的“允许联网搜索”，默认关闭。
5. **紧急停用放在 Runtime 配置。** 管理员可以在现有 Runtime 配置里临时停用某个内置工具，对之后新建的 Attempt 生效，不另建表。
6. **tool 模块只剩 MCP。** 工具分为两类：内置（代码）和 MCP（Connector 数据）。

## 2. 现状问题

| 问题 | 说明 |
| --- | --- |
| 三层数据承载常量 | 每个 DSH 工具有工具、版本、绑定修订三层；绑定修订里的端点、凭据槽位、身份策略、环境对 DSH 工具都是常量 |
| 安全边界不在这些数据里 | 真正约束工具的是 `dsh-work-tool-policy.js` 的路径与参数规则；数据库记录只决定“放不放行” |
| 多处事实来源 | 工具分类、默认装配、免授权、可写名单、隐藏名单散落在 7 处常量和 SQL |
| 授权叠层且有隐式豁免 | 工具级角色和数据范围、工作空间工具授权、Agent 执行身份三层叠加；工作区工具的免授权靠“角色列表恰好等于默认值”推断，管理员一改就让所有 Agent 失去 `read` |
| 未使用的入口 | Agent 编辑页没有选工具控件；`POST /tools` 无页面入口；审批策略只能填固定值 |
| 管理页成本 | 每次打开工具目录都启动一个 DSH 会话 |

实际决定 Agent 工具的只有一条路径：平台默认装配 9 个工具，并按执行身份过滤。

## 3. 目标设计

### 3.1 内置能力注册表

新增 `server/src/modules/runtime/builtin-tools.ts`，作为内置工具的唯一来源：

```ts
interface BuiltinTool {
  name: string                    // DSH 中的工具名，如 'read'
  label: string                   // 中文名称
  source: 'dsh' | 'platform'      // DSH 原生，或经 Platform Tool Bridge 回到平台执行
  effect: 'read' | 'write'
  risk: 'low' | 'medium' | 'high'
  constraints: string[]           // 约束说明，用于管理端只读展示与系统提示
  assembly: 'always'              // 每个 Agent 默认装配
    | 'agent-opt-in'              // Agent 版本显式开启（web_search）
    | 'skill'                     // 激活 Skill 时装配（activate_skill、python_execute）
    | 'purpose'                   // 按 Run purpose 注入（管理助手平台工具）
}
```

| 工具 | 来源 | 装配 |
| --- | --- | --- |
| `read`、`glob`、`grep`、`read_image` | dsh | always |
| `write`、`edit`、`str_replace_editor` | dsh | always |
| `todo_write` | dsh | always |
| `web_search` | dsh | agent-opt-in |
| `activate_skill`、`python_execute`、`propose_memory` | platform | skill / 现有规则 |
| `inspect_admin_state`、`propose_admin_task`、`prepare_admin_action`、`prepare_skill_installation` | platform | purpose |

不在表中的 DSH 工具一律不放行，包括 `bash`、`web_fetch`、`job_*`、`*_goal` 和 Agent 协作、Runtime 控制类工具。平台工具的输入输出契约仍在 `platform-tool-contracts.ts`，注册表只引用其名称。将来开放新工具须同时补约束代码和注册表条目。

### 3.2 运行时装配与校验

- 创建 Attempt 时按注册表、Agent 版本的联网开关、所选 Skill、Run purpose 和 Runtime 停用清单计算本次工具名称清单，写入 Manifest；`DSH_ALLOWED_TOOLS_JSON` 由该清单生成。
- Manifest 去掉 `tool_bindings`；`tools` 改为工具名称清单，另记 `builtin_catalog_digest`（注册表与 DSH 版本的摘要），用于追溯与恢复复核。
- 执行期复核不再查工具表：Attempt 固定的清单在启动、恢复时与当前 Runtime 停用清单比对，被停用则拒绝。
- 服务启动时由现有目录探测比对 DSH 当前工具目录与注册表：注册表中有而 DSH 缺失的工具在 Runtime 健康中报为降级，不再写库。管理端不再触发目录探测。

### 3.3 联网搜索开关

- `agent_versions` 新增 `web_search_enabled boolean not null default false`，属于版本内容；修改后须重新验证。
- 管理端 Agent 能力配置增加“允许联网搜索”开关，并说明查询内容会发送到外部搜索服务。
- Skill 的 `allowed-tools` 声明 `WebSearch` 而 Agent 未开启时，验证与发布明确报错。

### 3.4 紧急停用

- `runtime_configurations` 新增 `disabled_tools jsonb not null default '[]'`，沿用现有修订记录与审计。
- `PATCH` Runtime 配置接口与管理助手的 `runtime-update-configuration` 动作增加 `disabledTools`；只能填写注册表中 `source = 'dsh'` 的工具名。
- 停用对之后新建或恢复的 Attempt 生效；运行中的 Attempt 不受影响，需要时由管理员取消运行。

### 3.5 Skill

- `allowed-tools` 直接对照注册表：忽略大小写与下划线匹配（如 `Read` → `read`、`WebSearch` → `web_search`），可识别的工具名记入 Skill 版本，其余仍记为“不支持”的需求。
- `skill_versions.tool_refs` 改存工具名称，不再带 `@1.0.0`。
- 因为基础工具对每个 Agent 都装配，Skill 依赖只用于发布前检查（例如上面的联网搜索），不再扩充 Agent 工具。

### 3.6 授权

- 删除 `isDefaultRunLocalAgentTool`、工具级 `allowed_role_ids` / `data_scopes` 校验以及 `resolveAndAuthorizeTools`。
- 删除 `workspace_capability_grants` 中 `capability_type = 'tool'` 的授权与校验；Agent、Skill 的工作空间授权不变。
- 输入文件挂载、执行身份、发起人上限、MCP 范围等现有授权不变。

### 3.7 管理端

- 删除“DSH 工具管理”页签、“权限管理”中的工具权限部分以及 `toolGovernance` store。
- Runtime 详情页新增只读“内置工具”区块：注册表中的工具、约束说明、DSH 版本、目录比对结果，以及当前停用清单的编辑入口（复用 Runtime 配置表单）。
- Agent 能力配置新增“允许联网搜索”开关。

## 4. 删除清单

| 位置 | 内容 |
| --- | --- |
| 数据库 | `tools`、`tool_versions`、`tool_binding_revisions`、`connector-dsh-workspace` 及其健康检查记录；`agent_versions.tool_refs`、`binding_refs`；工作空间工具授权 |
| 服务端 | `PostgresToolConnectorService`、`dsh-built-in-tool-catalog.ts`、`domain/tool-binding.ts`、`domain/tool-category.ts` 中的工具分类常量；发布门禁的绑定比对；执行期绑定复核；Agent 与 Skill 服务中的工具引用校验 |
| 接口 | `GET /tools`、`GET /tools/catalog`、`POST /tools/sync`、`POST /tools`、`PATCH /tools/status`、`PATCH /tools/permissions`、`GET /tools/bindings`、`GET /runtimes/dsh-tool-connector`、`POST /runtimes/dsh-tool-connector/check` |
| 管理端 | DSH 工具管理页签、工具权限编辑、`toolGovernance` store 及相关 API |
| 文档 | 总览 §3.6、内部端口中 DSH 工具与绑定段落、Agent 设计规范中的工具版本与绑定要求 |

`server/src/modules/tool/` 之后只保留 MCP：`postgres-mcp-connector-service.ts`、`mcp-capabilities.ts`、`agent-mcp-scope.ts`、`postgres-encrypted-credential-store.ts`。

## 5. 实施切片

| 切片 | 内容 | 验证 |
| --- | --- | --- |
| B1 注册表与运行时装配 | 新增注册表；Attempt 装配、Manifest、`DSH_ALLOWED_TOOLS_JSON`、启动目录比对改用注册表 | Runtime Adapter 与 Manifest 单测；工具策略单测；不再查询工具表 |
| B2 删除治理模型 | 删除表、服务、接口与绑定复核；Agent、Skill、授权服务改用注册表；迁移 | 全量服务端单测与集成测试；OpenAPI 覆盖测试 |
| B3 联网开关与紧急停用 | `web_search_enabled`、`disabled_tools`、管理助手动作、Skill 发布检查 | 集成测试：未开启时无 `web_search`；停用后新 Attempt 无该工具 |
| B4 管理端与文档 | 删除页面，Runtime 只读区块，Agent 开关；同步架构、端口、设计规范、测试目录 | 管理端单测；更新相关 Playwright；架构检查 |

B1 先行，B2、B3 依赖 B1，B4 最后。

## 6. 不在范围

- 开放 `bash`、`web_fetch`、后台任务等新工具。
- DSH 原生工具的输出结构校验（仍为 `outputValidation=unavailable`）。
- 平台工具契约（`platform-tool-contracts.ts`）本身的调整。

## 7. 实施记录与偏差

实施分支在 MCP 方案提交之后，迁移为 `0096_builtin_tools_in_code.sql`。与上文的差异：

| 位置 | 方案 | 实施 | 原因 |
| --- | --- | --- | --- |
| 工具引用格式（3.2、3.5） | Manifest 与 `skill_versions.tool_refs` 改存工具名称 | 保留 `name@1.0.0`，版本固定为 `BUILTIN_TOOL_VERSION` | Manifest Schema、DSH 工具策略与 Skill 包格式已使用该格式，改名不带来收益；`parseBuiltinToolReference` 统一解析 |
| 装配方式（3.1） | `skill` 装配 `activate_skill`、`python_execute` | `runtime`：按运行内容装配，包含 `propose_memory`；`risk` 只有 `low`/`medium` | 三者都由运行内容触发，规则一致 |
| 目录摘要（3.2） | Manifest 记 `builtin_catalog_digest` | 未加 | 注册表随代码发布，Attempt 已固定工具清单，摘要没有消费者 |
| 紧急停用范围（3.4） | 只对之后新建或恢复的 Attempt 生效 | 还在领取复核和逐次工具调用的执行门禁中拒绝，在途 Attempt 下一次调用即被拒绝 | 止损需要立即生效；复用现有执行门禁，无额外机制 |
| 目录比对（3.2） | 缺失工具在 Runtime 健康中报为降级 | 在 `GET /runtimes/builtin-tools` 的 `catalog` 中报告，不改变健康状态 | 缺少某个工具只影响用到它的运行，不应让 Runtime 整体降级 |
| 审批模式 | 未提及 | Agent 运行快照的 `approvalMode` 固定为 `never` | 原本由工具审批策略推导，内置工具均无需逐次审批 |
| 工具审计 | 未提及 | `tool_audit_logs.tool_version_id` 改名为 `tool_name` | 原外键指向已删除的 `tool_versions` |

验证：服务端单元测试、集成测试（含新增 `builtin-tools.integration.test.ts` 与发布治理中的联网开关、紧急停用用例）、OpenAPI 覆盖测试；管理端类型检查。管理端 vitest 与 Playwright 在本地环境执行。
