# PF-07 平台能力验收与运行手册

**矩阵版本：** `agent-platform-capabilities/v2`，代码基线 `3217cbb`。矩阵在 [agent-platform-capabilities.v2.json](agent-platform-capabilities.v2.json)；基线只是能力实现的起点，实际验收必须填写参考环境运行的精确提交和版本。门禁内的五项能力包括无 Session 任务、外部动作回执、累计预算、MCP 和受控记忆（Agent 委派已于 2026-10-16 删除）。持久化等待已于 2026-11-09 移出门禁（原因与恢复条件见矩阵 `deferred`）。Token/成本硬预算、MCP Resources/Prompts/stdio、原 ACP Session 恢复、持久化等待及通用外部异步写连接器仍不在可发布能力之列。

## 门禁范围

PF-07 是**平台能力门禁**，在受控的参考环境中证明能力实现与真实 Run/Attempt → Runtime Adapter → DSH 链路相符。参考环境是本机专用一次性数据库，使用真实 DSH 和模型、真实登录账号及批准的测试连接，可以安全地做故障注入和撤权。

**PF-07 通过不代表任何目标环境已验收。** Mac mini、生产环境和企业 MCP 按本手册“目标环境部署验收”逐环境留证，不在目标环境做破坏性故障注入，也不用目标环境的结果替代 PF-07 场景。两者都通过，能力才可以在该环境开放给具体 Agent。

## 分层执行

1. **P0 契约：** 在代码版本固定后运行 `pnpm test:pf07:matrix`、`pnpm test:m1` 和 `pnpm test:review:unit`。矩阵检查确保能力有 P0/P1 命令和 P2 场景；它不运行能力测试。
2. **P1 服务：** 只用专用可丢弃 PostgreSQL 运行 `pnpm test:pf07:p1`。MCP 管理的 P1 浏览器旅程另运行 `pnpm test:e2e:mcp-admin`；个人任务、审批与记忆的前端旅程按 [TEST-CATALOG](../../e2e/TEST-CATALOG.md) 选用现有 P0/P1 套件。记录每条命令、提交、运行环境、退出结果和失败日志引用。CI 执行 PF-01～PF-05 的服务集成套件；浏览器套件按对应配置单独执行。
3. **P2 真实链路：** 先固定参考环境、代码提交、登录身份、DSH Lock、Adapter、模型和批准连接。按矩阵逐场景执行真实 Run/Attempt，记录操作回执、审计/成果引用以及故障和撤权后的拒绝结果。MCP 及记忆的具体动作见验收目录的 `PF-MCP-P2`（[管理端与平台](../../e2e/catalog/admin-platform.md)）与 `PF-MEMORY-P2`（[Agent](../../e2e/catalog/agents.md)）；`PF-WAIT-P2` 随持久化等待移出门禁，恢复时再执行。`pnpm test:pf07:p1` 继续运行 PF-04 集成套件，作为代码回归，不构成该能力的发布依据。无 Session、外部动作和预算按矩阵场景逐项执行。

## P2 记录与发布门禁

运行 `node scripts/acceptance/pf07.mjs --template > /tmp/pf07-evidence.json` 生成待填写记录；在受控位置填入每个场景的真实 `runIds`、`attemptIds`、`evidenceRefs`、结论，以及代码/部署版本、环境、时间、身份、DSH/Adapter/模型、批准能力、限制与验收人。引用应指向受控审计、测试报告或脱敏成果，不能粘贴 Token、凭据、敏感原文。不同环境或代码版本分别留记录；有影响执行语义的变更后重跑受影响场景。**不要直接将模板状态改成 `verified` 来代替实际验收。**

`node scripts/acceptance/pf07.mjs /path/to/pf07-evidence.json` 只检查字段、能力和场景完整性；验收人仍须逐项打开引用，核实真实身份、目标服务、Run/Attempt、动作效果和撤权/故障结果后签署结论。P0、P1、P2 在同一代码版本均通过且所有适用场景被复核，才算通过 PF-07；影响执行语义的变更后重跑受影响场景。具体环境还须完成目标环境部署验收，才把这些平台能力开放给该环境的具体 Agent 发布。某能力未使用时可以在具体 Agent 的发布范围中排除它，不能在平台整体 P2 记录里伪造通过。

**当前证据状态：** PF-01～PF-05 代码级记录已存在。2026-09-23 的双账号隔离环境进度记录了真实 OIDC 的 MCP 写入、审计与回执，以及私人受控记忆的发布、检索和撤回；另一账号的实际 Run、审批与预算等场景仍未完成，不能当作全量 P2。较早的本地真实链路核对使用现有开发库和单身份，也不能代替专用环境验收。此前 P2 只有口头结论，未提供版本、身份、环境和 Run/Attempt 等原始记录；它发生在当前平台能力形成之前，不能作为 PF-07 的 P2 证据。2026-09-14 的真实 DSH 验收使用合成身份，也早于 PF-01～PF-06。PF-07 应按当前代码版本逐场景执行并留证，上述记录均不构成门禁通过；最新结论见下文。

2026-11-09 在本机专用一次性数据库（`115888e`，真实 DSH `0.1.2-rc.1`、DeepSeek `deepseek-v4-pro`、本地独立账号，非 OIDC）执行一轮：P0（`pnpm test:pf07:matrix`、`pnpm test:m1`、`pnpm test:review:unit`）与 P1（`pnpm test:pf07:p1`、`pnpm test:e2e:mcp-admin`）通过，`test:m1` 首次有 4 个真实 Docker 用例因缺镜像跳过，拉取 `python:3.12-slim` 后重跑 209 个用例全部通过。该轮执行时矩阵共 25 个场景；其中 5 个随后移出门禁，`real-oidc-task` 已从矩阵删除（AI Hub/OIDC 登录计划删除，未验证），门禁内现为 19 个。验收人（max）已确认全部 19 个（其中 4 个在同一运行代码的第二个专用一次性库补测）；证据记录已由验收人标记 `verified`，PF-07 平台能力门禁在参考环境通过，分类如下。证据只代表该本机环境，不代表 Mac mini 或生产部署，记录保存在 Git 工作区外的受控位置。

| 分类 | 数量 | 场景 |
|---|---|---|
| 验收人已确认（本地账号） | 15 | `session-neutral-task`：`real-dsh-task-result`、`revocation`、`runtime-failure`；`external-action`：`accepted-receipt`、`duplicate-delivery`；`cumulative-budget`：全部 4 项；`mcp-connector`：`real-discovery-and-call`、`credential-failure`、`catalog-change`、`disable-and-delete`；`controlled-memory`：`real-recall`、`version-isolation` |
| 验收人已确认（补测，本地账号） | 4 | `mcp-connector/secret-boundary`；`external-action`：`unknown-reconciliation`、`revocation`；`controlled-memory/identity-and-role-change` |
| 已移出门禁（未通过，不计入） | 5 | `persistent-wait`：全部 4 项；`controlled-memory/revocation-while-waiting` |

**移出门禁的原因：** 真实 Agent 的 `approvalMode` 固定为 `never`（[postgres-agent-service.ts](../../server/src/modules/agent/postgres-agent-service.ts)），真实 Run 进不了持久化等待，当前也没有需要人工审批的业务动作。这些场景没有通过，只是不再属于本门禁；持久化等待不得开放给 Agent 发布，首个需要人工审批的动作准入时恢复并在该版本重跑 P0、P1、P2。

**受控记忆口径：** 员工端受控记忆已按产品决定移除（`MEMORY-EMPLOYEE-REMOVAL`），经验由管理员审核后按组织可见发布。`identity-and-role-change` 按现行模型验收：其他 Agent 不召回；Agent 岗位角色变化、来源员工停用、经验版本停用后不再使用；员工失去工作台权限时拒绝运行。

**拒绝类场景：** `mcp-connector/credential-failure` 与 `session-neutral-task/revocation` 在创建 Run 之前拒绝，“没有 Run”正是要验证的结果。矩阵用 `p2RejectedBeforeRun` 显式列出这类场景，它们可以不填 Run/Attempt，但仍须有通过结论和 traceId、execution 等证据引用；其他场景仍必须有 Run/Attempt。

**外部动作口径：** `external-action` 按平台写工具的 Task Operation（`task_operations`）验收；MCP 调用不产生 Operation，其回执与 `mcp_invocation_audits` 归入 `mcp-connector`。

## 目标环境部署验收

每个目标环境、每次发布都要执行，由该环境的负责人操作并留证，操作入口见[部署手册 9.4 节](../release/mac-mini-deployment-runbook.md#94-目标环境部署验收)。自动部署没有等待本清单的拦截点，新版本会先被安装；清单完成前，不在该环境开放新版本带来的新能力；已开放的能力继续运行，同时按发布问题跟踪，清单未通过时回退版本或停用相关 Agent。需要先验收后安装的环境应关闭自动部署。只做不破坏业务的检查，使用专门的验收账号、Agent 和可清理的数据，不用测试替身。证据包括版本、环境、执行时间、身份、Run/Attempt 引用和结论，保存在 Git 工作区外的受控位置，不粘贴 Token、凭据或敏感原文。

| 检查项 | 通过标准 |
|---|---|
| 版本与运行依赖 | 部署的版本、提交、DSH Lock、Adapter、默认模型路由和执行镜像摘要逐项记录，并与通过 PF-07 的记录比对；有影响执行语义的差异时，先重跑受影响的 PF-07 场景 |
| 服务与入口 | 按部署手册 9.1 节检查健康状态和 HTTPS 证书；从另一台已信任根 CA 的局域网电脑确认 4174/4180 可访问，4190/5434 不可访问 |
| 登录身份 | 用该环境实际使用的身份来源登录，普通员工访问管理端 API 被拒绝。使用 AI Hub/OIDC 的环境，还要完成部署手册 9.2 节的管理员认领、目录同步和 `OIDC_ONLY` 检查，用 OIDC 身份完成一次真实 Run，并验证上游账号停用、目录同步后新请求被拒绝；PF-07 没有覆盖 OIDC，这是该环境 OIDC 链路的唯一验收证据 |
| 模型路由与数据防护 | 一次真实对话经默认路由成功，遮盖和用量记录正常 |
| 执行与隔离 | 一次使用执行容器的真实任务成功，输出、事件流和成果可用；另起一次任务验证取消生效 |
| MCP（使用时） | 该环境批准的 MCP 服务发现成功，一次只读调用成功并有审计。含写工具的连接器，要在批准的可清理目标上完成一次写入并核对权威回执；未验证写入的连接器只开放只读 |
| 撤权 | 撤销员工角色后新任务被拒绝，撤销第二位管理员的权限后下一次管理端 API 请求被拒绝，均以 API 结果为准；验证后恢复或清理账号 |
| 备份与恢复 | 在无运行中任务的维护窗口执行备份（会短暂停止后端），异机副本的校验回执存在。恢复演练只在隔离环境进行，并抽查 Skill 文件可按 `artifact_ref` 校验；不在目标环境运行 `restore.sh` |

**当前状态：** 各目标环境均未按本清单完成验收。2026-11-09 Mac mini 的人工验收未按本清单留证，备份也不满足异机要求。

## 可丢弃 MCP 写动作靶场

`pnpm test:pf07:fixture` 检查本地 Streamable HTTP MCP 的 Bearer 拒绝、工具清单、幂等写入、冲突与超时后权威回执；这一层只验证测试靶场自身。`pnpm probe:pf07:mcp` 从 `.env` 解析当前锁定的真实 DSH，临时启动仅监听 `127.0.0.1` 的靶场，执行发现及一次真实模型驱动的 MCP 写入和回执查询，最后销毁靶场与 Attempt 工作目录。脚本只输出工具名、临时 Run/Attempt ID、回执 ID 和脱敏调用结果，不输出临时 Bearer Token。

`pnpm probe:pf07:mcp:platform` 在 `DSH_WORK_TEST_DATABASE_URL` 指向的本地 PostgreSQL 维护实例中自建、迁移并销毁一次性数据库。它使用合成用户与真实平台服务登记、加密存储、解析 MCP；经真实 Run/Attempt → DSH 验证 Agent Version 的 `selected`、`none` 范围：写入和查询外部回执、审计实际 MCP 调用、排除未选 Connector，并用默认文件工具生成可从 Artifact 存储读取的文件。随后验证错误凭据、工具清单新增须确认、停用、删除、选定连接失效时拒绝新 Attempt，以及 Manifest 不含密钥。脚本的外部工具审批回调固定为测试允许，且会销毁数据库、文件和测试回执；这是隔离的工程回归，不能作为真实 OIDC 身份、人工审批或可事后查询的 P2 记录。命令只接受回环 PostgreSQL，禁止指向开发业务库或生产库。DSH 与生产一致经执行容器运行（[执行隔离方案](../design/execution-isolation-plan.md) 4.9，与服务共用启动检查）：须设置 `DSH_WORK_EXECUTION_IMAGE` 指向本机已拉取、按摘要锁定的执行镜像，检查失败时探针直接失败、不回到宿主执行；启动检查会清扫遗留的 `dsh-exec-*` 容器，不要在本机服务有运行中的 Agent 任务时执行。

单独长时间运行靶场时，先在 Git 工作区外建立权限为 `0600` 的 Token 文件，设置 `PF07_MCP_TEST_TOKEN_FILE`，再运行 `node scripts/acceptance/pf07-mcp-fixture.mjs`；可设置 `PF07_MCP_TEST_PORT` 固定回环端口、`PF07_MCP_RECEIPTS_PATH` 保存权威写入 JSONL，以及 `PF07_MCP_CATALOG_VERSION=2` 模拟新增工具。不要把 Token 或回执文件提交到仓库。完成后停止服务，并清理一次性连接器、数据库和记录。

直接的 DSH Adapter 探针绕过了 dsh-work 的 Connector 数据库、加密存储、当前授权复核及持久化 Run/Attempt；隔离数据库探针虽补齐了这些链路，但使用合成身份与测试审批。因此**不能**把它们记录为矩阵中 `real-discovery-and-call` 的完整 P2 通过。P2 仍需在专用可丢弃数据库中通过管理端登记该靶场，使用真实登录身份创建 Run，由平台解析 Connector 并检查保留的 `mcp_invocation_audits` 与靶场回执；再在相同代码版本上执行凭据错误、清单漂移、停用删除和密钥边界等矩阵场景。外部动作的受理回执按平台写工具的 Task Operation 单独验收。生产企业 MCP 的行为还需单独验收。
