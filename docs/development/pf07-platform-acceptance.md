# PF-07 平台能力验收与运行手册

**矩阵版本：** `agent-platform-capabilities/v1`，代码基线 `3217cbb`。矩阵在 [agent-platform-capabilities.v1.json](agent-platform-capabilities.v1.json)；基线只是能力实现的起点，实际验收必须填写所部署的精确提交和版本。七项能力包括无 Session 任务、外部动作回执、累计预算、MCP、持久化等待、受控记忆和 Agent 委派。Token/成本硬预算、MCP Resources/Prompts/stdio、原 ACP Session 恢复及通用外部异步写连接器仍不在可发布能力之列。

## 分层执行

1. **P0 契约：** 在代码版本固定后运行 `pnpm test:pf07:matrix`、`pnpm test:m1` 和 `pnpm test:review:unit`。矩阵检查确保能力有 P0/P1 命令和 P2 场景；它不运行能力测试。
2. **P1 服务：** 只用专用可丢弃 PostgreSQL 运行 `pnpm test:pf07:p1`。MCP 管理的 P1 浏览器旅程另运行 `pnpm test:e2e:mcp-admin`；个人任务、审批与记忆的前端旅程按 [TEST-CATALOG](../../e2e/TEST-CATALOG.md) 选用现有 P0/P1 套件。记录每条命令、提交、运行环境、退出结果和失败日志引用。CI 执行 PF-01～PF-06 的服务集成套件；浏览器套件按对应配置单独执行。
3. **P2 真实链路：** 先固定目标部署、OIDC 身份、DSH Lock、Adapter、模型和批准连接。按矩阵逐场景执行真实 Run/Attempt，记录操作回执、审计/成果引用以及故障和撤权后的拒绝结果。MCP、等待及记忆的具体动作见 [TEST-CATALOG](../../e2e/TEST-CATALOG.md) 的 `PF-MCP-P2`、`PF-WAIT-P2`、`PF-MEMORY-P2`。无 Session、外部动作、预算和委派按矩阵场景逐项执行；委派必须核对父子 Run、根预算、真实身份撤权、容量耗尽、取消/重启及混合回执，不能以子回答文本作为权威成功。

## P2 记录与发布门禁

运行 `node scripts/acceptance/pf07.mjs --template > /tmp/pf07-evidence.json` 生成待填写记录；在受控位置填入每个场景的真实 `runIds`、`attemptIds`、`evidenceRefs`、结论，以及代码/部署版本、环境、时间、身份、DSH/Adapter/模型、批准能力、限制与验收人。引用应指向受控审计、测试报告或脱敏成果，不能粘贴 Token、凭据、敏感原文。不同环境或代码版本分别留记录；有影响执行语义的变更后重跑受影响场景。**不要直接将模板状态改成 `verified` 来代替实际验收。**

`node scripts/acceptance/pf07.mjs /path/to/pf07-evidence.json` 只检查字段、能力和场景完整性；验收人仍须逐项打开引用，核实真实身份、目标服务、Run/Attempt、动作效果和撤权/故障结果后签署结论。仅当 P0、P1、P2 在同一目标版本均通过，且所有适用场景被复核，才把这些平台能力开放给具体 Agent 发布。某能力未使用时可以在具体 Agent 的发布范围中排除它，不能在平台整体 P2 记录里伪造通过。

**当前证据状态：** PF-01～PF-06 代码级记录已存在。[2026-09-23 本地真实链路核对](pf07-real-chain-check-2026-09-23.md)记录了当前提交的单身份 OIDC、DSH 与外部 MCP 只读发现/调用及审计；它使用现有开发库，不能代替专用环境的全量 P2。此前 P2 只有口头结论，未提供版本、身份、环境和 Run/Attempt 等原始记录；它发生在当前平台能力形成之前，也不能作为 PF-07 的 P2 证据。2026-09-14 的真实 DSH 验收使用合成身份，也早于 PF-01～PF-06。PF-07 应按当前目标版本逐场景执行并留证，发布门禁仍未通过。
