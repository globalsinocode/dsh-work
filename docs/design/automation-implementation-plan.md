# AG-03 轻量自动任务实施方案

**状态：** 已按确认的轻量语义修订，待实现与验证；本文不代表代码已交付。<br>
**更新日期：** 2026-09-17<br>
**上游文档：** [企业内部智能体与工具开发、发布及自动化方案](agent-tool-extension-and-automation-plan.md) §9、§11、§12、§16；本次同步调整上游行为要求与 AC-20～24。<br>
**阶段依赖：** 使用 AG-01 已发布、已有批准工具的 Agent；不等待 AG-02 新工具或 AG-04 经验能力。<br>
**执行边界：** [内部端口与契约](../development/internal-ports.md)、[架构总览](../development/overview.md)、[Runtime 执行架构渐进优化方案](runtime-execution-optimization-plan.md)。

## 1. 产品定位与首版范围

首版只做**按计划发起普通员工任务**。参考 Octop 的调度职责划分：保存规则，到点发起平台已有执行流程，展示结果；dsh-work 的执行入口始终为 Run/Attempt → Runtime Adapter → DSH。

| 能力 | 首版语义 |
| --- | --- |
| 创建与启用 | 选择已发布版本、本人身份、确定性输入和 Workspace，结构化配置每日/每周/手动及 IANA 时区，本人确认启用 |
| 任务试运行 | 可选，复用 DSH 运行并展示真实结果；不以任务级成功证据作为启用前置，Agent 发布证据和确定性准入检查仍必需 |
| 调度部署 | 单进程、单一调度所有者；不支持多实例同时调度及自动接管 |
| 执行隔离 | 每个新触发独立 Session，固定 Agent Version，不带入原会话历史 |
| 停机遗漏 | 不补跑；保留遗漏区间及原因，恢复后安排下一个未来槽位 |
| 准备中断 | 无 Attempt 的已受理 Run 失败收敛，不续办准备 |
| 执行失败 | 不自动重试；用户明确再次运行时产生新手动触发和新 Session/Run |
| 已提交 Attempt | 复用 Run 恢复：当前 queued Attempt 恢复领取并鉴权，丢失 Worker 的活动 Attempt 失败 |
| 结果交付 | 复用 Session 消息、成果与对象权限；不新增独立投递状态机、外部通知和通知重试系统 |
| 配额 | 平台默认限制、每任务不重叠、简单每用户/全局待处理上限、自动任务并发限额和交互余量 |

不进入首版：NL 频率解析、服务主体、代他人授权、动态跟随 Agent 最新版、经验选择、新工具接入、无人值守人工审批、自定义 token/磁盘预算、补跑、自动重试、跨阶段准备租约和多进程恢复协议。

轻量语义允许服务中断导致漏一次执行，但不能静默丢失失败，也不能重复创建业务运行或使用失效权限。UI 要展示此承诺，不宣称任务必达、外部工具效果恰好一次或完整多实例执行安全。

## 2. 业务流程

```text
员工：选择已发布 Agent → 配置输入/归属/日历 → 可选试运行 → 查看默认限制并确认启用
系统：到期 → 当前资格和对象准入 → 任务锁内去重/判重叠/冻结配置
      → 原子保存触发记录 + Session + Run + 关联 + 游标
      → Run 模块准备并提交 Attempt → 现有 Scheduler → Runtime Adapter → DSH
结果：列表读取 Run 状态 → 打开 Session 消息与成果
失败：记录明确原因；不补跑、不自动重试，用户可再次立即运行
```

执行面编辑须重新检查并确认；未确认的修改保持暂停或草稿，不继续触发。暂停停止新触发及未开始执行，取消当前运行复用 Run 端口。暂停不自动取消已经开始且仍获授权的执行。

`run-now` 仅对已确认配置的 enabled 任务执行当前权限检查后受理；paused 任务须先重新启用（重新确认上限）再走 run-now，比原方案更严格。draft 或未确认的修改不能通过该入口绕过启用检查。可选试运行有单独明确入口，仍受本人权限、能力审批及平台容量限制。

## 3. 日历、去重与遗漏

### 3.1 日历契约

```ts
type AutomationSchedule =
  | { kind: 'manual'; timezone: string }
  | { kind: 'daily'; timeOfDay: string; timezone: string }
  | { kind: 'weekly'; timeOfDay: string; weekdays: number[]; timezone: string }
// timeOfDay 服务端校验 HH:mm；weekdays 为去重且非空的 0..6（Sun..Sat，cron 惯例）
```

- 时区使用服务端支持的 IANA 标识；timezone 只有一个权威存储位置，UI 不提交两份独立值。
- 引入钉版本的 `cron-parser`，外层只接受上述最小语法；不迁入 APScheduler 或第二个调度服务。
- `nextSlot()` 同时用于预览与调度；本地时刻不存在则跳过，重复时刻取第一次。库的行为须由 DST 契约测试验证，必要时在封装中落实规则。
- 定时 `trigger_id` 来自规范化编码的 `(automation_id, schedule_revision, planned_slot_utc)` 摘要；手动来自 `(automation_id, manual, request_idempotency_key)`，不使用领取时间。
- 手动请求保存配置 revision 和规范化请求指纹；同键异请求拒绝，同键重放返回原记录，不能按新的可变任务配置再次运行。新的再次运行由用户明确动作产生新键。

### 3.2 游标与遗漏

持久化 `next_slot_utc` 作为本规则下一次未处理槽位；正常调度留痕与推进游标在同一短事务内完成。正常轮询允许固定、有界的迟到容差，阈值由模块配置并在测试中固定；超出容差记录遗漏而不执行，不把长期延迟转换成 catchup。

启动恢复先处理已有 Run/Attempt 和准备中断，再恢复未来日历。停机期间的到期槽位合并为一条遗漏区间记录，保存起止、schedule revision 及原因；不逐槽铺开历史，不补跑。遗漏留痕和游标推进原子提交，重复启动不能重复登记同一区间。

首次启用、改规则或重新启用均从确认时间之后的下一个槽开始，不运行旧规则或暂停期间的槽位；暂停/修改操作保留时间与修订审计。手动任务没有自动槽位。旧规则回调到达时事务内复核 status、schedule revision 和槽位，不符合则不得创建运行。

## 4. 最小数据模型

以下为逻辑字段，具体 SQL 类型、外键及迁移由实现固化。

```text
agent_automations
  id, tenant_id, owner_user_id, agent_version_id, workspace_id
  schedule, schedule_revision, next_slot_utc
  input_template, scope_ceiling, confirmed_config_revision
  revision, status(draft | enabled | paused | disabled), created_at, updated_at

automation_executions
  id, tenant_id, automation_id, trigger_id
  kind(scheduled | manual | missed)
  planned_slot_utc / missed_from_utc / missed_to_utc
  task_revision, request_fingerprint, execution_config
  session_id, run_id
  admission_status(accepted | skipped | interrupted), reason_code
  created_at, updated_at
```

- 唯一键 `(tenant_id, automation_id, trigger_id)`；关联按租户约束，非空 Session/Run 关联唯一；accepted 记录与 Session/Run 同事务生成，skipped/missed 记录不创建 Run。
- `execution_config` 在受理时冻结版本、身份、Workspace、授权上限、模板、固定文件版本及查询窗口。恢复读取关联与已有 Attempt，不读取可变任务内容重建输入。输入引用需保留且重新鉴权。
- 执行状态不存第二份 `running/succeeded/failed`：通过 run_id 读取 Run。`admission_status` 仅说明触发受理、跳过或准备中断；无 Run 时不得假装执行成功。
- 每任务判重叠在锁定任务行后查询已受理且未终结的 Run，包括无 Attempt 的 queued Run 及 cancel_requested；任何手动和定时受理都走此锁。重叠直接写终态 skipped，不依赖活动状态部分唯一索引制造冲突。
- 不新增 `delivery_status`、审批快照比较状态机、强制 `trial_evidence` 门禁或跨阶段 claim token。`input_template.budget` 允许以可选字段携带 `timeoutSeconds`/`maxToolCalls`/`maxOutputBytes`，受理时冻结并钳制进 Manifest limits（不得超过 Agent 与运行时政策上限），不是独立计费或硬预算承诺。审批按当前实际能力在准入时判定，不允许通过删除快照放松策略。
- config revision 是经规范化的执行配置摘要，日历单独修订。上限变更须展示并确认，不因暂停后重启或重新获权而悄悄扩大。

## 5. 身份、权限与能力准入

### 5.1 后台身份

由 identity/authorization 提供后台主体解析，不伪造 HTTP `RequestIdentity`，不保存浏览器 Cookie 或长期 OIDC Token。生产校验用户 active、business_user、租户有效和可信目录新鲜度，并记录审计。

目录新鲜度读取匹配 application/environment 的同步状态，使用现有 `last_succeeded_at`，而不是不存在的 `synchronized_at`。采用明确的最大有效时长配置；从未成功、失败或超窗均拒绝。正在同步时仅在最近成功仍新鲜且没有尚未恢复的失败事实时可用；需保留失败事实，不能因开始重试把失败清空就恢复准入。同步间隔为零不代表永久可信，也不将新鲜度阈值乘成零。测试受控身份与生产 OIDC 分开，生产不可回退。

### 5.2 授权上限与当前资格

`authorizeRuntime` 增加独立 `scopeCeiling` 语义，以当前权限和启用时批准上限计算交集，再校验 Agent、Skill、Tool 所需资格。不能复用现有取并集的 `dataScopes` 参数。角色、权限及数据范围按交集重新解析，供 Manifest、知识查询及工具执行使用。

复核落点：

1. 配置/启用/触发受理：当前主体、Workspace、精确版本、输入、依赖及工具审批；仅允许已批准且无需人工审批的能力。无法确定某工具是否可无人值守时拒绝，不自动批准。
2. 实际执行前：在现有 Run 复核中覆盖 automation 的个人及团队空间，复核当前主体、对象授权、上限、工具政策与暂停/取消。若不可变 Manifest 携带的输入或权限已超出当前许可，拒绝该 Attempt；不能原地改写或只求出较小交集后仍运行旧快照。
3. 活动运行及外部调用：复用并补齐现有撤权和工具边界，覆盖账号、个人/团队空间、角色、数据范围及能力紧急撤销；只重查 subject 不足以覆盖对象撤权。
4. 结果持久化/读取：复用内容服务对象权限，未授权不能把结果写入另一个 Workspace 或通过自动任务列表泄露正文。

普通 Agent/Tool 停用停止新准入并清理队列，仍获授权的活动运行可排空；紧急撤销阻止后续调用并取消活动运行。暂停处理排队与尚无 Attempt 的 Run，明确取消才停止已开始任务；安全撤权不等待确认。

轻量化没有消除这些已有链路的缺口。相关分支、数据范围求交和撤权覆盖必须按 AC-22 验证后才能上线。

## 6. 原子受理、准备与故障收敛

### 6.1 端口与事务边界

Run 模块提供可组合的自动任务受理入口，conversations.createSession、runs.createRun 和 Automation 的关联写入端口接受同一事务上下文。协调方通过各模块端口完成写入，不直接复制 Run 逻辑或跨模块操作私有表。复用现有 Workspace/Session/Run 锁顺序，并明确 Automation 任务锁在整体顺序中的位置；暂停、归档和受理按相同规则处理。

受理成功返回原关联及本次是否新建；只有新建者执行初次准备。同键重入首先查询已有记录、校验请求一致性并返回，不重复调用 dispatch。事务内不做文件下载、外部目录调用或 DSH 执行；提交后的运行准备仍重查当前权限。

单进程内按 execution 串行化首次准备与暂停等动作，复用 Run 服务的取消检查与安全提交；不得在已取消或已失去准入资格的 Run 上新建 Attempt。首版不提供“认领超时后由另一个实例续办”。

### 6.2 启动恢复

| 持久化事实 | 启动处理 |
| --- | --- |
| 受理事务未提交 | 没有部分 Session/Run/关联；过期日历槽记遗漏，手动同键重发仍走确定性去重 |
| 已关联 Run、尚无 Attempt | 通过 Run 端口将 queued Run 收敛失败并记录准备中断，原关联保留；不续办准备 |
| 当前 Attempt 已提交且 queued | 由现有 Run 恢复重新入队并鉴权，复用持久化 Manifest；不再创建 Attempt |
| 活动 Attempt 丢失 Worker | 复用现有重启失败收敛，不自动重试 |
| Run 已终结 | 只读取既有结果；记录陈旧不触发再次执行 |

单一调度所有者通过部署约束和进程存活期排他机制保证；额外实例必须拒绝进入同一运行服务的调度/启动恢复，不可把另一个存活进程的运行当成遗留记录失败收敛。此排他机制不承担跨阶段租约或多实例自动接管。

启动收敛完成再开放自动调度；周期扫描不并行执行一次完整“服务重启恢复”。本进程正常准备错误立即收敛，不留幽灵 queued Run。对仍存活的准备操作，取消和默认准备超时必须先停止后续提交，再标为中断，不能仅按记录年龄误杀并让迟到准备继续提交。

### 6.3 再次运行与 purpose

首版失败后的用户操作为“再次立即运行”：新请求键、新触发、新 Session/Run；同一 HTTP 请求重放不算再次运行。既有通用 Run retry 入口若未接入自动任务上限、任务状态及重叠检查，应明确拒绝 automation 来源并引导此操作；不允许借通用入口绕过限制。现有非自动任务的 Run 重试语义不变。

保留 `purpose='automation'` 用于可信用途授权、队列分类与审计，由服务端设置。同步 Runtime 类型、Schema、授权及消费者：Schema 不再把所有有 purpose 的运行都视为管理运行；Adapter/成果服务仍为 automation 提供员工成果能力；AdminPurpose 类型只覆盖管理用途，不能随 Runtime purpose 全集扩张。该工作不产生新执行引擎。

## 7. 默认限制与交互容量

- 不开放任务级 token/磁盘预算表单或独立累计计费控制；`input_template.budget` 三个可选上限仅作为 Manifest limits 的收紧钳制，超出平台/执行器默认限制的部分不生效。准入只开放限制机制可执行的工具。
- 现有 Manifest limits 为 timeout_seconds、max_output_bytes、max_tool_calls；输出字节上限不是模型 token 或磁盘硬预算。文件/沙箱沿用各自大小、配额和资源限制，用量仍按现有链路记录；未实现的硬预算不得展示为已强制执行。
- 模块配置每用户/全局 pending 上限及自动任务并发限额；超 pending 上限明确跳过或拒绝并留证，不无限排队。
- 自动任务并发上限不得占用全部 Runtime 容量。使用总容量与交互保留量计算有效上限，计数与领取在现有数据库事务中完成；尚未释放的取消中 Worker 计入占用。总容量不足以同时保留交互余量时，自动任务显示容量不足，不静默吞掉交互容量。
- 调度时自动任务超限须继续寻找可运行的交互任务，不能沿用“队首失败即退出”而阻塞后续任务。遍历有界，避免忙轮询。

## 8. 结果与用户界面

结果直接进入当前执行 Session 的消息与成果列表，列表链接该 Run/Session；不创建 delivery_status 或独立投递 pass。必要消息、成果引用持久化成功且归属和权限正确，才可展示相应结果已生成；Session 已存在和模型自报完成均不能替代证据。

必要结果持久化失败须在现有 Run/内容错误通道中明确展示，不能静默记成功。Run 已成功后若仅刷新或读取失败，保留原 Run 终态，显示读取错误；修复或重读结果不重新调用 DSH。已有事件投影的幂等与恢复继续复用，不在 Automation 另造一套。

工作台复用应用壳层，提供“我的自动任务”、配置/编辑、可选试运行、启用/暂停、立即运行/再次运行、取消当前、记录与结果链接。显示固定版本、时区、下一次运行、默认限制、最近结果及跳过/遗漏/准备中断；启用时告知停机不补跑、失败不自动重试。错误不只通过 toast 展示，刷新可恢复服务端事实。停用是归档语义：任务退出列表且历史执行记录随之不可读，停用确认弹窗向用户明示该后果；需要保留可读历史时应选暂停。

接口族仍为 `/api/workbench/v1/automations` 及 `trial-runs`、`enable`、`pause`、`run-now`、`executions`；取消复用 Run 授权端口。只管理本人任务，变更绑定 revision，写入用幂等键；Schema/API 代码实施时同步 OpenAPI，本次不伪造已实现契约。

## 9. Octop 参考与采用边界

参考依据为 2026-09-17 核对的本地 Octop checkout：`src/octop/infra/cron/{manager,job,delivery,trigger}.py` 与 `infra/db/repos/cron.py`。这是一份观察记录，不是上游永久行为承诺，也不引入 Octop 执行框架。

| 已核对机制 | 本平台采用方式 |
| --- | --- |
| CronManager 管理规则并调度 job.run，run_now 发起同一工作流 | 调度只发起已有平台运行；继续使用 Node 与 DSH |
| CronJob 回写 last_run_at/status/error 并留审计 | 列表给出最近结果；具体运行状态直接复用 Run |
| Delivery 在 Session 锁内调用现有 AgentManager.stream | 借鉴复用已有执行入口；dsh-work 仍每次独立 Session 并经 Run/Attempt |
| 执行时检查 Session 归属，按用户处理 MCP 和可见知识库 | 不再描述为“仅创建时鉴权”；本平台仍须满足自己的当前权限、目录新鲜度和授权上限 |
| 历史投影与 dashboard 通知包含 best-effort 路径 | 首版直接使用现有消息/成果，不引入外部通知；必要结果持久化失败不能静默吞掉 |

不照搬活 Agent 配置、默认复用原 thread、Agent 自主创建计划或直接 stream 的执行路线。任务存在唯一记录不意味着工具效果恰好一次；单进程简单调度也不意味着天然支持多实例。代码行数不能推导可靠的工期或成本倍数。

## 10. 验收与实施顺序

| AC | 验收重点 |
| --- | --- |
| AC-20 | 同槽/同手动键去重，异输入拒绝；事务无部分关联；无 Attempt 的准备中断失败，有 queued Attempt 恢复且不重复创建 |
| AC-21 | 时区/DST 预览一致；停机、暂停、改规则不补旧槽；遗漏留痕；失败不自动重试，再次运行是新触发 |
| AC-22 | 个人/团队空间当前授权、上限交集、主体新鲜度、工具政策及活动撤权；旧 Manifest 越权时拒绝 |
| AC-23 | 无任务试运行也能在门禁和确认后启用；固定版本与独立 Session；暂停清理未开始运行，恢复不复活旧执行 |
| AC-24 | 结果与成果可读有据、持久化/读取失败可见且不重跑；默认限制、自动任务限额与交互余量、队首不阻塞 |

关键旅程登记在 [E2E 验收目录](../../e2e/TEST-CATALOG.md)，全部为计划，尚无运行证据。P0 只证明原型导航/交互；P1 使用专用可丢弃 PostgreSQL、受控身份和 Runtime；P2 单独验证真实 DSH、目录与工具收权和目标环境容量。

实施顺序：

1. 冻结上述行为与目录中的业务验收，保留不补跑、不自动重试的明确产品反馈。
2. 迁移任务表与最小触发记录，补齐原子受理端口、输入关联和启动失败收敛。
3. 在既有 Run/授权/工具链补上 automation 当前权限、上限、purpose 消费者、暂停及取消约束。
4. 接入单进程日历、遗漏留痕、简单限额和不阻塞交互的现有 Scheduler 选择逻辑。
5. 工作台 API/UI；页面成型后浏览器预演，再固化 Playwright，按 Spec → Code → Verify → Test → Green 执行。
6. 分层验证事务故障、权限、DST、容量和结果；发布前 P2 验收。文档更新不代表功能实现、提交、部署或真实验收。

本次文档验证：`pnpm verify project`、`pnpm check:architecture`、差异检查；运行与 Schema 代码尚未修改，不据此声称功能测试通过。
