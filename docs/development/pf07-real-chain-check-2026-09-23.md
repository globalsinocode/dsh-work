# PF-07 本地真实链路核对（2026-09-23）

**结论：** 当前提交的真实 OIDC → DSH → 外部 MCP 只读链路已核对；这不是 PF-07 全量 P2 验收记录，发布门禁仍未通过。

| 项目 | 可复核记录 |
| --- | --- |
| 执行代码 | 本地提交 `098ec8fce397a7602d534642bf0ee2d044146f7b`；未推送、未发布 |
| 环境 | `localhost:4180` 管理端、`localhost:4174` 员工端、`localhost:4190` 后端；现有本地 `dsh_work` 开发库，不是专用可丢弃 P2 库 |
| 身份 | 已登录的 OIDC 平台管理员 `max`；本次没有第二个真实身份或撤权动作 |
| Runtime | `/health` 报告 DSH `0.1.2-rc.1`、提交 `76fda729799fe9b3848dbe2c211d4b231032b81e`，ACP stdio，PostgreSQL 健康 |
| MCP 发现 | 管理端对既有 `skillhive` 执行“检查”后显示“已生效”、12 个工具，更新时间 2026-09-23 08:18（Asia/Shanghai） |
| MCP 调用 | 员工端请求仅调用 `list_capabilities`，不调用写入工具；Run `run-70558480-9606-4619-8b9a-387e5b1b9c9a`、Attempt `attempt-31cdf6d6-c919-40d2-8ce5-c2906236e285` 均为 `succeeded` |
| 审计 | `mcp_invocation_audits.id=mcp-audit-9d042b82-bd5e-4603-844e-91dced10292e`，`capability_name=list_capabilities`、`result=success`，发生于 2026-09-23 00:19:31 UTC，关联上述 Run/Attempt |
| 页面结果 | 展示只读查询回答；业务结果标为“结果待核验”，因为纯文本回答不构成已核验成果。不能将 Run 成功等同于业务目标达成 |

复核上述记录时，应在同一目标环境按 Run ID 查询 `runs`、`run_attempts` 和 `mcp_invocation_audits`；不要在验收文档中复制 Token、参数摘要或业务数据。运行中的服务和现有开发库并非固定的发布环境，记录只证明本次本地实测。

同一实现版本的自动化检查：`pnpm test:pf07:matrix` 2/2、`pnpm test:m1` 101/101、`pnpm test:review:unit` 103/103、`pnpm test:pf07:p1` 六组隔离 PostgreSQL 套件通过、`pnpm verify` 通过。`test:review:unit` 首次在受限沙箱中因本地 Unix socket `EPERM` 失败；使用允许创建该 socket 的本地权限重跑后 103/103 通过。自动化检查不代替真实 P2。

按[能力矩阵](agent-platform-capabilities.v1.json)和[验收手册](pf07-platform-acceptance.md)，后续仍需在专用可丢弃环境与固定提交上使用两个真实 OIDC 测试身份，逐项核对无 Session 任务、外部动作受理/未知回执、累计预算、MCP 凭据失败/清单变化/停用删除、持久化审批恢复、受控记忆和父子 Agent 委派的正常、故障、撤权、取消及重启边界。每项均需独立 Run/Attempt、审计或效果引用及验收人结论；此前仅有口头 P2 结论，不能补作这些证据。
