# PF-07 双账号隔离环境验收进度（2026-09-23）

**结论：部分真实链路已实测，PF-07 全量 P2 发布门禁仍未通过。** 本记录只陈述可复核的动作及边界，不将 Run 成功或工程探针通过等同于所有能力通过。脱敏的数据库快照见 [JSON 记录](pf07-oidc-isolated-progress-2026-09-23.json)。

| 项目 | 本轮固定信息 |
| --- | --- |
| 代码 | `fd045d256bfe7e444f6cd4e16e340fc87b4ed4b1`，本地提交，未推送或部署 |
| 环境 | `localhost:4174` 员工端、`localhost:4180` 管理端、`localhost:4190` API；专用可丢弃 PostgreSQL `dsh_work_pf07_oidc_f1eb4318f7bf4215b9ef343eeed7abee`，与日常开发库隔离 |
| 身份 | 两个不同的真实 OIDC 员工账号曾分别登录隔离库；本轮有证据的 Run 均由管理员账号发起。未完成另一账号的实际 Run 与撤权测试 |
| Runtime | DSH `0.1.2-rc.1`，提交 `76fda729799fe9b3848dbe2c211d4b231032b81e`，既有 Run/Attempt → ACP Adapter → DSH 链路 |
| 外部靶场 | 仅监听 `127.0.0.1:4317` 的可丢弃 Streamable HTTP MCP，写入回执存在工作区外的受限 JSONL 账本；没有调用企业生产连接器 |

## 已观察的链路

1. **MCP 调用与回执。** 真实 OIDC 工作台创建 Run `run-f9fca5d7-d9ee-442f-acc7-6546f77d7245`、Attempt `attempt-5535915a-c62b-405d-9861-a5886261338a`，均成功。DSH 通过平台固定的 Connector 调用了 `put_receipt` 和 `get_receipt`；两条 `mcp_invocation_audits` 关联同一 Attempt，靶场账本中的权威回执为 `receipt-0d1c32d9-6776-4fad-8bf5-ceccc6a7abae`。员工页面将目标标为“结果待核验”，故这只能证明 MCP 写入/查询与回执链路，不能单凭页面文案认定 PF-01 外部动作目标达成。
2. **凭据、清单和停用。** 使用真实 DSH 发现测试错误 Bearer，连接器变为 `offline`，旧固定引用被拒；恢复正确凭据后重新检查变为 `healthy`。靶场新增一个 Tool 后，重新发现得到 4 个 Tool，旧能力摘要被拒，新摘要可供新 Attempt。管理端停用后，旧引用被拒且新 Attempt 不再获得该 Connector；删除后列表消失，连接器标记删除，先前两条调用审计仍在。加密库中密文不包含明文 Token，已持久化 Manifest 也不包含 Token。以上是本地靶场的受控检查，尚未覆盖 MCP 超时/取消、第二个 Agent 或企业生产 MCP。
3. **受控记忆的发布与真实检索。** 本人从成功 Attempt 主动提交仅本人、30 天的非敏感测试偏好；管理员审核发布。新 OIDC Run `run-2750498e-1292-4862-8964-4a4d28e88edf` 经过 DSH 成功回答，并在正文及引用中把该条目标为非权威记忆。Attempt `attempt-ae81471a-20c5-4c56-b2d7-011ef45cf37c` 的 Manifest 固定 `memory-version-d38c9e62-cd65-4f00-9665-efaf8ee9b0c1`，`run_memory_sources` 指向原始来源 Attempt。审核期间曾发生管理端会话过期的 401；重新以真实 OIDC 登录后才完成发布，未把失败请求算作通过。
4. **撤回后的新运行。** 本人在用户中心撤回授权，界面显示“已撤回”。随后新建相同主题的 OIDC Run `run-19be241d-8f6d-4e20-95ba-f29f4f31492c`；其 Attempt `attempt-0d8d2a72-138b-41eb-9db7-d8fb465a7443` 无 `memory_context`，无 `run_memory_sources`。回答也声明当前没有可用记忆。此前已完成 Run 的固定来源仍保留。此项不证明“等待恢复期间撤权”，也不证明跨用户、跨角色、跨 Agent Version 隔离。

## 仍需完成

[能力矩阵](agent-platform-capabilities.v1.json)中的无 Session 任务、外部动作未知/重复回执、累计预算、持久化审批恢复、受控记忆的跨身份/角色/等待撤权、父子 Agent 委派，以及 MCP 的第二 Agent、超时/取消和真实企业连接器尚无本轮完整 P2 证据。应继续使用同一受控基线逐场景留存 Run/Attempt、权限变化、权威结果和验收人复核结论；不能将这个部分记录改为全量 `verified`。

本轮结束时已停止可丢弃 MCP 靶场、移除工作区外的明文测试 Token，并将 `localhost:4174/4180/4190` 恢复到原开发库 `dsh_work`；`/health` 返回 PostgreSQL 与 DSH 健康。隔离库暂时保留供复核，但不接入日常开发服务；受限的靶场回执账本仍留在工作区外。数据库快照是查询结果的脱敏副本，若最终销毁隔离库，应先按 [PF-07 运行手册](pf07-platform-acceptance.md)完成独立复核与归档。
