# MCP 按 Agent 选择与能力变更确认方案

**状态：** 已实施（2026-10-21）。<br>
**决策日期：** 2026-10-21<br>
**原则：** 系统尚未正式上线，设计与实现尽量简化，不考虑存量数据兼容和历史方案。

## 1. 决策

1. **MCP 按 Agent 选择。** Agent Version 的 MCP 使用范围只有 `selected`（选定连接器，1～20 个）和 `none`（默认）。废弃 `all`。
2. **能力变更须确认。** 连接器新增的 Tool、输入 Schema 变化的 Tool 须管理员确认后才生效；远端删除的 Tool 立即下线；只改描述自动生效。
3. **去掉租户级 20 个连接器上限。** 单次 Attempt 的连接器数只由 Agent 选择决定，已有 ≤ 20 的校验。
4. **MCP 代码从 `PostgresToolConnectorService` 拆出。** agent 模块与 MCP 模块不再互相读对方的表。

## 2. 使用范围

- `normalizeAgentMcpScope` 只接受 `selected` / `none`，收到 `all` 返回 422。
- 迁移 0094：`all` 改为 `none`，约束只允许 `selected` / `none`，列默认值为 `none`。
- 管理端删除“全部可用 MCP”选项；所有缺省回退为 `none`。
- 删除 `lockMcpConnectorCapacity` / `assertMcpConnectorCapacity`。

## 3. 能力确认

### 3.1 数据

`mcp_connector_profiles`：

| 字段 | 含义 |
| --- | --- |
| `capability_snapshot` / `capability_digest` | 最近一次成功发现的完整清单（已有） |
| `approved_snapshot` / `approved_digest` | 生效清单，运行时只允许调用其中的 Tool（新增 `approved_snapshot`） |
| `approval_status` | `approved`：没有待确认项；`changes_pending`：有待确认项 |

迁移 0095 新增 `approved_snapshot`，并以现有 `capability_snapshot` 填充。

### 3.2 检查后的合并规则

每个 Tool 以 `name` 和输入 Schema 摘要 `schemaDigest = sha256(canonical(inputSchema))` 识别。设发现清单为 D，原生效清单为 P：

- 新生效清单 P' = P 中 `(name, schemaDigest)` 仍存在于 D 的 Tool，描述取 D 中的最新值。这条规则同时做到了删除即下线、Schema 变化即暂停、只改描述自动生效。
- 待确认项 = D 中不在 P' 里的 Tool，即新增 Tool 与 Schema 变化后的 Tool。
- `approval_status` = 待确认项为空 ? `approved` : `changes_pending`。
- P' 为空时连接器不可解析给 Agent（等同不可用），健康状态照常记录。

登记时 P = D，管理员已在连通测试中看过完整清单。

### 3.3 确认

`POST /connectors/mcp/capabilities/approve { connectorId, capabilityDigest }`：仅当 `capabilityDigest` 仍等于当前发现摘要时，把 D 设为生效清单，否则返回 409 要求刷新。写审计 `connector.mcp.capabilities.approve`。管理端连接器列表显示待确认的 Tool（新增或 Schema 变化），并提供“确认生效”按钮。

### 3.4 运行时

- Manifest 的 `capability_digest` 固定的是 `approved_digest`。在途复核保持“摘要相等”：生效清单一旦变化（确认、删除、描述变化），该连接器上的在途 Attempt 就停止。这是为了简单而接受的代价。
- `DSH_APPROVED_MCP_CAPABILITIES_JSON` 改为 `[{ serverName, tools: [{ name, schemaDigest }] }]`。`dsh-work-tool-policy.js` 逐个 Tool 放行：Tool 在生效清单中，并且 DSH 当前加载的该 Tool 参数 Schema 摘要相同。远端新增的未确认 Tool 不再导致整个 Server 被拒绝。
- 未确认的 Tool 仍会出现在 DSH 加载的工具列表中，模型能看见，但调用会被拒绝。

## 4. 模块拆分

新增 `server/src/modules/tool/postgres-mcp-connector-service.ts`（合并规则在 `mcp-capabilities.ts`），承接 MCP 登记、测试、检查、凭据轮换、启停、删除、能力确认、运行时解析与调用审计。

- `resolveConnections(scope)`：由调用方传入 Agent Version 的 scope，MCP 服务不读 `agent_versions`。
- `validateSelection(connectorIds)`：agent 服务改为调用它，不再直接查询 `connectors`。
- `assertPinnedConnections(pins)`：只核对 Manifest 固定的连接，不再重新解析整个 scope。
- 删除检查与删除流程中对 MCP 的 `tools` / `tool_binding_revisions` 遗留写入。
- `PostgresToolConnectorService` 只保留 DSH 内置工具与绑定修订。

## 5. 不在范围

逐 Agent 的 Tool 级选择、MCP 读写分级、验证中真实执行 MCP、连接器“必需 / 可选”区分、DSH 内置工具注册表整理。
