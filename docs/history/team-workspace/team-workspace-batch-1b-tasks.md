# 批次 1B 任务拆分与实施约束

**状态：** 进入 1B 实施的任务边界（2026-09-11；同日二次收敛：2A／2B 放弃、T2 取消）。产品语义以 `team-workspace-plan.md` 为准，界面以 `team-workspace-design.md` 为准，本文件只拆任务、定验收与顺序。
**依赖：** 批次 1A 已交付（授权来源多对多、撤权事件、执行前复核、系统取消、SSE 与 REST 读取拦截）。

**范围决定（2026-09-11 产品确认，与方案 §7、§9.1 及 §6.3 一致）：**

- 批次 **2A（共享与派生基础）与 2B（团队成果沉淀）已放弃**，不交付分享快照、同团队派生、来源撤回传播与团队成果发布。
- 空间会话列表的 `scope` 查询参数**整体移除**：历史列表固定为调用者本人范围，由服务端 `s.created_by = actorUserId` 强制；不再有 `scope=mine`／`scope=team`，旧的空间级空态 `session-history-empty-workspace` 也不再存在。
- **1B-T2（来源限制采集）随之取消**：它只为 2A／2B 的派生与撤回提供前置，不是「延期」，也不属于 1B 交付物、前置条件或退出条件。
- 后果如实说明：若将来确需追溯内容来源与访问限制，**必须重新立项**并另行设计采集与保存链路；**无法补记已发生运行（历史 Run）的来源事实**，既有运行不会被回溯标注。

**1B 交付范围与退出条件（收敛后，替代原含来源限制的表述）：**

- 交付范围：TW-03 本人历史列表、TW-05 共享文件、团队 Session 分页、文件／SSE 收权、可见统计性能基线。
- 退出条件：A 上传不可变文件、B 引用完成真实 DSH 对话**并能继续**；AC-09 收权（含文件下载／详情／搜索结果读取、已建立 SSE、续传与新运行）通过，个人空间回归不变；T5 产出一份可复核的 members／sessions／files 性能基线记录。
- **不含**来源限制采集（T2，已取消）与分享／派生／撤回／发布（2A／2B，已放弃）。

## 1. 现状核查（2026-09-11，代码级事实）

| 能力 | 现状 |
| --- | --- |
| 团队 Session 分页 | **不存在**。`listTasks(userId)` 只返回本人最近 50 个 Run，无 workspace 维度、无游标、无 Session 去重 |
| Session 索引 | 已有 `sessions_by_workspace (tenant_id, workspace_id, last_active_at desc)`，可支撑团队分页 |
| 来源限制 | **完全未实现**：全仓无字段、无采集、无投影（原 T2 目标，已随 2A／2B 取消，不再是 1B 交付项） |
| 文件列表/下载/移除/搜索 | **不存在**。仅有上传与「引用到对话」（`prepareRuntimeFiles` 走不可变 `file_objects`） |
| 前端对话页签 | 无「新对话／历史对话」切换，无历史视图 |
| 文件/结果收权 | 1A 已覆盖 SSE 与 Run 详情/列表/取消读取，**未覆盖文件下载与结果读取** |

## 2. 任务单元

**实施记录（2026-09-11）：** T1 与 T3 已交付并接入 CI（`test:m5:sessions:integration`、`test:m5:shared-files:integration`）。**范围口径（已随 2A／2B 放弃更新）**：空间会话列表**不存在 `scope` 参数**，历史列表始终是调用者本人的会话，由服务端 `s.created_by = actorUserId` 强制过滤；团队 Session 分页即在该本人范围内按空间分页。T3 的移除是逻辑移除（对象/解析结果/历史 Run 引用保留）。

### 1B-T1 团队 Session 分页 ✅ 已完成（后端 `43cfc28`/`d894322`、前端 `49976e7`/`8389fec`）（方案 §6.2「会话列表」、§6.3「Session 查询」、§6.6）
- 服务端接口：按空间分页返回 **Session 摘要**（不含正文）：稳定 Session 身份、标题、发起人、最近活动时间、最新 Run 指针与状态、Run 计数；游标分页、标题关键词过滤、固定「最近活动倒序」。
- 权限：仅当前团队成员可读；按授权结果**先过滤再分页与计数**（不先取全量再在应用层裁掉）。
- 前端：对话页签顶部「新对话／历史对话」segmented，写入 `?view=history`；历史视图含搜索框、列表行（状态点/标题/发起人/最近活动/最新状态）、「加载更多」与「已加载全部」、两种空态（本人无会话 `own`、标题搜索无匹配 `filter`，设计 §2.2）。**原「我的对话／团队共享」范围切换、空间级空态与发起人筛选属 2A，已随 2A／2B 放弃，不渲染空入口。**
- 索引：按实际查询计划补 `(tenant_id, workspace_id, last_active_at desc, id)` 类索引（若既有索引不足）。
- 验收：AC-05、AC-06；>50 Run 的会话仍能在团队分页中找到其他会话。

### 1B-T2 来源限制采集 ❌ 已取消（随 2A／2B 一并放弃，不再交付）（方案 §6.3 末段）
> **取消说明（2026-09-11 产品确认）：** 本任务只为 2A 的派生传播与 2B 的成果发布／撤回提供前置，2A／2B 已放弃，故 T2 **整体取消**——它不属于 1B 交付物、前置条件或退出条件，也不是延期到后续批次。以下描述仅作决定留档、保留原口径以便审计，不再排期、不再实现、不再验收 AC-07 的来源限制部分。
- 为团队输入文件、知识上下文、工具返回数据记录**可追溯来源标识**与**访问限制**，并随结果保存；**缺失限制记为「不可判定」**，不得默认放行或默认拒绝。
- 数据模型：在 1A 的 `workspace_grant_sources` 之外新增「来源限制」维度（迁移 `0024`），保持不可变快照语义。
- 约束：曾作为 2A 派生与撤回的**前置**；原计划本批只做采集与随结果保存，不做派生传播。该前置关系随 2A／2B 取消而失效。
- 验收（不再执行）：AC-07 的「输入与结果可追溯来源限制」；不可判定项有明确标记与可观测证据。
- 长期后果：若将来确需追溯内容来源与访问限制，须重新立项并重新设计采集链路；**先前已执行的历史 Run 无法回溯标注**。

### 1B-T3 共享文件：下载、搜索、逻辑移除 ✅ 已完成（`61d0a07`/`dfeb1f1`/`963bf61`）（方案 §6.2「文件列表、详情与管理」、设计 §2.3）
- 服务端：按空间列出文件（名称搜索、分页、状态、上传人、时间）、下载（沿用不可变对象）、负责人/管理员或上传人本人的**逻辑移除**；旧 ID 下载不能绕过移除与权限。
- 权限：只读成员不渲染上传与移除（保留引用与下载）；成员仅对自己上传的文件可移除。
- 迁移：逻辑移除字段（不复用、不覆盖 `file_objects` 与解析结果）。
- 验收：AC-13 的「移除阻止新引用、历史 Run 仍可追溯实际版本」；下载鉴权与个人空间行为不变。

### 1B-T4 文件与结果读取收权 ✅ 已完成（方案 §6.5 第 3 条尾句、AC-09）
- 把 1A 的团队读取校验扩展到文件下载、文件详情与成果读取。**实测缺口**不是「文件侧已随 T3 落地」：
  `readFile` 的「会话作者」SQL 分支不校验团队身份，`artifactFileId` 与 `listArtifacts` 只按
  `sessions.created_by` 授权，被移出/退出的成员可继续下载本人团队会话文件与成果。
- 修复：抽出共享门禁 `canReadWorkspaceObject`（`authorization-errors.ts`），文件与成果读取、
  运行/结果读取共用同一口径；个人空间与非团队对象走原路径（AC-23）。
- 同时收口的六项（两轮评审发现）：
  - **归档空间 fail-closed 且不依赖缓存 TTL**：`workspaceTypeOf` 对归档/不存在空间返回 null，
    旧口径「非团队即放行」会让被移出成员在授权缓存命中期间继续读到 Run 正文（评审实测 200 + 正文）；
    现统一为 null ⇒ 拒绝，并补归档回归用例。
  - **私有会话附件归属**：`readFile` 的工作区分支原先不限定 `session_id is null`，任一现任成员凭
    fileId 可下载他人私有会话附件（与 §5/AC-10 冲突）。现空间共享文件与私有会话附件分离，
    私有附件仅作者可读，空间共享文件对现任成员保持可下载。
  - **拒绝改为类型化**：新增拒绝抛 `authorizationDenied(...)`，不再依赖路由的中文文案分类
    （本批「违反即回退」约束）；仅类型化拒绝被吞掉，基础设施故障照常冒泡，不再被伪装成 403。
  - **Run 输入挂载同一限制**（复审 P1）：`prepareRuntimeFiles` 的工作区分支原先同样缺少
    `session_id is null`，成员可把他人私有会话附件挂进自己的 Run 交给 DSH 读取，绕过
    `readFile` 的限制；现与文件下载同一口径，空间共享文件仍可挂载。
  - **SSE 与执行前复核同一口径**：`GET /runs/:runId/events` 原先只在 `workspaceType === 'team'`
    时加门禁，归档空间返回 null 即跳过并交付正文；`recheckExecutionAuthorization` 同样把 null
    当作「非团队」跳过。两者现均 fail-closed（归档后不建流、不进入 Runtime）。
    **已建立的流**还曾多受一层逐批门禁缓存 TTL（默认 10s）影响——归档不提升 `team_auth_revision`，
    缓存命中即放行；`hasStreamAccess` 现改用 `canReadWorkspaceObject`，每批重新解析空间类型，
    归档立即终止在流（已有回归用例并做过反证）。
- **遗留（转 TW-06 批次 3 定夺，非本批缺陷）**：归档团队空间目前对文件、成果、运行读取一律拒绝，
  连现任 owner 也不能只读下载；而 `WorkspaceInfoPanel` 文案承诺归档后「保留有权限的只读查看与下载」，
  AC-14 也要求「历史按权限可读」。归档入口尚未实现（无 API 写入 `status='archived'`），
  因此该分歧不影响当前线上行为；实现 TW-06 时必须先确定归档语义，再统一文件与运行两侧。
- 验收：AC-09「失去读取资格时文件下载、搜索…均被拒绝」；AC-10 私有会话不因空间成员身份开放。
  覆盖到的读取面：文件下载、成果下载（含指定版本）、成果列表、运行详情/列表/取消/重试、
  SSE 建连与逐批写出（含已建立流）、Run 输入挂载、执行前复核。
- **明确未覆盖（记录在案，不阻断本批）**：`recheckExecutionAuthorization` 的 null／standalone
  分支无针对性集成用例（评审以 stub 分支探针 + 真实库端到端验证）；`prepareRuntimeFiles` 的
  「本会话附件」分支未额外校验空间活跃/成员（端到端由 `authorizeRuntime` 与执行前复核兜住）；
  Run 输入挂载的失败仍是普通 Error（经文案映射 403），未类型化；`scripts/runtime/team-workspace-e2e.ts`
  的真实 DSH 链路未在评审中重跑。

### 1B-T5 可见统计性能基线 ✅ 已完成（方案 §6.6）
- 建立含**成员、会话、共享文件**三类可见统计的数据基线：多成员、多会话、单会话 >50 Run、共享文件量，记录查询计划、延迟分位数、数据量与并发。
- **口径收窄**：只覆盖 members／sessions／files；不再包含来源限制、发布／撤回或多层派生相关的统计与投影（随 T2 取消、2A／2B 放弃）。
- **必测项（T4 评审已量化，待本任务复核）**：`listArtifacts` 的可见范围过滤在 T4 已改为
  「先在列表查询里取 `w.workspace_type`，再按空间去重后复核一次」，以消掉逐行门禁的 N+1 与并发
  冷启动的授权缓存击穿。评审在 200 条成果上实测：改前个人空间 201 次、团队冷启动 1001 次往返。
  本任务需复测该路径（个人／团队、冷／热）并确认查询次数与延迟在预算内，同时判断
  `listArtifacts` 是否需要服务端分页（当前无 LIMIT）。
- 产出一份可复核的基线记录；不预设物化方案。
- **交付物**：`docs/history/team-workspace-1b-statistics.md`（机器生成、可复跑）+
  `docs/history/team-workspace-1b-statistics-findings.md`（结论与待办）；工具
  `scripts/bench/team-workspace-statistics.ts`，入口 `pnpm bench:team-workspace-statistics`。
- **实测结论**（计数单位是 **SQL 语句数**，非网络往返；测量层次为服务层，不含路由授权与序列化）：
  - 会话列表、文件列表、成果列表均已达标：`listWorkspaceSessions` 一律 **1** 条语句
    （首页／深翻页／标题搜索同量级），`listWorkspaceFiles` **3** 条（与行数无关）。
  - **成果列表的 N+1 修复成立**：同一批 200 条成果上对照两种实现形态 —— 当前「按空间去重
    复核」**6 冷 / 3 热**，候选「逐行门禁」**404**（p50 约 202ms），约 1/67；对照实现已写入
    工具，任何人可复跑，不引用未提交实现的历史数字。
  - **待优化（已出证，未实施）**：`listWorkspaces` 每个可见空间 2 条语句（成员名册 + 文件），
    实测拟合 `语句数 = 2 × 可见空间数 + 4`（N=3/5/8/12 → 12/16/22/30，可见空间 = N+1）；
    6 个可见空间时热路径 p50 ≈ 27ms。候选修法（主查询内单次聚合）留实施评审决策。
  - 主聚合把「空间 × 成员 × 会话 × 成果」展开后 `count(distinct)`：基线规模下中间结果
    8656 行、`shared hit 17919`；**计数断言无法保护这条退化**（distinct 会把重复计数掩盖
    成正确值），只能靠计划与缓冲次数观测。放大来自连接乘积，**不是**缺连接条件。
  - 10 路并发混合读取 59 条语句、p50 约 60ms，无错误无超时。
  - **已知未覆盖**：单空间内会话数／文件数从百级到千级的扫描未实测；工具未被 `pnpm typecheck`
    覆盖（仓库 tsconfig 只含 `src/**`，与 `scripts/runtime/*.ts` 同约定）。

## 2.1 真实 DSH 端到端验证结果（2026-09-11，已完成一次）

> **保留说明：** 以下实测当年为 T2 的设计依据而执行；T2 已随 2A／2B 取消（见文首范围决定与 1B-T2）。这些数据**仅作参考事实保留，不是 1B 的交付要求或验收条件**；「对 T2 的含义」一列是当时的判断，不再驱动待办。

`scripts/runtime/team-workspace-e2e.ts`（一次性库 + 真实 `DshAcpRuntimeAdapter`）实测 `ok: true`：

- A 上传 `e2e-inventory.md` → 共享文件列表可见、`scanStatus=clean`、不可变对象 + 解析结果落库；
- 团队 Agent 成员关联走**真实服务**（同时建立 Agent/Skill/Tool 授权来源）；
- **B（成员）**发起团队会话并引用该文件运行 → `succeeded`，助手回复**回显了文件内的标记**（证明文件内容真实进入 DSH 执行）；
- 运行完成后**继续对话** → 第二个 Run `succeeded` 且仍能回显标记（满足 1B 退出条件「并能继续」）。

**真实 DSH 事件与来源落点（原 T2 设计依据，仅作参考）：**

| 观察 | 值 | 对 T2 的含义（历史判断，不再驱动待办） |
| --- | --- | --- |
| 事件类型 | `run.queued/started`、`approval.required/resolved`、`assistant.delta/completed`、`run.completed` | **没有 tool 事件**；无 `tool.*` 事件类型 |
| 工具调用痕迹 | `approval.required` 的 `safe_metadata` 带 `tool_name='read'`、`tool_call_id`、`option_kinds` | 工具来源信息来自**审批事件**，不是 tool 事件 |
| 工具审计 | `tool_audit_logs` 落 1 行：`tool_version_id='tool-version-read-1'`、`parameter_summary={decision,tool_name,tool_call_id}`、`result='success'` | 工具来源可从 `tool_audit_logs` 关联到 Tool Version |
| 工具返回值 | 审计只记参数与决策，**不记结果内容** | 若 T2 要追溯「工具返回了哪些数据」，现有链路缺少该落点 |
| 文件来源 | 来自 `run_input_files` + attempt manifest 的 `input.file_mounts` | 文件来源可由此关联到不可变 `file_objects` |
| 知识来源 | manifest 的 `knowledge_context`（含 `documentId/version/dataScope/contentChecksum`） | 知识来源已随不可变 Manifest 固化，可直接扩展限制字段 |

**运行环境提示（本轮踩到）：** `pnpm probe:*` 原先不加载 `.env`，会按生产档（`0.1.2-rc.1`）比对本地开发档（`0.1.1-rc.2`）并 fail-closed 报 version mismatch；已修（`c196c82`）。本地/生产**双档并存**是刻意设计（`runtime-lock.json` 的 `compatibility` + `DSH_RUNTIME_COMPATIBILITY`），不是版本落后。

## 3. 顺序与依赖

```
T1（Session 分页） ─┬─> T4（文件/结果收权，依赖 T1/T3 的读取面）
T3（文件能力）    ─┘

T1（Session 分页） ──> T5（性能基线，需要 T1 的查询与数据量）
```

- T1 与 T3 可并行；T4 必须在 T1/T3 之后。
- T2（来源限制采集）已随 2A／2B 取消，不参与依赖与排期。
- 每个任务：实现（TDD 先红后绿）→ 规格符合性评审 → 质量评审 → 修复 → 复审，流程同 1A。

## 3.1 本地环境限制（2026-09-11 实测，非缺陷）

`pnpm test:e2e` 在本机无法通过：Playwright 访问 `http://127.0.0.1:4174/workbench`，而
`AI_HUB_WORKBENCH_PORTAL_URL=http://localhost:4174` 使 OIDC 允许来源只含 `localhost`，
`/auth/workbench/login` 因此返回 **421 unknown_request_origin**（在干净 HEAD 检出上同样复现，
与本批改动无关）。CI 使用被允许的来源，因此质量门通过。要在本机跑 e2e，需让访问来源落在
允许列表内（改 `DSH_WORK_WORKBENCH_ORIGINS` 或改用 `localhost` 访问），不要为此改产品代码。

## 4. 贯穿约束（违反即回退）

- **个人空间零改动（AC-23）**：团队分页、文件能力与收权只在团队分支生效；个人空间接口与页面保持现状。
- **新增集成套件必须用 `createThrowawayDatabase()`**（`server/src/infrastructure/postgres/test-database.ts`），不得直连共享库。
- **新增授权拒绝统一抛 `authorizationDenied(...)`**，不要依赖文案分类。
- **API 变更必须同步 OpenAPI 契约**并跑 `pnpm verify`；不得绕过 DSH 另建 Agent 执行逻辑（AGENTS.md）。
- 团队读取边界继续用不依赖当前成员身份的 `workspaceTypeOf` 判定空间类型。
