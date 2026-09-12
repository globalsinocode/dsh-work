# 批次 3 任务拆分与实施约束

**状态：** 进入批次 3 实施的任务边界（2026-09-11）。产品语义以 `team-workspace-plan.md` 为准，界面以 `team-workspace-design.md` 为准，本文件只拆任务、定验收与顺序。
**批次 3 的范围是 TW-06／TW-07／TW-08 三件事**（方案 §7）：TW-06（3-T1…3-T5）、TW-07（后端 3-T6 + 前端版本 UI 3-T9）、TW-08（后端 3-T7 + 前端 3-T8）**全部交付**，每个任务均经规格符合性与对抗性质量两轮评审并逐条反证。批次 3 的**既定退出条件已满足**，TW-07 至此端到端可用。
**依赖：** 批次 1A（授权与撤权机制）、1B（团队资料与本人对话、文件与结果读取收权、可见统计基线）已交付。

## 范围决定（2026-09-11 产品确认）

**归档语义＝只读保留。** 团队空间归档后：

- **可读**：现任成员（含负责人）仍可按各自权限查看会话、文件、成果与历史运行，并下载有权限的内容；失去成员资格的成员仍然拒绝。
- **不可执行**：归档阻止新对话、续写、重试、上传、成员与 Agent 变更、空间设置修改；有排队或活动运行时不允许归档。
- 归档空间仍允许必要的**访问撤销与负责人治理**（不能以只读状态阻止紧急收权）；恢复不自动恢复已移除成员、不扩大授权。

这条语义与 `team-workspace-design.md` 的归档提示文案、方案 AC-14「历史按权限可读」一致。**注意**：1A 建立的实现口径是「团队空间必须 `status='active'`」这一条判断同时覆盖读与执行，因此 1B-T4 当时把归档统一成「一律拒绝」。批次 3 的第一个任务就是把这一个判断拆成**执行轨**与**读取轨**两条，并修正因此产生的测试与文档。

## 1. 现状核查（2026-09-11，代码级事实）

| 能力 | 现状 |
| --- | --- |
| 归档字段 | `workspaces.status`、`workspaces.archived_at` 已存在（`0001`），**无任何 API 写 `status='archived'`** |
| 读/执行口径 | 同一个 `w.status = 'active'` 判断同时约束读与执行，散落在 `workspaceTypeOf`、`resolveWorkspaceType`、`requireTeamRole`、`requireWorkspaceMembership`、`resolveAccessibleWorkspace` 五处 |
| `canReadWorkspaceObject` | 团队读门禁：`workspaceTypeOf` 为 null（含归档）即拒绝——**与本次只读保留决定相反，必须改** |
| 团队列表 | `listWorkspaces` 只返回 `status='active'`；`GET /workspaces` 的 `owner` 仍是**创建者**显示名且缺 `status`（1A 遗留，本批必修，否则归档态与负责人展示都不准） |
| 空间设置 | 前端仅有「归档空间」入口占位（设计 §2.7），未见 `PATCH /workspaces/:id`，说明/名称无法保存（1A 遗留） |
| 相关测试 | `team-workspace-authorization.integration.test.ts` 有一条断言「归档空间连 owner 也被 `requireTeamRole` 拒绝」——**该断言建立在旧语义上，需按只读保留改写** |
| TW-07/TW-08 | 文件版本、动态通知均未实现；`file_objects` 只有逻辑移除，无逻辑文件/版本关系 |

## 2. 任务单元

### 3-T1 归档语义：读/执行双轨授权 ✅ 已完成（2026-09-11）
- **目标**：把「`status='active'`」这一个判断拆成两条明确口径，作为 TW-06 其余任务与 TW-07/TW-08 可读性判断的基础。
- **执行轨（保持现状语义）**：新对话、续写、重试、上传、成员/Agent 变更、设置修改、转交要求**活跃团队 + 当前成员 + 平台授权**（取交集）；归档一律拒绝。
- **读取轨（本任务新增）**：会话、文件、成果、历史运行的读取与下载允许**归档 + 当前成员**；非成员与不存在空间仍然拒绝，且不可枚举（保持与「不存在」同文案）。
- **实现要点**：
  - 读路径不得再用 `workspaceTypeOf`（它只认 active）。新增状态无关的空间类型解析（如 `readableWorkspaceTypeOf`），或在读门禁里显式区分「归档」与「不存在」。
  - `canReadWorkspaceObject`（`authorization-errors.ts`）改为「团队 + 当前成员 ⇒ 允许（含归档）」；个人空间照旧。
  - `requireTeamRole` 增加「读用途允许归档」的显式选项；**默认仍要求活跃**，避免写路径被无意放宽。
  - `resolveAccessibleWorkspace`、`resolveWorkspaceType` 按调用方用途分别处理，逐个核对调用点，写路径必须保持拒绝。
  - SSE 建连与逐批写出走读取轨；执行前复核与排队领取走执行轨。
- **验收**：AC-14（归档语义部分）、AC-09（失权仍然拒绝）、AC-23（个人空间不变）。
- **风险**：读路径放宽后若写路径漏改一处，会出现「归档空间仍能执行」。必须逐个调用点列出用途并加回归测试。

### 3-T2 归档与恢复 API + 运行中并发保护 ✅ 已完成（2026-09-11）
- **接口**：新增空间状态变更（归档／恢复）；`GET /workspaces` 补 `status` 与 `archivedAt`，`owner` 改为**当前负责人**（`workspace_members.member_role='owner'`），不再用创建者。
- **规则**：仅负责人可归档／恢复；有排队或活动运行时拒绝归档并提示先等待或取消（不自动中断在途任务）；恢复清空当前归档时间、不恢复已移除成员、不扩大授权；归档／恢复写审计事件。
- **并发**：归档与「新对话／领取排队任务」必须串行化（空间行锁已在成员变更路径使用，沿用同一锁序），避免归档与开跑互相穿透。
- **列表**：`GET /workspaces` 支持活动／归档筛选（`status=active|archived|all`），**默认 `all`**（对齐设计 §2.1 与 §6 已确认决策「默认全部；个人空间恒显」——若默认 active，归档空间在 UI 里不可发现）。归档筛选只返回调用者仍有权访问的空间。
- **验收**：AC-14、AC-02 不受影响（转交不变）、AC-27（迁移不回归）。

**交付记录（2026-09-11）**：
- **接口**：`POST /workspaces/:workspaceId/archive`、`POST /workspaces/:workspaceId/restore`（`workspace-lifecycle-routes.ts`）；`GET /workspaces?status=active|archived|all`（**默认 `all`**，对齐设计 §2.1/§6「默认全部；个人空间恒显」；`archived` 供 3-T3 归档筛选）。服务层默认同步为 `all`，`createWorkspace` 显式按 `active` 查回新空间。
- **实现位置**：`postgres-workspace-lifecycle-service.ts`（负责人校验、状态变更、审计、运行中拦截）、`workspace-state-conflict-error.ts`（类型化 409，避免按文案分类）、`router.ts`（类型化 409 映射）、`postgres-content-service.ts`（列表 `status`/`archivedAt`/当前负责人/筛选）、`postgres-run-repository.ts`（开跑／重试／领取的空间行锁兜底）。
- **锁序（唯一空间锁）**：`workspaces` 行锁 → `sessions` / `run_attempts` / `runs` / `runtimes`。归档事务首语句 `select ... from workspaces for update`；`createRun` / `createAttempt` / `claimAttempt` 的首语句同样先锁 `workspaces` 行（与成员变更、授权来源清扫同一把锁），因此归档与开跑/领取串行：归档先提交则开跑/领取被拒（typed 403 / `claimAttempt=false`），开跑先提交则归档因存在活动 Run 被拒（409）。无第二把空间锁。
- **锁序修正（质量评审 F2，既有死锁）**：原先 `owner-transfer` 先锁 `workspaces`，而 `addMember`/`changeMemberRole`/`removeMember`/`exitWorkspace` 先改 `workspace_members`、最后才 `update workspaces`（`bumpTeamAuthRevision`），形成**反向锁对**；并发转交 + 移除成员实测 40 次里 39 次 `40P01 deadlock detected`，并被 HTTP 分类成 **500**。现四个成员变更入口统一经 `runMembershipMutation` **先取空间行锁**，锁序全局一致。新增回归用例（8 轮并发转交 + 移除，断言无 deadlock 且至少一方成功）并反证：去掉该锁即变红。
- **排队期间归档的收敛（质量评审 F3）**：归档空间里遗留的 queued attempt（历史/迁移/外部写入，API 路径不可达）原先会让调度器每 500ms 无限重排（实测 2.6s 内 6 次、永不收敛）。现 `claimAttempt` 失败且 attempt 仍 queued 时，用 `RunRepository.workspaceStatusForAttempt`（attempt→run→session→workspace 关联）判断归档，收敛为终态并落 `run.failed` 说明事件。已加判别性用例并反证。
- **`{}` manifest 加固（验证代理 D1；初版此处声明有误）**：初版交付记录写「不读 manifest——夹具/历史的 `manifest` 列可能是 `{}`」，该表述**只对了一半**：判断归档确实不读 manifest，但调度器**取 attempt id 仍读 `manifest.attempt_id`**；遇到 `{}` 会把 `undefined` 绑进 SQL → `UNDEFINED_VALUE`，并经 `void this.pumpScheduler()` 变成未处理 rejection（进程级致命，run/attempt 永远 queued）。现回退到 run 的权威指针 `currentAttemptId`，两者都没有则跳过并告警，绝不把 `undefined` 传给仓储。
- **成员变更的锁内状态复核（验证代理 D4，既有 TOCTOU）**：成员新增/改角色/退出的空间状态原先只在**事务外**检查；归档若在其等待行锁期间提交，变更仍会成功（强制时序实测 8/8 穿透）。现状态复核随行锁移入事务内；`removeMember`（紧急撤权）与 `transferWorkspaceOwner` 作为治理例外显式传 `allowArchived`，归档空间仍可执行。已加判别性用例并反证。
- **归档拒绝文案与状态**：`该空间还有 N 个排队或运行中的任务，不能归档；请等待任务完成或先取消任务` → 类型化 `WorkspaceStateConflictError`（409 `state_conflict`）。个人空间归档/恢复 → 422（AC-23 团队专用接口惯例）。非负责人/非成员 → `authorizationDenied(...)` → 403。
- **恢复语义**：仅清 `archived_at` 并置 `status='active'`，不触碰 `workspace_members`；已移除成员保持移除，授权不扩大。归档空间仍可执行紧急撤权（`DELETE /members/:userId`）与负责人转交（3-T1 治理例外，未改动）。
- **测试**：新增 `server/src/http/team-workspace-lifecycle-api.integration.test.ts`（**18 个用例**，`createThrowawayDatabase()`），登记为 `test:m5:lifecycle:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml`）。
- **反证声明的更正（规格评审 P1 / 质量评审 F1）**：初版曾声称「去掉 `createRun`/`createAttempt`/`claimAttempt` 的空间行锁…对应用例均变红」——**该声明不成立**：两轮评审各自实测「削掉三处 `for update of w`、保留归档状态判断」后套件仍 14/14 全绿，说明原有用例只证明「状态判断存在」，不证明「行锁存在」，即一个带 TOCTOU 的错误实现能通过 CI。现补两条**能区分有锁/无锁**的用例：① 外部事务持有空间行锁时开跑不得推进（无锁则会立即完成）；② 转交 + 移除成员并发无死锁。两条均反证过（削弱实现即变红）。运行中拦截、当前负责人解析的反证仍然有效。
- **契约**：`docs/development/openapi-workbench.json` 补 `status` 筛选参数与两个新端点（含 409 说明）。
- **未做/超出本任务**：`PATCH /workspaces/:id`（名称/说明保存）仍缺，属 3-T3 依赖的 1A 遗留；前端归档体验为 3-T3；无新增迁移（复用 `0001` 的 `status`/`archived_at` 与 `audit_events`）。

### 3-T3 前端归档体验 ✅ 已完成（2026-09-11）
- 空间列表：`全部／活动／已归档` 紧凑筛选（口径见 3-T2），归档卡片显示「已归档」状态标记；计数文案随筛选变化。
- 归档空间详情：页头下只读提示条 + 负责人可见「恢复空间」；隐藏新增对话、续写、上传、重试入口。判定依据是服务端返回的 `status`（归档）与 `currentUserRole`（负责人），前端不按创建者/姓名推断；注意 workspace 级**没有** `allowedActions` 字段（该字段只存在于 Agent 成员对象），不要按它渲染空间级动作。
- 空间设置弹窗：补名称/说明保存（依赖 `PATCH /workspaces/:id`）、归档二次确认与运行中冲突提示、退出空间提示（贡献保留）。
- 只读成员与归档态的组合：只读成员在归档空间仍可查看与下载，不显示任何写入口。
- **验收**：AC-14（前端部分）、AC-16（状态可验证）、AC-23（个人空间不显示上述入口）。

**交付记录（2026-09-11）**：
- **列表筛选（design §2.1/§6）**：`WorkspacesView.vue` 增加 `全部/活动/已归档` 分段筛选，状态写入路由 `?status=active|archived`（默认「全部」不带参数，沿用 `?view=history` 深链写法）。非「全部」结果单独持有，不覆盖全局 `contentStore.workspaces`——避免筛选把个人空间从其它页面（默认空间、详情回退）移除，守住 AC-23。归档卡片追加 `StatusTag status="warning"`「已归档」且仍可点击进入只读详情；归档空态为「暂无已归档的团队空间」。
- **归档只读详情（design §2.7/§3）**：`WorkspaceDetailView.vue` 页头下新增只读提示条「该空间已归档，仅保留有权限的只读查看与下载」，`恢复空间` 仅当服务端 `GET /workspaces/:id/members` 的 `currentUserRole === 'owner'` 时渲染。归档时隐藏新对话（`ConversationStarter`）、对话视图切换、上传按钮与「引用到对话」，对话页签固定展示历史；会话、文件、成果与历史仍可读/可下载。`WorkspaceSessionHistory.vue` 增加 `archived` 空态，避免归档时误显示「联系负责人添加可用 Agent 成员」。
- **会话页续写/重试（design §2.7）**：`ConversationView.vue` 按运行所属团队空间的 `status`（服务端返回）隐藏续写输入（TaskComposer）与两处「重新执行本轮」，改为只读提示；个人空间分支不命中（AC-23）。
- **空间设置（design §2.7）**：`WorkspaceSettingsDialog.vue` 的名称/说明保存改调 `PATCH /workspaces/:id`，清空说明显式传 `description: null`；移除「保存接口未就绪」占位文案。新增「归档空间」区（负责人、二次确认）与归档态「恢复空间」区；归档被在途任务拒绝时（409 `state_conflict`）在弹窗内行内展示服务端给出的任务数量与「请等待任务完成或先取消任务」。
- **API 与类型**：`src/api/client.ts` 新增 `updateWorkspace`、`archiveWorkspace`、`restoreWorkspace`，`getWorkspaces(status)` 支持 `?status=` 筛选；`src/types/domain.ts` 收紧 `Workspace.status` 为必填并补 `archivedAt`，新增 `WorkspaceStatus`/`WorkspaceStatusFilter`/`WorkspaceLifecycleResult`/`WorkspaceUpdateInput`。
- **测试**：新增 `WorkspacesView.test.ts`（7）、`ConversationView.test.ts`（3），扩展 `WorkspaceDetailView.test.ts`（18）、`WorkspaceSettingsDialog.test.ts`（13）、`api/client.test.ts`（21）。关键判别性用例经反证：归档标记、隐藏新对话、`恢复空间` 仅负责人、`description: null`、409 行内提示、会话页归档只读——削弱实现即变红。
- **未做/超出本任务**：本机无浏览器 e2e（OIDC 允许来源限制，见 1B 任务 §3.1），未运行 `pnpm test:e2e`；无新增迁移。
- **服务端改动（本工作区一并交付）**：3-T3 依赖的 `PATCH /workspaces/:id`（团队空间名称/说明保存，1A 遗留）由本工作区补齐 —— 路由、`updateWorkspace` 服务方法（空间行锁内复核「活跃 + 负责人」）、OpenAPI 路径与集成用例；无迁移。


**评审修复（2026-09-11）**：
- **筛选 tablist 无键盘支持**（符合性评审 F1，硬伤）：roving tabindex 只让当前项可 Tab，未实现方向键，键盘用户永远切不到「活动/已归档」——违反 §4 与 AC-16。已实现 ArrowLeft/ArrowRight/Home/End + 聚焦选中项，并补键盘用例。
- **PATCH 空请求体返回 500**（F2）：契约只声明 200/403/422，空 body 与超长名称原先靠文案分类落到 500。新增类型化 422（`requestInvalid`，放在 `authorization-errors.ts`，避免应用服务反向依赖 http 层的 `routeValidationFailed`），并补断言。
- **前端纵深防御**（F3）：`archived` 筛选结果若意外含个人空间，原先会渲染出来。现仅对「已归档」过滤非团队项（注意「活动」视图里个人空间合法，不能一并过滤——初版就是这样写的，被既有用例当场抓住）。
- **筛选重复请求**（F4）：点击改路由又直接加载，真实路由下每次切换发两次同参请求。已加同参去重，同时保留点击与深链两条加载路径。
- **文档机制描述失实**（F5）：原写「写入口隐藏由服务端 `allowedActions` 给出」，但 workspace 级没有该字段（只有 Agent 成员有）；实际依据 `status` + `currentUserRole`。已更正。
- 另补：PATCH 与归档抢空间行锁的判别性用例（原仅注释声称靠行锁防 TOCTOU）。

**质量评审修复（2026-09-11，写入口审计）**：评审按「归档空间里还有哪些写入口可点」逐项审计，抓出详情页之外的四处遗漏，均已修复并各配判别性用例（削弱实现即变红）：
- **P1 成员/Agent 管理弹窗仍可点击**：`WorkspaceMemberDialog` 原无 `archived` 概念，归档空间里「添加员工/改角色/添加 Agent/停用/升级/移出/开始对话」全部可点（服务端 403，纯死路）。现按归档隐藏全部写入口，**保留移除成员**（紧急收权，服务端 allowArchived 的治理例外）。注意「移除」原先被写在角色编辑的同一 `template` 里，第一版门禁把它一起藏了——已按治理例外拆出。
- **P2 全局新对话空间选择器列出归档团队空间**：`ConversationStarter` 现只把「个人空间 + 活动团队空间」交给 composer。
- **P2 侧栏「删除对话」未按归档禁用**：会话删除属执行轨。判定抽成 `utils/archived-workspaces.ts` 的纯函数（只依赖服务端 `type`/`status`，空间未加载时不误禁用），并补单测（含 AC-23：活跃团队与个人空间仍可删）。
- **P2 筛选请求失败后仍显示上一个筛选的陈旧卡片**：现失败即清空结果、进入错误态并提供「重试」，且去重记账只在成功后写入（否则失败会被误记为「已加载」而无法原地重试）。
- **P3/P2 契约与文档**：PATCH 的 `200` 改用共享 `Ok`、名称补 `minLength/maxLength`、去掉未强制执行的 `additionalProperties:false`；JSON `null` 请求体现在显式 422（原为 500）；更正交付记录中「未改服务端」的自相矛盾与 `allowedActions` 的失实描述；`WorkspaceInfoPanel` 的过期注释同步。

### 3-T4 批次 3 集成验证与 CI 接入 ✅ 已完成（2026-09-11）
- 新增/扩展集成套件：归档读/执行双轨、运行中归档拒绝、并发归档与新开跑、恢复语义、列表筛选与负责人展示。
- 真实 DSH 端到端补一条：归档后历史运行可读、新运行被拒。
- 新套件按 1A/1B 约定用 `createThrowawayDatabase()`；需要时在 `server/package.json`、根 `package.json`、`.github/workflows/ci.yml` 三处登记。
- **验收**：批次 3 全部验收项在 CI 门禁内有锚点。

**交付记录（2026-09-11）**：

- **集成覆盖盘点**（要求逐项对照，均已存在且进 CI）：
  | 要求 | 覆盖位置 |
  | --- | --- |
  | 归档读/执行双轨 | `team-workspace-lifecycle-api`（归档只读面 + 执行拒绝）、`team-workspace-authorization`（双轨解析器与门禁）、`team-workspace-sessions-api`/`team-workspace-shared-files-api`（HTTP 读轨） |
  | 运行中归档拒绝 | `team-workspace-lifecycle-api`（queued/running/cancel_requested 三态 409 + 终态后放行） |
  | 并发归档与新开跑 | 同上 4 条判别性并发用例（开跑需取行锁、归档先提交不穿透、领取不进入运行、排队遗留收敛） |
  | 恢复语义 | 同上（清空时间、不恢复已移除成员、不扩大授权） |
  | 列表筛选与负责人展示 | 同上（`status`/`archivedAt`/当前负责人/三态筛选与不可见空间排除） |
  | 前端归档体验 | `WorkspacesView`/`WorkspaceDetailView`/`WorkspaceSettingsDialog`/`ConversationStarter`/`ConversationView`/`archived-workspaces` 单测 |
- **CI 接入**：`test:m5:lifecycle:integration` 已登记于 `server/package.json`、根 `package.json`、`.github/workflows/ci.yml`；批次 3 的验收锚点全部进入质量门。
- **真实 DSH 端到端（本次新增并实跑通过）**：`scripts/runtime/team-workspace-e2e.ts` 在原有「A 上传 → B 引用运行 → 继续对话」之后追加归档环节，实测 `ok: true`：
  - 读取轨：归档后现任成员的运行详情、事件流、会话列表、共享文件列表**全部可用**；
  - 执行轨：归档后新运行**被拒**、`activeRunsAfterDeny = 0`（不落库）。
  - **注意实测细节**：拒绝文案来自调度前 `authorizeRuntime` 的成员/空间校验（`工作空间不存在、已归档或当前用户不是成员`），而非 3-T2 在 `createRun` 内新增的 typed `工作空间已归档，不能创建或继续执行任务`——后者是并发穿透场景的第二道守卫。文档不要把它写成主路径。
- **说明**：该 e2e 依赖本机真实 DSH 运行时（兼容档 `legacy-0.1.1-rc.2`），属人工/环境验证，**未纳入 CI**（CI 无 DSH 运行时）；批次 3 的 CI 锚点是上面的集成与前端套件。

### 3-T5 文档与退出条件收尾 ✅ 已完成（2026-09-11）
- 更新方案 §6.4/§6.5/§10、设计 §2.1/§2.7 与 handoff，记录归档语义的最终口径与实现位置。
- 明确 TW-07／TW-08 的相对顺序（本批先交付 TW-06；两者依赖已交付的读取轨判定）。
- **验收**：`pnpm verify` 的文档与契约检查通过；1B 遗留的归档语义待定项关闭。

**交付记录（2026-09-11）**：
- 方案：§6.4 末条与 §6.5 第 8 条写明归档＝只读保留与读/执行双轨；AC-23 补记例外并标注**产品已确认接受**（团队会话分页在个人空间上的 422→403，用于消除空间存在性枚举；其余团队专用接口仍 422）；§10 批次表与交付项表更新为 TW-06 已交付、TW-07／TW-08 未拆分。
- 设计：§2.1/§2.7 补「归档后写入口必须全部隐藏」的完整清单（含成员/Agent 弹窗、全局新对话空间选择器、侧栏删除对话）与「筛选失败清空旧结果 + 重试」；§5 补 AC-14/AC-23 对应。
- 交接：handoff 头部与进度表更新，新增 §7「TW-06 交付记录」（含评审轮次、并发保护与既有死锁修复、AC-23 例外），原 §7/§8 顺延为 §8/§9。
- **1B 遗留的归档语义待定项就此关闭**（产品已签字）。
- **批次 3 状态澄清**：批次 3 的范围是 TW-06／TW-07／TW-08；TW-06（3-T1…3-T5）与 TW-07（3-T6）已交付，3-T7（TW-08 团队动态与通知）尚未拆分，**批次 3 未整体完成**。

### 3-T6 文件更新与版本（TW-07）✅ 已完成（2026-09-12）
- 逻辑文件与版本关系、新版本上传、旧版本继续可用、引用固定版本、历史 Run 追溯实际版本；P1。
- 依赖：1B 交付的共享文件与收权读取轨；不依赖 TW-06 的归档语义，但归档空间的写入属执行轨（需拒绝）。
- **验收**：AC-13、AC-29（文件相关部分）。

**数据模型（实施前先定，避免与不可变对象冲突）**：

- **`file_objects` 保持不可变**（P0 语义，AC-13 要求历史 Run 可追溯）。TW-07 不改它，只在其上加一层「逻辑文件 → 版本」关联：
  - 新增 `workspace_files`（逻辑文件）：`id`、`tenant_id`、`workspace_id`、`name`（可编辑的展示名）、`created_by`、`created_at`、`updated_at`、`latest_version_no`、`status`（`active` / `removed`）。
  - 新增 `workspace_file_versions`：`id`、`tenant_id`、`logical_file_id`、`version_no`、`file_object_id`（指向不可变对象）、`note`（更新说明）、`created_by`、`created_at`；同一逻辑文件内 `(logical_file_id, version_no)` 唯一，`file_object_id` 唯一（一个对象只属一个版本）。
  - **迁移把现有团队共享文件（`file_objects` 中 `session_id is null` 且未移除）回填为各自逻辑文件的 v1**；个人空间文件不回填（P0 不依赖）；`session_id` 非空的会话附件不进入逻辑文件（它们是会话私有附件，不是团队共享文件）。
- **引用固定版本**：Run 引用仍写 `run_input_files.file_id`（不可变对象 id），因此历史 Run 的「实际输入版本」由 `workspace_file_versions` 反查即可追溯。**不新增会话级 pin 表**：会话附件与共享文件的引用路径已由 `run_input_files` 覆盖。
- **新版本失败不破坏旧版**：新对象先以 `pending` 落库并解析，只有 `scan_status='clean'` 且解析成功才把 `latest_version_no` 前移；失败版本保留记录但不出现在「最新有效版本」。
- **并发上传**：版本号分配必须在逻辑文件行锁内完成（`select ... for update` on `workspace_files`），冲突返回明确 409，不做「后写覆盖」。
- **列表与下载**：`GET /workspaces/:id/files` 默认返回每个逻辑文件的最新有效版本（保持现有响应形状，增加 `logicalFileId`/`versionNo`/`versionCount`）；新增 `GET /workspaces/:id/files/:logicalFileId/versions` 与「上传新版本」接口。下载新版本需 `workspace_file_versions` 解析后仍走既有 `readFile` 鉴权（读取轨，归档可读）。
- **前端**：文件行显示版本与「上传新版本」入口（归档空间隐藏，属执行轨），版本列表可查看/下载历史版本。
- **不在本任务内**：TW-08 的动态与通知。

**交付记录（2026-09-12，后端）**：

- **迁移 `0025_workspace_file_versions.sql`**：新增 `workspace_files` 与 `workspace_file_versions`（字段/唯一约束同上方数据模型），复合外键到 `tenants`/`workspaces`/`users`/`file_objects`，`(tenant_id, logical_file_id, version_no)` 与 `(tenant_id, file_object_id)` 唯一，另有 `(tenant_id, workspace_id) where status='active'` 部分索引。**不改 `file_objects`**（集成用例断言其列集合在 0025 前后完全一致）。
  - 回填：`file_objects` 中 `session_id is null`、`removed_at is null` 且所属空间 `workspace_type='team'` 的行，各自回填一个逻辑文件 + v1 版本行（确定性 ID `wfile-<objectId>` / `wfv-<objectId>`，`on conflict do nothing`）。**个人空间文件（含个人空间里 `session_id is null` 的文件）与会话附件（`session_id` 非空）一律不回填**；已逻辑移除的文件也不回填。
  - 回填版本号：`latest_version_no` 只在存在成功的 `m4-basic-v1` 解析记录时为 1，否则为 0——记录仍在（可追溯），但不出现在「最新有效版本」里（AC-13）。`parse_status` 由既有解析记录推导为 `succeeded`/`failed`/`pending`。
  - 相对既定模型的少量增列（不影响语义，已在迁移内 `comment on`）：`workspace_files.removed_at`/`removed_by`（与 `file_objects` 同口径的移除审计）、`workspace_file_versions.parse_status`（区分 pending/succeeded/failed，支撑「失败版本记录保留但不前移」）。
- **服务层（`postgres-content-service.ts`）**：
  - `listWorkspaceFiles`：改为按逻辑文件聚合，返回**最高解析成功版本**（`join lateral … order by (parse_status = 'succeeded') desc, version_no desc`；没有任何成功版本时退化为最高版本），并新增 `logicalFileId`/`versionNo`/`versionCount`；同一逻辑文件只出现一行（AC-29 不重复计数），名称搜索与 keyset 游标语义不变。`removable` 口径扩展为「负责人/管理员，或逻辑文件创建人，或最新有效版本上传人」。
  - `listWorkspaceFileVersions`：按版本号倒序返回全部版本（含失败版本），带 `note`/`parseStatus`/`current`/`canDownload`；读取轨（归档可读），非成员/个人空间拒绝。
  - `uploadWorkspaceFileVersion`：新版本先落**不可变 `file_objects` 行**（`scan_status='clean'`，安全扫描在事务外同步完成）并在事务内写 `pending` 版本行；**版本号在 `workspace_files` 行 `select ... for update` 内按 `max(version_no)+1` 分配**（不是 `latest_version_no+1`，失败版本不占号但也不被复用）；唯一冲突兜底翻译为类型化 409。解析成功后才把 `latest_version_no` 前移并置 `parse_status='succeeded'`；解析失败置 `'failed'`、保留对象与记录、抛类型化 422，**绝不影响上一版本**（AC-13）。
  - `resolveWorkspaceFileVersionFileId` + 路由：指定版本下载解析到不可变对象后仍走既有 `readFile` → `canReadWorkspaceObject`（读取轨，归档可读、失权成员拒绝）。
  - `removeWorkspaceFile`：按逻辑文件移除（兼容传版本对象 ID），置 `workspace_files.status='removed'` 并把该逻辑文件**全部版本对象**标记 `removed_at`（阻止新引用）；版本行、对象、解析结果与 `run_input_files` 引用全部保留（AC-13）。个人空间上传/移除拒绝改为类型化 422。
  - `listWorkspaces` 的团队文件摘要同样按逻辑文件聚合（个人空间分支保持原查询，AC-23）。
  - 类型化错误：403 `authorizationDenied`、422 `requestInvalid`（含解析失败与个人空间拒绝）、409 `WorkspaceStateConflictError`（已移除文件再加版本、版本号竞态），不靠文案分类。
- **路由与契约**：`GET/POST /workspaces/:workspaceId/files/:logicalFileId/versions`、`GET /workspaces/:workspaceId/files/:logicalFileId/versions/:versionNo/download`；上传执行轨（归档 403），两个读取端点 `allowArchived: true`；`docs/development/openapi-workbench.json` 同步三条路径、头部参数与 409/422/413 说明，并更新列表描述。
- **测试**：新增 `server/src/http/team-workspace-file-versions-api.integration.test.ts`（**18 个用例**，`createThrowawayDatabase()`，自行构造 0001~0024 基线后应用 0025 验证回填）；登记为 `test:m5:file-versions:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml`）。既有 `team-workspace-shared-files-api` 的 `seedFile` 夹具补建逻辑文件+v1（既有 15 条断言不变、全绿）；`team-workspace-upgrade` 的 0022 回滚用例补 drop 0025 对象以覆盖新迁移回滚。
- **反证（削弱实现即变红）**：① 去掉版本分配 `for update` → 行锁判别用例与三路并发用例均红（并发用例实测出现 `WorkspaceStateConflictError`，只 2/3 成功）；② 失败版本也前移 `latest_version_no` → 失败版本用例红；③ 回填去掉 `workspace_type='team'` → 回填用例红（个人文件被计入）；④ 列表去掉版本关联去重 → 去重用例红；⑤ 列表退回按 `latest_version_no` 关联 → 「历史解析从未成功的文件仍可见」用例红（该回归由父代理复查发现并修复）；⑥ 去掉 `assertCanWriteWorkspaceFiles` → 只读成员上传用例红。均已还原。
- **符合性/质量评审修复（2026-09-11）**：① **只读成员可上传**（P1，违反 §5/AC-08）：新版本上传与新建共享文件都补 `assertCanWriteWorkspaceFiles`（viewer → 403），OpenAPI 去掉「（所有成员）」的错误口径；② 移除鉴权与列表口径不一致（列表按「最高解析成功版本」判 removable、移除按「最高版本」判权，导致按钮可点却 403）→ 统一为同一排序；③ 列表过滤由 `= 'clean'` 恢复为 `<> 'blocked'`，避免 `pending`/`failed` 的回填文件从列表与空间摘要消失（TW-05 可见态回归）；④ 版本列表的 `current` 改为与展示版本一致、`canDownload` 计入 `removed_at`；⑤ 畸形 `X-File-Name`/`X-File-Note` 百分号编码与安全检查未通过原先落 **500**，改为类型化 422；契约里不可达的 413 改为 422 并说明；⑥ 更正本交付记录（列表口径、反证项、用例数）。
- **第二轮质量评审合入条件的落实（2026-09-11）**：
  - **迁移可重复运行**：`0025` 的两张表改 `create table if not exists`；`workspace_files` 回填按主键 `on conflict (id)`（其 id 由对象 id 确定性派生），`workspace_file_versions` 回填按业务唯一键 `on conflict (tenant_id, file_object_id)`（此前只写 `(id)`，重跑会命中唯一约束并让整个迁移回滚）。已用「删除迁移记账后重放整文件」验证可重复执行。**修正过程中的一次失误值得记录**：第一次改错表——把 `(tenant_id, file_object_id)` 写到了没有该列的 `workspace_files` 上，导致全新迁移链直接 `42703` 失败；由验证代理发现，当场修正。
  - **事务内复核（TOCTOU）**：上传与移除都改为在事务内先取空间行锁、再复核「空间活跃 + 调用者仍是成员（且非只读）」，移除的判权改用**锁内**读到的角色；事务外的检查保留为尽早失败。
  - **回归锚点**：新增「列表 removable 与移除鉴权同口径」（判别设计：逻辑文件创建者与最高版本上传人都是 owner、被展示版本上传人是 member，按最高版本判权即 403——已反证）。
  - **未能做出的判别性用例（如实记录）**：评审要求为「移除路径的行锁」补回归测试。实测无法构造具鉴别力的用例——`file_objects` 插入对 `workspaces` 有外键，PostgreSQL 自身会对该行取 `FOR KEY SHARE`，与外部持锁者的 `FOR UPDATE` 冲突，因此**即使删掉显式锁，写入仍会阻塞**；同理「移除后无存活版本对象」这一不变量由事务内的状态复核独立保证（削弱掉全部锁后用例仍绿）。结论：该串行化同时由显式锁、外键的隐式 KEY SHARE 与事务内状态复核三者提供，无法用外部锁用例单独鉴别显式锁；已删除那条不具鉴别力的用例，避免留下「看着在测锁、其实没测」的假锚点。
  - **同名过度承诺的用例改名**：原「UniqueViolation 走 409」用例实际从未触发唯一约束（行锁保证串行），已改名为它真正验证的行为（版本号按 max 分配 + 已移除文件的类型化 409），并在注释中说明唯一冲突分支只是行锁失效时的兜底。
- **第二轮验证追加修复（2026-09-11）**：① **新建共享文件的同类 TOCTOU**：`storeWorkspaceFile` 原先只在事务外校验，请求在途时被归档/撤权仍会落库（验证实测 `AFTER_RELEASE=resolved`）；现与上传新版本、移除一致，在事务内先取空间行锁并复核「活跃 + 成员 + 非只读」。② **只读成员不得移除**（验证 D1，既有行为与设计/方案冲突）：`removable` 加 `role !== 'viewer'`，移除路径对 viewer 走既有拒绝文案；注意这修的是 HEAD 就存在的行为（历史上传人被降级为只读后仍可移除），与「上传」口径终于一致。③ 迁移重放不再产生**孤儿逻辑文件**（回填排除已有版本行的对象，验证 P3-1）。④ 契约与记录的 3 处口径修正（新上传接口摘要不再写「所有成员」、DELETE 说明补「降级为只读同样不可移除」、用例数订正）。⑤ 补两条缺失锚点：**扫描中（pending）文件仍在列表与空间摘要可见**（过滤只隐藏 `blocked`，验证 P3-4）、**移除必须取得空间行锁**（验证代理推翻了我此前「该用例无法构造」的判断——移除不插入 `file_objects`，不触发外键的 KEY SHARE，因此可用外部持锁构造判别性用例；已补回并反证）。⑥ 未提供说明时 `note` 保持 `null` 而不是 `''`。
- **已知潜在（记录，不阻断）**：若某个**被展示版本**的对象是 `blocked`（当前同步扫描不会落库这类对象），外层 `scan_status <> 'blocked'` 会把**整个逻辑文件**从列表挤掉，连更低的可用版本一起消失；`listWorkspaceFileVersions` 也不过滤扫描态。当前不可达，属 TW-05 预留异步扫描态后的潜在回归。
- **未做/超出本任务**：前端版本 UI（TW-07 前端为后续任务，本任务只保证类型可编译）；AC-29 的既定规模查询计划/延迟基线未在本任务重测（无 TW-07 专项预算），且 `docs/history/team-workspace-1b-statistics-findings.md` §8 已标注 1B 基线的文件列表查询形状在 TW-07 之后过时；未新增会话级 pin 表（沿用文档决定）。

### 3-T7 团队动态与通知（TW-08 后端）✅ 已完成（2026-09-12，两轮评审已修并入 main）
- 成员变动、文件上传/移除等事件的动态投影与站内通知；幂等去重、按权限过滤、归档空间不泄露正文；P1。
- 依赖：需要事件源（TW-01/02 的成员事件、1B/3-T6 的文件事件）。
- **验收**：AC-15、AC-16（动态部分）。

**事件源核查结论（实施前先定，2026-09-11）**：

现有可复用面**不足以支撑动态投影**，必须自建事件源：

| 候选 | 现状 | 能否直接用 |
| --- | --- | --- |
| `workspace_revocation_events` | 有 `member_removed`/`member_exit`/`role_changed`，含 `payload_hash` 去重，是**收权机制**的输入 | ❌ 不是通用活动日志：它按撤权语义去重（一次转交产生两条 `role_changed`），且不含文件、归档等事件 |
| 文件上传/移除 | **完全没有写事件**（3-T6 也未写） | ❌ 需要新增 |
| `audit_events` | 由 admin 运营动作写入（`PostgresOperationsService`），面向平台治理 | ❌ 方案明确「审计日志与团队动态使用不同的可见投影」 |
| `run_events` | 单次 Run 的执行事件 | ❌ 普通发送消息不得进入团队动态 |

**数据模型（实施前先定）**：

- 新增 `workspace_activity_events`（append-only 动态事实）：`id`、`tenant_id`、`workspace_id`、`kind`（首版：`member_added`/`member_removed`/`member_exit`/`role_changed`/`owner_transferred`/`agent_member_added`/`agent_member_removed`/`file_uploaded`/`file_removed`/`file_version_added`/`workspace_archived`/`workspace_restored`）、`actor_user_id`、`object_type`、`object_id`、`safe_metadata`（jsonb，**只放可对全员展示的最小信息**，禁止私有正文/附件名）、`dedupe_key`、`occurred_at`；唯一键 `(tenant_id, workspace_id, dedupe_key)` 保证同一业务事件幂等只产生一条。
- 事件必须**与业务变更同事务写入**（业务成功才产生事件）；动态写入失败**不得**把已成功的业务变更伪装成失败——首版采用同事务写入即天然满足「不伪装失败」，若改为异步投影则必须保证这一点。
- 新增 `workspace_notification_states`（每人每空间一行）：`tenant_id`、`workspace_id`、`user_id`、`last_read_at`、`muted_at`。未读数 = 该空间在 `last_read_at` 之后的动态条数；`muted_at` 非空表示关闭提醒（仍可在动态里看到，只是不计数/不提醒）。
- **可见投影**：`GET /workspaces/:id/activity` 与通知列表都要求**当前成员**（读轨，归档空间仍可读）；查询按 `workspace_members` 过滤，非成员与不存在空间不可枚举。失去权限后**不得**通过旧通知读取正文或敏感名称——因此 `safe_metadata` 只存最小信息，且每次读取都重新校验成员资格（不缓存跨撤权）。
- **明确不进入动态**：普通消息发送、未共享的对话活动、Run 的执行细节（方案 TW-08 第 2 条）。
- **不在本任务内**：前端「最近动态」摘要与「查看全部」抽屉（3-T8）、邮件/短信/外部聊天（首版明确不做）。

**交付记录（2026-09-12，后端实现；两轮评审与修复见下）**：

- **迁移 `0026_workspace_activity.sql`**（100 行，纯新增、不 `alter` 任何既有表，因此可重复执行且对既有数据零影响）：
  - `workspace_activity_events`（append-only 动态事实）：`id`/`tenant_id`/`workspace_id`/`kind`/`actor_user_id`/`object_type`/`object_id`/`safe_metadata`/`dedupe_key`/`occurred_at`；`kind` 与 `object_type` 均为 **CHECK 闭合集合**（kind 12 种、object_type 4 种），消息正文与 Run 执行细节**不可表示**；唯一键 `(tenant_id, workspace_id, dedupe_key)`；外键 `(tenant_id, workspace_id) → workspaces(tenant_id, id)` 与 `(tenant_id, actor_user_id) → users(tenant_id, id)`；feed 索引 `(tenant_id, workspace_id, occurred_at desc, id desc)`（同一索引兼作 `occurred_at > last_read_at` 的未读计数）。
  - `workspace_notification_states`（每人每空间一行）：`last_read_at`、`muted_at`，主键 `(tenant_id, workspace_id, user_id)`。**无行 = 从未读过也从未静音**（不预建行）。
  - **不做回填**：历史动态不凭空发明（任务书「不清点历史动态」）；也**不为个人空间写入任何行**，个人空间没有任何端点读这两张表（AC-23）。
- **写入器 `workspace-activity-writer.ts`**：`recordWorkspaceActivity(tx, input)` **必须在业务事务内调用**，`on conflict (tenant_id, workspace_id, dedupe_key) do nothing` —— 重复写入是静默 no-op，既不会产生第二条动态，也不会把业务事务打挂。同事务是「不伪装失败」的实现方式：活动写入失败会连带回滚业务变更，而不是让已提交的变更事后报错。
- **去重键设计（三种令牌，按事件形状选择；这是本任务最容易做错的地方）**：

  | 形状 | 令牌 | 适用 kind |
  | --- | --- | --- |
  | 结果状态不会重复（或行本身一次性） | 自然键 | `member_added`/`member_removed`/`member_exit`（`user_id + joined_at` 代际）、`file_uploaded`（`file_object_id`）、`file_removed`（逻辑文件/对象 id）、`file_version_added`（`logical_file_id + version_no`）、`owner_transferred`（`from->to + revision`） |
  | 结果状态可重复出现（A→B→A→B、归档→恢复→归档、Agent 重加） | `activityTransitionToken(tx)` = `pg_current_xact_id()::text`（同一事务内稳定、跨事务唯一） | `workspace_archived`/`workspace_restored` |
  | 成员/Agent 变更（同一事务内已 `bumpTeamAuthRevision`） | `currentTeamAuthRevision(tx)` = bump 后的 `workspaces.team_auth_revision` | `role_changed`、`agent_member_added`/`agent_member_removed` |

- 纯状态派生键（例如只用 `from->to`）会把 A→B→A→B 的后面几次**真实变更静默吞掉**；纯 `now()` 键又会让重试产生第二条。上述令牌同时满足「重试/并发重复 → 一条」与「真实重复状态变更 → 各自一条」。
  - 「是否真的变了」由**每个调用点的判别守卫**保证（不是靠去重键猜）：`insert … on conflict do nothing returning joined_at`（成员新增）、`delete … returning joined_at`（移除/退出）、`update … where member_role is distinct from $role returning joined_at`（改角色/转交）、归档恢复入口的「已是目标状态即早退」、`insert … on conflict (tenant_id, file_object_id)`（新版本）。
- **写入点（全部在同一业务事务内）**：`postgres-workspace-member-service.ts`（`member_added`/`role_changed`/`member_removed`/`member_exit`/`owner_transferred`）、`postgres-workspace-agent-member-service.ts`（`agent_member_added`/`agent_member_removed`）、`postgres-content-service.ts`（`file_uploaded`（新建共享文件 v1）、`file_version_added`（上传新版本）、`file_removed`（逻辑文件路径与 TW-07 之前直接落在 `file_objects` 上的兼容路径各一处））、`postgres-workspace-lifecycle-service.ts`（`workspace_archived`/`workspace_restored`）。
  - 记录一处**顺带修正**：转交负责人的第二个撤销事件（目标成员的 `role_changed`）原先无条件写入，现改为仅在该事务真的把目标提升为 owner 时写入；并发重复转交的败者不再写一条并不存在的 `role_changed`（同时也不再产生 `owner_transferred` 动态）。
  - **`safe_metadata` 白名单**（只放 id／角色／版本号，任何名称与正文都不进入）：成员类 `{userId, role}`／`{userId, from, to}`／`{fromUserId, toUserId}`；Agent 类 `{agentMemberId, agentId}`；文件类 `{logicalFileId, versionNo}`（文件名、更新说明、会话附件名一律不写）；归档类 `{}`。动态项只带 `object_id`，名称交给「成员本来就能读」的文件/成员列表去解析。
- **服务层 `postgres-workspace-activity-service.ts`**：`listActivity`／`getActivityItem`／`getNotifications`／`markNotificationsRead`／`setNotificationsMuted`。每个公开方法**先重新解析读取轨**（`workspaces.resolveReadableWorkspace`，每次查库、不缓存成员资格）：归档团队空间可读、个人空间 422「仅支持团队工作空间查看团队动态」、非成员与不存在空间返回**完全一致**的 403（不可枚举）；空 `workspaceId` 在解析前就 422，避免 `resolveReadableWorkspace` 的空值回退把「查看者自己的个人空间」当默认值创建出来。
- **游标与精度（实现代理实测发现）**：分页为 `(occurred_at desc, id desc)` 的 keyset；服务端把游标编成 `base64url(JSON{t,i})`。**关键点**：`occurred_at` 作为 JS `Date` 只有毫秒精度，而 DDL 是微秒精度的 `timestamptz`，直接把 `Date` 传回驱动做游标会让同一毫秒内的行重复或漏掉——因此查询额外取 `occurred_at::text`（DB 侧全精度文本）作为游标令牌，回传时写成 `((${token}::text)::timestamptz)` 双重转换：先按字符串发送（否则 postgres.js 会把 `timestamptz` 参数折成毫秒），再在库内解析。`limit` 默认 20、必须在 1..100 的十进制整数，否则类型化 422（评审 F6：`Number()` 会放行 `0x10`/`1e2`，已在路由层按形状拒绝）；多取一行判断 `nextCursor`。**畸形游标**（base64/JSON 合法但 `t` 不是时间戳、空串、含 NUL）由形状校验 + SQLSTATE 翻译统一落类型化 422，绝不落 500（评审 F1/D1，见下）。
- **未读与静音语义**：未读 = `occurred_at > last_read_at`（无状态行则全部未读）；`markNotificationsRead` 用 upsert 把 `last_read_at` 推进到 `now()`；`muted_at` 非空时 `unreadCount` 报 0 但**动态 feed 照常返回**（对齐 TW-08「关闭提醒仍可在动态里看到」），静音不清空已读位置。
- **路由与契约**：`GET /workspaces/:id/activity`、`GET /workspaces/:id/activity/:activityId`、`GET /workspaces/:id/notifications`、`POST /workspaces/:id/notifications/read|mute|unmute`（6 条，`workspace-activity-routes.ts`，`main.ts` 接线）。**全部为读取轨（`allowArchived: true`）**；写路径只有「某人自己的已读/静音状态」，不触碰空间业务数据，因此归档空间仍可用。`docs/development/openapi-workbench.json` 同步 6 条路径与 4 个 schema（含 limit/cursor、422/403 说明）。
- **测试**：新增 `server/src/http/team-workspace-activity-api.integration.test.ts`（**评审修复后 21 个用例**，`createThrowawayDatabase()`），登记为 `test:m5:activity:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml` 三处，已进 CI 质量门）。覆盖：0026 可重复执行且不回填（AC-17）、成员增/删/退/改角色/转交与重复无变化的去重、**并发改角色的 from/to 链路完整**、被拒绝的变更不产生动态、Agent 增删、文件上传/新版本/移除且不泄露文件名与正文、会话附件不进入动态、归档/恢复及「归档→恢复→归档」两条、非成员与不存在空间拒绝一致（不可枚举）、归档空间可读、keyset 分页无重复无遗漏、**同一毫秒内两条动态的微秒游标**、**构造型畸形游标一律 422（不落 500）**、**limit 只接受 1..100 十进制整数**、失权成员不能再用旧 id 读取、未读计数与标记已读、**标记已读的 last_read_at 单调不回拨**、静音与恢复计数、个人空间 422 且不产生任何动态（AC-23）。
- **本机验证**：`pnpm verify`、`pnpm typecheck`、`pnpm lint` 通过；`test:m5:activity:integration` **21/21（连续三次稳定）**。
- **明确不做**：前端「最近动态」摘要与「查看全部」抽屉（3-T8）；邮件/短信/外部聊天；历史动态回填；普通消息、未共享对话活动与 Run 执行细节进入动态；AC-29 规模基线未重测（沿用 `docs/history/team-workspace-1b-statistics-findings.md` §8 对既有文件列表查询形状的过时告警）。

**两轮评审与修复（2026-09-12）**：

- **结论**：独立规格符合性评审「有条件符合 → 修 D1 后符合」；独立对抗性质量评审「PASS with one P1 fix required」。两轮各自独立复核并**互相印证**的核心结论：事件源必须自建、去重与并发重复、同事务原子性（强制动态写入失败时业务变更整体回滚）、接收与点击两次鉴权、不可枚举、归档读取轨、个人空间零面（AC-23）、`safe_metadata` 白名单无泄露、无 SQL 注入（参数化）。两轮也都**独立验证**了「游标必须用数据库文本令牌」这一 claim：质量评审实测 postgres.js 把 `timestamptz` 参数（Date 与字符串都一样）折到毫秒，规格评审实测只有 `(($n::text)::timestamptz)` 双重转换能保留微秒，毫秒令牌会漏行。
- **F1/D1（P1，两轮同时发现，已修）**：构造型游标（base64 与 JSON 都合法、`t` 不是时间戳、空串、不可能日期、`i` 含 NUL）直达 `(($n::text)::timestamptz)`，PostgreSQL 报 **22007/22021**，被路由器分类成 **500 `operation_failed`**——任何成员都能制造 500 与告警噪音，且与契约只声明 422 不符。修复：`decodeActivityCursor` 增加形状校验（非空、无 NUL、长度上限），新增 `runCursorQuery` 把 **22007 / 22008 / 22021 / 22P02** 翻译为类型化 422 `invalid_request`。新增「6 种畸形游标 × 2 个端点」用例 + 合法游标仍 200；**反证**：禁用翻译即红（实测「非时间戳文本 游标在 /activity 上必须 422，实际 500」）。
- **F2/D5（P2，已修；并顺带修掉同一处的一处越权竞态）**：`role_changed` 的 `from` 取自**事务外**的角色快照（`:241` → metadata/撤权 payload），并发改角色时败者写入过期 `from`（质量评审实测真实链路 member→admin→viewer 却记成两条 `from=member`）。修复：在事务内、拿到空间行锁后用 `select … for update` 重读角色，撤权 payload、动态 `metadata` 与去重键统一使用该值；**并在事务内重跑 `assertRoleChangeAllowed`**——否则锁外快照为 `member`、实际已是 `admin` 时，管理员可以借竞态把另一个管理员降级。新增判别性用例（外部事务持有空间行锁，强制两个请求在锁外读完快照后一起排队；只靠 `Promise.all` 不稳定，削弱实现时该用例仍绿，故必须强制时序）并反证（削弱即红，实测链路 `[{from:member,to:admin},{from:member,to:viewer}]`）。
- **F4（P2，已修）**：`markNotificationsRead` 的 `do update set last_read_at = now()` 会把已读位置**往回拨**（质量评审 DB 级实证），即已读状态可倒退。改为 `greatest(coalesce(现值, now()), now())` 保持单调。新增用例（预置 2099 年的已读位置后标记已读不得倒退；落后位置仍须被推进）并反证。
- **F6（nit，已修）**：路由 `Number(raw)` 会把 `limit=0x10`（16）与 `1e2`（100）当合法值放行。改为只接受 `^[0-9]{1,3}$`，其余走类型化 422。新增用例并反证（实测削弱后 `limit=0x10` 返回 200）。
- **D3（nit，已修）**：升级套件的 0022 回滚用例补 drop 并重放 0026 的两张表，断言 `0025`/`0026` 均被重放、`to_regclass` 确认 `workspace_activity_events` 与 `workspace_notification_states` 回到库中。
- **F3（P2，口径已确认）**：归档空间允许「标记已读／关闭提醒」（只写调用者**本人**的通知状态行，属读取轨），业务写入仍全部 403。2026-09-12 确认**保留**该入口（否则归档空间会出现无法消除的未读徽标），并更正任务书原句「不显示会触发写入的入口」的过宽表述。
- **F5（记录，不修）**：评审用触发器强制动态写入失败后，业务变更在 4 条路径上全部正确回滚（0 成员/0 文件/0 动态），客户端得到 500 `operation_failed`。这是**基础设施故障**而非可键入错误，评审也未找到任何客户端可达的触发路径；改成 4xx 反而会掩盖真实故障。AC-15 要求的原子性由该实验证明。
- **F7 / D2(c)（记录，按设计）**：`file_version_added` 在上传事务内写入，而解析在其后的事务里，因此解析失败时该动态仍保留。这是刻意的：不可变对象与版本行都保留（AC-13 可追溯），动态只声明「提交了一个新版本」，版本列表会以 `parseStatus=failed` 说明真实结果。
- **D2（措辞更正）**：初版交付记录写「a retried or racing occurrence cannot add a second row」——该表述只对**同一业务事实的重复写入**（并发重复、同事务重放）成立，**不构成 HTTP 重试幂等**：同内容再次上传会产生新的逻辑文件或新版本号，因而各写一条动态（评审实测 2 条）。本文已按此口径更正。
- **D4（口径已记录）**：新成员会把加入前的历史动态计为未读（评审实测加入前 3 条 + 自己加入 1 条 = 4）。与既定数据模型一致（按当前成员过滤、不按 `joined_at` 过滤），首版**保留**；若要改为「只计加入之后」，需在 feed 与未读查询里接入 `workspace_members.joined_at`，属范围变更。
- **D6（口径已记录）**：`workspace_notification_states` 不随成员移除清理，被移除后重新加入会继承旧的 `last_read_at`/`muted_at`。按「每人每空间一份通知偏好」的模型**保留**；若产品要求「重新加入即重置」，需在移除路径删除该行。
- **提交与 CI（2026-09-12）**：`24774e6`（`feat(server),docs: 团队动态与站内通知（TW-08 / 3-T7）`）已推送 `main`，CI `M6 quality gate`（run `34666778699`，4m28s）通过；`test:m5:activity:integration` 已进 CI 质量门。
- **回归（本次修复后重跑）**：activity **21/21（连续三次稳定）**、members 36/36、lifecycle 20/20、file-versions 18/18、shared-files 15/15、agent-members 19/19、security 4/4、workspace:upgrade 4/4；`pnpm verify`、`pnpm lint`、`pnpm typecheck` 全部通过。

### 3-T8 前端团队动态与通知（TW-08 前端）✅ 已完成（2026-09-12，两轮评审已修）
- 右栏成员区之后「最近动态」摘要（3 条）与「查看全部」抽屉；未读标记与按空间关闭提醒入口。
- 归档空间的动态仍可读（读取轨）；**不显示会触发业务写入的入口**。动态条目本身为纯文本展示（规范未定义跳转目标），因此不提供上传/续写等动作，也不产生额外请求面。
- **验收**：AC-15（前端部分）、AC-16。

**范围与实现要点（实施前先定，2026-09-12）**：

- **数据来源（3-T7 已交付的 6 条接口）**：摘要与抽屉都用 `GET /workspaces/:id/activity`（`limit=3` 取摘要，抽屉分页 `limit=20` + `cursor`）；未读与静音用 `GET /workspaces/:id/notifications`、`POST …/notifications/read|mute|unmute`。前端**不新增接口**，也不解析 `safe_metadata` 之外的内容。
- **渲染位置**：`packages/workbench-components/src/WorkspaceInfoPanel.vue` 是纯展示组件且自身不发请求（数据由宿主 `WorkspaceDetailView.vue` 传入），因此沿用该模式：宿主负责加载动态/未读/静音并传 props，新的「最近动态」区块与「查看全部」抽屉放在成员区之后（design §2.9；抽屉用 `el-drawer`，不占第四个主内容页签）。个人空间分支**不发任何动态请求**（AC-23）。
- **动态文案**：只按 `kind` + `objectId`（+ `safeMetadata` 的角色/版本号）+ `actorDisplayName` 生成；**不使用任何名称字段**（服务端本就不返回）。文件类动态的名称展示交由「成员本来就能读」的文件列表解析，解析不到时显示中性占位（例如「一个文件」），不得显示 id 原文作为名称。
- **未读与静音**：空间卡片/右栏显示未读计数徽标；「标记全部已读」调 read；「关闭提醒/恢复提醒」调 mute/unmute。静音后未读计数按服务端口径为 0（`muted=true`），但动态列表仍显示全部条目——前端不得自行过滤。
- **归档空间**：动态摘要与抽屉**仍渲染**（读取轨）；归档态不显示业务写入口（沿用 3-T3 的 `status` 判定）。**口径已确认（2026-09-12）**：未读/静音是「本人通知偏好」而非空间业务写入，服务端在归档空间也允许（路由 `allowArchived: true`）；归档空间**保留**「标记已读／关闭提醒」入口（否则用户会出现无法消除的未读徽标），仅隐藏上传/续写等业务写入口。此条更正任务书原句「不显示会触发写入的入口」的过宽表述。
- **删除与保留**：动态为 append-only，前端不提供删除入口；不新增「动态」主内容页签（design §2.9／方案 3.2）。
- **测试**：沿用 `apps/workbench-web` 的 vitest + `@vue/test-utils`；判别性用例至少覆盖：摘要只取 3 条、抽屉分页与游标、未读徽标与标记已读后归零、静音后徽标消失但列表仍显示、归档空间仍渲染且无业务写入口、个人空间不发请求、kind → 文案映射不读名称字段、动态加载失败进入错误态并可就地重试。
- **不在本任务内**：任何后端改动（3-T7 已交付）；邮件/短信/外部聊天；历史动态回填。

**交付记录（2026-09-12，前端实现；两轮评审见下）**：

- **分层**：服务端契约不变（3-T7 的 6 条端点）。文案与展示装配拆成两处纯逻辑：`packages/workbench-components/src/workspace-activity.ts`（12 种 kind 的闭合集合 + `describeWorkspaceActivity`，供展示型面板与宿主抽屉**共用一份中文文案**）与 `apps/workbench-web/src/utils/workspace-activity.ts`（`buildActivityDisplayItems` / `resolveActivityFileName`）。`WorkspaceInfoPanel.vue` 仍是**纯展示组件、自身不发请求**（沿用 `agentMembers` 的既有模式）：宿主 `WorkspaceDetailView.vue` 负责加载并传 props。
- **宿主加载**：摘要用 `GET /activity?limit=3`；未读/静音状态用 `GET /notifications?limit=1`（只要 state 与计数）。两者都只在团队分支调用（`isTeam` 门禁），**个人空间零请求**（AC-23）；面板侧再以 `workspace.type === 'team'` 兜一层不渲染。
- **「查看全部」抽屉**：`el-drawer`，首屏 `limit=20`，「加载更多」跟随服务端 `nextCursor` 直到为 null；抽屉条目为纯文本（规范未定义跳转目标），**因此不暴露任何写动作**；关闭后焦点回到「查看全部」触发按钮。
- **名称零泄露**：文案只由 `kind` + `safeMetadata`（role / from / to / versionNo）+ 演员名 +（宿主解析出的）文件名生成。文件名先在已加载的空间文件列表里按 `logicalFileId` 匹配、回落 `file.id`（兼容 TW-07 之前直接落在 `file_objects` 上的 `file_removed`）；解析不到时用中性占位（「一个文件」／「文件的新版本」），**绝不把 `objectId` 当名称渲染**。
- **12 种 kind 文案**：`member_added`「以{角色}身份加入了空间」、`member_removed`「移除了成员」、`member_exit`「退出了空间」、`role_changed`「将成员角色从{from}改为{to}」、`owner_transferred`「转交了负责人」、`agent_member_added`/`agent_member_removed`「添加了/移除了 Agent 成员」、`file_uploaded`「上传了文件“{name}”」、`file_removed`「移除了文件“{name}”」、`file_version_added`「上传了文件“{name}”的 V{n} 版本」、`workspace_archived`/`workspace_restored`「归档了/恢复了空间」。缺字段时逐项降级为不带该信息的句子；闭合集合由类型与单测双重锁定（12 种互不相同）。
- **未读与静音**：徽标直接取服务端 `unreadCount`；静音时按服务端口径视为 0 并显示「已关闭提醒」，但**列表一条都不过滤**（TW-08「关闭提醒仍可在动态里看到」）。`标记全部已读` 调 `read` 并用**返回值**回写状态（不本地伪造）；动作失败只提示，不改变已有状态。
- **归档空间**：摘要与抽屉**照常渲染**（读取轨），`标记已读／关闭提醒` **保留**（调用者本人的通知偏好，2026-09-12 确认），业务写入口沿用 3-T3 的既有隐藏逻辑，本任务未改动。
- **状态与可访问性**：加载中骨架、无动态空态、加载失败就地错误 + 「重试」（重试真的重新发起请求，且不清空右栏其它区块）；摘要入口与动作都是真按钮，图标按钮带 `aria-label`（design §3/§4）。
- **API 与类型**：`src/api/client.ts` 新增 6 个方法（列表／单条／通知状态／标记已读／静音／取消静音）；`src/types/domain.ts` 补动态与通知 DTO，并给 `WorkspaceFile` 补可选 `logicalFileId`（服务端团队文件摘要本就返回该字段，属前端类型补齐，**无契约变更**）。
- **测试**：`pnpm test:m5:frontend` **18 files / 175 passed**（基线 146，新增 29：`utils/workspace-activity` 8、`WorkspaceInfoPanel.activity` 8、`WorkspaceDetailView` +8、`api/client` +5）；`pnpm typecheck`、`pnpm lint` 通过。
- **反证（削弱实现即变红，均已还原）**：① 摘要去掉 `.slice(0,3)` → 长度断言红；② 徽标忽略 `muted` → 静音用例红；③ 标记已读不回写状态 → 徽标清零用例红；④ 分页把 cursor 置 null → 首屏即「已加载全部」；⑤ 去掉 `isTeam` 门禁 → 个人空间用例报 `listWorkspaceActivity` 被调用；⑥ `retryActivity` 置空 → 只请求 1 次；⑦ 未解析文件名回落成 `objectId` → 渲染出 `wfile-…` 被断言抓住；⑧ `member_exit` 复用 `member_removed` 文案 → 12 种文案去重断言红；⑨ 归档时隐藏动态区块 → 归档用例红。
- **未能验证（如实记录）**：Esc／遮罩关闭抽屉的键盘路径（VTU 默认 stub `<transition>`，Element Plus 的 `@closed`/`update:modelValue` 在 happy-dom 中不触发；焦点恢复改用 `watch(activityDrawerOpen)` + `isConnected` 守卫实现并单测了该路径）；真实浏览器布局与 1180/640/520 断点（本机 `pnpm test:e2e` 受 OIDC 允许来源限制，未跑 Playwright）。
- **口径决定**：文案映射放在共享包内（面板与抽屉共用，避免两份中文文案漂移）；抽屉行暂未接点击（规范未定义跳转目标），因此**已删除**未被任何视图使用的单条动态客户端方法及其用例，不保留死代码。

**对抗性质量评审与修复（2026-09-12）**：

- **结论**：**PASS with required fixes**（2 × P1 必修）。评审在 `/tmp` 副本中独立复现，未改动工作树；其复核为干净的方面包括 AC-23 by construction（个人空间、team→personal、未知 id、空 id 四条路径全部零请求）、恶意 `safeMetadata` 不抛错、无 `v-html`/属性注入、卸载后落地不抛错、动作失败不伪造状态、往返静音一致、焦点恢复与关闭按钮 `aria-label`。
- **P1-1 抽屉「重试」把点击事件当成 workspaceId（已修）**：模板 `@click="loadActivityPage"` 遇上带默认参数的 `loadActivityPage(workspaceId = …)`，Vue 会把 `MouseEvent` 传进去，实测请求 `/workspaces/%5Bobject%20Object%5D/activity?limit=20`，即**抽屉失败后的重试永远不可能成功**。修复：`@click="loadActivityPage()"`；新增判别性用例断言每次调用的第一个参数都是空间 id（且不含 `object`/`MouseEvent`），**反证**：改回不带括号即红。
- **P1-2 缺少请求世代守卫，旧空间的响应会写进当前空间（已修）**：摘要／未读徽标／静音标签／抽屉首页／「加载更多」以及两个变更接口全部直接回写，切换空间或连续重试时晚到的旧响应会覆盖新状态（评审实测：切到 ws-team-2 后仍渲染 ws-team-1 的动态、徽标显示旧空间的 99、静音按钮串味；乱序重试时旧结果反超）。修复：三条流（摘要／通知状态／抽屉）各自维护世代号，异步回写前**同时**比对世代号与发起时的空间 id，空间切换时 `invalidateActivityRequests()` 作废全部在途请求，「加载更多」与当前页同世代。新增 4 条判别性用例（旧摘要、旧徽标、旧静音、乱序重试），**反证**：把守卫改成恒真即四条全红。
- **P2-1 越界响应体掀翻整页（已修）**：抽屉直接 `activityDrawerItems.value = page.items`，`items` 缺失时在渲染期抛 TypeError，**整个详情页（含成员区）都渲染不出来**。修复：摘要与抽屉都做 `Array.isArray` 兜底。新增用例断言无渲染错误且成员区仍在，**反证**：去掉兜底即红。
- **P2-2 一条坏数据掀翻整块右栏（已修）**：`actorDisplayName` 契约上是 `string`，但运行期可能为 `null`/数字/对象，`actorName` 只处理空串，`null.trim()` 会抛错并让成员/Agent/动态全不渲染。修复：`typeof === 'string'` 守卫，并给未知 `kind` 加 `default` 中性文案（不再渲染空白行）。新增用例（null/undefined/42/对象/数组 + 越界 kind），**反证**：还原 `.trim()` 即红。
- **P2-3 重复游标导致重复渲染（已修）**：「加载更多」按 id 去重，且当服务端返回同一游标或本页没有新条目时视为到底（按钮消失、显示「已加载全部」）。新增用例，**反证**：去掉去重即红。
- **P2-4 空首页带游标是死角（已修）**：首页条目为空时清空游标；同时把分页脚移出列表分支——只要服务端还给游标就必然给出「加载更多」出口（否则用户会看到「有游标却无处可点」）。新增用例，**反证**：还原为直接取 `nextCursor` 即红（第一次写这条用例时它削弱后仍绿，说明不具鉴别力，因此连同模板一起改造成可鉴别）。
- **P2-5 提醒状态加载失败被伪装成「没有未读」（已修）**：原先失败即把状态置 `null`（徽标消失、与真实 0 未读无法区分）。修复：新增 `notificationError`，失败时保留旧值并渲染「提醒状态加载失败 + 重试」，空态也不再误显示；重试会同时重取摘要与提醒状态。反向（失败但摘要正常）也不会连累动态列表。新增宿主与面板两条用例，**反证**：还原为 `state = null` 即红。
- **P2-6 抽屉可访问名称悬空（已修）**：`:with-header="false"` 会让 Element Plus 写出指向不存在元素的 `aria-labelledby`（评审用零产品代码的 `el-drawer` 对照组确认是该配置固有行为，非本项目内联 header 所致）。修复：显式 `aria-label="全部动态"` + `:aria-labelledby="undefined"`。新增用例断言 dialog 根的 `aria-label` 与 `aria-labelledby` 为空，**反证**：去掉即红。
- **P2-7 / P2-8 / nit（已修）**：未读徽标加 `role="status"` + `aria-live="polite"`；动态时间补 `<time :datetime>`（展示项携带原始 ISO）；版本号只接受 1..1000000 的正整数（`1e21`/`-1`/万位数字串降级为「新版本」）；未读计数只渲染正整数（小数向下取整、负数不渲染）；长文件名加 `overflow-wrap: anywhere`/`word-break: break-word`；删除未被视图使用的单条动态客户端方法与用例。
- **回归（修复后重跑）**：`pnpm test:m5:frontend` workbench **19 files / 193 passed**（新增 19 条：竞态与越界 12、面板 2、工具 5）、admin 6 files / 18 passed；`pnpm typecheck`、`pnpm lint` 通过。
- **未能验证（与实现记录一致）**：Esc／遮罩关闭抽屉的键盘路径（happy-dom 不触发 Element Plus 的 `@closed`，评审用对照组确认属环境限制而非产品缺陷；产品未覆盖默认行为）、真实浏览器布局/断点/屏幕阅读器输出。

**规格符合性评审与修复（2026-09-12）**：

- **结论**：**有条件符合**——3-T8 自身范围（摘要语义、名称零泄露、12 种文案、未读/静音、归档读取轨、个人空间零请求、错误/空/加载态、分页、契约保真、可访问性）**逐项通过**；评审另用 16 条独立探针复验，并**独立推翻/确认**了质量评审的发现（含 `actorDisplayName=null` 抛错、未知 kind 空白、`versionNo` 溢出等在修复轮后已复验通过）。两条条件即下面的 F1/F2。
- **F1（P3，已修）挂载期冗余重复请求**：`onMounted` 的 `contentStore.refresh()` 会用新对象替换 store 数组，`workspace` computed 因此再次触发 immediate watcher，摘要与提醒状态各请求 **2 次**（世代号只丢弃旧响应，不阻止重复请求）。修复：以「上次真正加载过的空间 id」做同参去重（与 3-T3 列表筛选同一思路），只有真正的空间切换才重置并加载。新增两条判别性用例（同 id 替换不得重复请求；切到另一空间仍必须且只加载一次），**反证**：去掉去重 → 重复请求用例红；改成「有 id 就不加载」→ 切换用例红。
- **F2（P2，已修；3-T3 遗留缺口）归档空间右栏 Agent「开始对话」写入口仍在渲染**：面板只按 `status==='available' && allowedActions` 渲染，而服务端 `allowedActionsFor` 不考虑归档；design §2.7 明确把「开始对话」列为归档必须隐藏的写入口。3-T3 的写入口审计只覆盖了成员弹窗内的同名入口。修复：面板按服务端 `workspace.status` 判定（归档不渲染该按钮，条目本身仍只读展示），宿主 `startAgentConversation` 再加一道 `isArchived` 纵深防御；design §2.7 的清单补上「右栏 Agent 条目的开始对话入口」。新增判别性用例（活跃可点 / 归档不可点），**反证**：去掉归档判定即红。
- **F3（P3，口径已定）第 6 条接口当前无消费方**：`GET /workspaces/:id/activity/:activityId` 仍在 OpenAPI 中且由服务端集成用例覆盖；前端抽屉行按规范为纯文本（规范未定义跳转目标），因此不接点击、也不保留未被使用的客户端方法。**「动态项只做跳转」的原表述已更正为「纯文本展示」**；若后续确定跳转目标，再补客户端方法与行点击，点击路径的成员资格复核已由服务端实现并测试。
- **F4（nit，已加锚点）kind 联合类型在两处重复定义**：改为加一条**契约测试**——前端 `ALL_KINDS` 必须与 `server/migrations/0026_workspace_activity.sql` 的 `kind` CHECK 集合逐一相等（从仓库中读取迁移文件比对），任何一侧新增第 13 种而另一侧没跟上即失败。**反证**：从任一集合去掉一个 kind 即红。
- **F5（nit，记录）摘要顺序纯依赖服务端 `order by occurred_at desc, id desc`**：前端只做 map，不重排（避免用不完整的客户端信息伪造服务端排序）。契约由服务端集成用例的「分页顺序与一次性读取一致」断言保证。
- **F6（记录）评审期间规格文档与代码同步改动**：评审以 HEAD 版 design §2.9（当时只有「仅预留位置」）与任务书原 3-T8 为基准判定，而本次改动同时改写了 design §2.9/§5 与任务书——这是父代理的文档职责，但也说明**同一提交内的规格改写不能作为实现的自我证明**；本条以评审的独立探针结论为准。
- **本轮回归**：`pnpm test:m5:frontend` workbench **19 files / 197 passed**、admin 6 files / 18 passed；`pnpm typecheck`、`pnpm lint`、`pnpm verify` 通过。
- **提交与 CI（2026-09-12）**：`54fde3e`（`feat(workbench-web),docs: 团队动态与通知前端（TW-08 / 3-T8）`）已推送 `main`，CI `M6 quality gate`（run `34668358547`）通过。

### 3-T9 TW-07 前端版本 UI（批次 3 补遗）✅ 已完成（2026-09-12，两轮评审已修）
- **目标**：让 TW-07 的版本能力在员工端真正可用——文件页显示版本、上传新版本、查看版本列表（含失败版本）、下载历史版本、按所选版本引用到对话。3-T6 只交付了后端，本条是 TW-07 的收尾。
- **后端契约（3-T6 已交付，本任务不改后端）**：
  - `GET /workspaces/:id/files` 的每一项已带 `logicalFileId`/`versionNo`/`versionCount`（列表展示的是最高**解析成功**版本）。
  - `GET /workspaces/:id/files/:logicalFileId/versions` → `{ logicalFileId, name, status, latestVersionNo, versionCount, items: [{ versionNo, fileId, logicalFileId, name, type, size, note, uploadedBy, uploadedAt, scanStatus, parseStatus, current, canDownload }] }`（版本号倒序，含失败版本；`current` = 文件列表当前展示的版本）。
  - `POST /workspaces/:id/files/:logicalFileId/versions`，头部 `X-File-Name`（必填，需 `encodeURIComponent`）与 `X-File-Note`（可选，≤500 字符），body 为文件字节；201 返回新版本（含 `versionNo`）。
  - `GET /workspaces/:id/files/:logicalFileId/versions/:versionNo/download` → 二进制；不可下载时服务端拒绝。
- **轨道与门禁**：上传新版本与「按版本引用到对话」都属**执行轨**（归档隐藏入口、只读成员不给上传入口——服务端对 viewer 返回 403）；版本列表与历史版本下载属**读取轨**（归档空间对现任成员仍可用，失权成员拒绝）。
- **AC-23**：个人空间不渲染任何版本 UI，也不发版本请求。
- **失败版本（AC-13）**：照常列出并标注解析状态（失败/待解析），**不提供**「引用到对话」；是否可下载一律以服务端 `canDownload` 为准，前端不自行推断。
- **按版本引用**：`ConversationStarter.useWorkspaceFile(file)` 已经用传入对象的 `id` 作为引用 id，因此「引用此版本」只需把该版本的 `fileId` 作为 `id` 传入（引用最新有效版本的默认路径行为不变）；历史 Run 由此可追溯到实际输入版本。**归档空间隐藏该入口**（与 design §2.7 把「引用到对话」列为归档必须隐藏的执行轨入口一致：归档不渲染 `ConversationStarter`，引用会落成空操作 + 假成功提示）。
- **状态**：加载中骨架、无版本空态、失败就地错误 + 重试（重试真的重新请求）；上传失败不改变已有版本与 `current` 标记。
- **测试**：判别性用例至少覆盖——文件行显示版本号与版本数；上传新版本调用契约（头部编码、note 上限、成功后刷新）；归档隐藏上传入口但保留版本列表与下载；viewer 不给上传入口；归档空间隐藏上传与引用入口、但保留版本列表与历史版本下载（**原写「归档仍可引用」是任务书自相矛盾，已按 design §2.7 更正**）；失败版本列出但不可引用、下载按 `canDownload`；个人空间零请求；解析失败上传的错误态；「引用此版本」传入的是该版本的 `fileId`。
- **不在本任务内**：任何后端改动；AC-29 规模基线重测。

**交付记录（2026-09-12，前端实现；两轮评审见下）**：

- **文件**：新增 `apps/workbench-web/src/components/WorkspaceFileVersionsDialog.vue`（版本列表对话框）与 `apps/workbench-web/src/utils/workspace-file-versions.ts`（`describeVersionParseStatus` / `canReferenceVersion` / `toVersionFileReference` / `formatFileVersionLabel`，纯函数）；`src/api/client.ts` 增加 `listWorkspaceFileVersions` / `uploadWorkspaceFileVersion` / `downloadWorkspaceFileVersion`，`src/types/domain.ts` 补版本 DTO 与 `WorkspaceFile.versionNo?/versionCount?`；`src/views/WorkspaceDetailView.vue` 接入文件行版本徽标、行级「版本」入口（读取轨）与「上传新版本」入口（执行轨）。
- **UI 选型**：版本列表用 `el-dialog`（单个逻辑文件的从属明细，与全局「全部动态」抽屉分层），复用既有弹窗规范（640px 自适应、自定义 header、关闭按钮 `aria-label`）；焦点恢复沿用 `watch(open)` + `isConnected` 守卫。
- **上传新版本**：入口条件 `isTeam && !isArchived && 角色已知且非 viewer`；选文件后用 `ElMessageBox.prompt` 询问可选更新说明（`inputValidator` ≤500），空说明**不发** `X-File-Note`（服务端存 `null`）；**只有成功才 `contentStore.refresh()`**，失败时保留原列表与 `current`，仅在行内 `role="alert"` 说明「原版本未受影响，仍显示 V{n}」。
- **版本列表**：按服务端顺序列出全部版本（含失败/待解析），显示版本号、`current` 标记、解析状态、大小/上传人/时间/更新说明；「下载」只在 `canDownload` 为真时渲染（否则显示文案「不可下载」）；「引用此版本」只在「可下载 **且** 解析成功」时渲染，失败版本永不进入新引用（AC-13 可追溯但不误导）。请求带世代号 + `(workspaceId, logicalFileId)` 双比对，切文件/关弹窗/切空间的晚到响应一律丢弃。
- **按版本引用**：`emit('reference', version)` → `useWorkspaceFile(toVersionFileReference(version))`，其中 `id = version.fileId`（不可变对象 id），因此历史 Run 可追溯到实际输入版本；默认「引用到对话」路径（最新展示版本）未改动。
- **测试（实现时）**：`pnpm test:m5:frontend` workbench **21 files / 224 passed**（基线 19/197）、admin 6/18；`pnpm typecheck`、`pnpm lint` 通过。实现代理做了 **15 项反证**（版本总数、文件名编码、空说明不发头部、归档门禁、viewer 门禁、失败版本可引用、下载 gating、引用用 `fileId`、个人空间零请求与「人为发一次请求」证明断言有牙齿、重试/空态/骨架、`current` 标注、失败不刷新、成功必刷新），削弱后逐条变红并还原。
- **未能验证（实现时）**：真实浏览器的 Esc/遮罩关闭、真实文件选择器与上传进度外观（本机 e2e 受 OIDC 允许来源限制）；上传 loading 无专门判别性用例（mock 即时 resolve，请求契约由客户端用例锁定）。
- **规格冲突的更正（实现代理提出，父代理核对后采纳）**：任务书原文要求「归档空间『引用此版本』仍可用」，与 design §2.7（「引用到对话」属归档必须隐藏的执行轨入口）及 3-T3 既有断言冲突；且归档不渲染 `ConversationStarter`，引用会落成空操作 + 「已带入新对话」的假成功提示。现实现为**归档同时隐藏上传与引用入口**，保留版本列表与历史版本下载，并加断言；任务书三处已按此更正。

**对抗性质量评审与修复（2026-09-12）**：

- **结论**：**PASS with required fixes**（1 × P1、3 × P2、3 × nit）。评审在 `/tmp` 副本中独立复现，未改动工作树；复核为干净的方面包括上传失败/成功的状态真实性（409/422/403 全部 `refresh=0`、无成功提示、行仍显示旧版本）、头部编码（`%`/`%25`/`+`/`&`/`#`/空格/引号/换行/NUL/emoji/中文/10k 全部可回解）、恶意列表数据（`canDownload:false` 无按钮且不可引用、越界状态文案、3 个 `current` 不崩、500 个版本 ~131ms 渲染）、引用路径、归档/个人空间门禁、焦点恢复与 `aria-label`。
- **P1（已修）切换逻辑文件残留上一个文件的版本**：宿主关闭对话框时仍保留 `logicalFileId`，组件实例被复用；`loadVersions` 不清空 `versions`，且骨架门是 `loading && !versions.length`，于是「关闭 A → 打开 B」会**把 A 的版本历史渲染在 B 的文件名之下**，行内「下载」还会用 A 的版本号请求 B（评审实测 `[["ws-team","w-B",7]]`）。修复：打开/切换/关闭时先递增世代号并清空 `versions`/`error`/`loading`，另在 `onBeforeUnmount` 作废在途请求。新增判别性用例（切文件后立即断言无 `V7`、且下载调用是 B 的 `logicalFileId` + 正确版本号），**反证**：还原为不清空即红。
- **P2（已修）关闭/卸载后仍弹失败提示**：世代号只看 seq/空间/文件，不看 `open` 与存活状态。修复同上一并解决（关闭即递增世代号 + 卸载钩子）。新增用例断言关闭后拒绝的请求既不写状态也不调 `notifyActionFailure`，**反证**：去掉清空/递增即红。
- **P2（已修）角色未知时仍渲染上传入口**：名册请求失败 → `currentUserRole` 为 `null`，而 `!== 'viewer'` 为真，于是给只读成员一个注定 403 的假入口并真的发出请求（评审实测 `VIEWER_UNKNOWN_POST calls=1`）。修复：**角色未知不给入口**（与 `WorkspaceInfoPanel` 对 `currentUserRole=null` 的既有「宁可漏开不可误开」口径一致）；读取轨的「版本」入口不受影响。新增用例，**反证**：还原判定即红。
- **P2（已修）更新说明截断可抛 `URIError`**：`trim().slice(0, 500)` 会把代理对劈开（`'a'*499 + '😀'`），或让恰好 500 长度的孤立半区通过校验，`encodeURIComponent` 随即抛 `URIError: URI malformed`。修复：新增 `clampFileNote`，按**码点**累加截断到 UTF-16 长度 ≤500，并剔除孤立代理半区。新增用例（三种边界 + 全程无孤立半区），**反证**：还原为 `slice(0,500)` 即红。
- **nit（已修）空版本徽标**：只有 `logicalFileId` 而没有 `versionNo` 时会渲染空白徽标；改为按格式化后的文案判空。新增用例，**反证**：还原判定即红。
- **nit（已修）对话框可访问名称不含文件名**：Element Plus 在传 `title` 时只写死 `aria-label='文件版本'`（`dialog.vue:75`），两个文件的版本弹窗对屏幕阅读器完全同名。修复：**不传 `title`**，改为把 `:id="titleId"` 放在同时包含「文件版本」与文件名的头部元素上，让 Element Plus 走 `aria-labelledby` 分支（`dialog.vue:76`）；两条既有/新增用例都断言可访问名称含文件名，**反证**：加回 `title` 即红。
- **nit（记录，不修）低对比度小字**：`#8b918c`/`#909691` 在白底约 3.0–3.2:1，低于 WCAG AA 4.5:1；这是**既有设计系统口径**（同色在仓库内有 10 处使用），本任务不单独改动色板，作为可访问性技术债记录。
- **潜在（记录，不修；非本任务 diff）**：服务端 `content-routes.ts` 对更新说明做 `decodeURIComponent(...).slice(0, 500)`，若上游送来 500 长度且以代理对开头的字符串，仍可能在服务端二次截断出孤立半区（PostgreSQL 会存成替换字符 U+FFFD）。本任务客户端修复后**已无法从员工端触发**；作为服务端小项记录，留给后续。
- **本轮回归**：`pnpm test:m5:frontend` workbench **21 files / 231 passed**、admin 6 files / 18 passed；`pnpm typecheck`、`pnpm lint`、`pnpm verify` 通过。

**规格符合性评审与修复（2026-09-12）**：

- **结论**：**符合**。10 项要求 + TW-07/AC-13/AC-14/AC-23 全部通过，最终树无阻断缺陷；评审用自己的探针独立复验了修复轮（含切文件残影、角色未知入口、空徽标、代理对截断），并确认实现者的 15 项反证所对应的行为。评审同时澄清一件事：它在 R0（修复前）独立发现的问题与质量评审重合，最终结论以 R1（修复后）为准。
- **F1（nit，已修）越界版本号渲染指数**：`Number.isInteger(1e21)` 为真，会渲染 `V1e+21`/`共 1e+21 个版本`；服务端 `version_no` 是 PostgreSQL integer（≤2147483647），真实后端不可达，但契约外的脏数据不该上屏。修复：改用 `Number.isSafeInteger` + 服务端 integer 上限（`isServerVersionNumber`）。新增边界用例（`1e21`/`MAX_SAFE_INTEGER+2`/`2147483648`/`0`/`-1`/`2.5`/`Infinity`/字符串，以及上界 `2147483647` 仍渲染），**反证**：还原为 `Number.isInteger` 即红。
- **F2（nit，已修）注释与实现不一致**：`canUploadFileVersions` 的 doc 仍写「角色未知时由服务端兜底拒绝」，与实现（未知即不给入口）矛盾。已改为与实现一致的说明。
- **F3（nit，记录不修）低对比度小字**：与质量评审同一项，属既有设计系统色板，作为可访问性技术债记录，本任务不改色板。
- **F4（nit，已修）焦点恢复用例可能空转**：原用例在关闭前从未把焦点移进弹窗，`activeElement` 一直是触发按钮，因此「恢复焦点」与「从未移动」无法区分。已在断言前显式 `close.element.focus()` 并先断言焦点确实在弹窗内。**如实记录一处反证结果**：随后削弱我们自己的 `watch(versionDialogOpen)` 焦点恢复，该用例**仍然通过**——因为 Element Plus 的 dialog focus trap 也会把焦点还给触发元素。也就是说这条用例验证的是**可观察行为**（AC-16 要求的正是行为），不能单独鉴别我们的 watch；我们的 watch 作为 EP 行为变化时的兜底保留。
- **F5（记录，服务端，超出本任务）**：与质量评审同一项（`content-routes.ts` 的 `slice(0,500)` 仍可能截出孤立代理半区），客户端修复后员工端已无法触发；本任务禁改后端，留给后续。
- **针对「父代理声称的每项修复削弱即变红」**：规格评审明确说明它没有重做逐条反证，只用自有探针独立证明 R1 行为；本记录中标注为「反证」的条目均由父代理在提交前实跑过（削弱→变红→还原），未跑到的（F4）已如实写明。
- **本轮回归**：`pnpm test:m5:frontend` workbench **21 files / 232 passed**、admin 6 files / 18 passed；`pnpm typecheck`、`pnpm lint`、`pnpm verify` 通过。
- **提交与 CI（2026-09-12）**：`6b7ee4b`（`feat(workbench-web),docs: TW-07 前端版本 UI（3-T9）`）已推送 `main`，CI `M6 quality gate`（run `34670359884`）通过。

## 3. 顺序与依赖

```
TW-06：T1（授权双轨）──> T2（归档/恢复 API）──> T3（前端体验）
                              │
                              └──> T4（集成验证与 CI）──> T5（文档收尾）  ✅ 已交付

TW-07：T6（迁移 0025 + 版本服务/路由 + 读/执行双轨 + 集成验证）  ✅ 已交付（后端；前端版本 UI 为后续）

TW-08：T7（迁移 0026 + 事件源写入点 + 动态/通知服务与路由 + 集成验证）  ✅ 已交付
       └──> T8（前端「最近动态」摘要与「查看全部」抽屉、未读与静音入口）  ✅ 已交付

TW-07 收尾：T9（前端版本 UI：版本显示 + 上传新版本 + 版本列表/历史版本下载 + 按版本引用）  ✅ 已交付
```

**批次 3 退出条件（方案 §7）**：归档恢复（3-T1…3-T5）、文件升级追溯（3-T6）、动态去重与收权（3-T7 + 3-T8）**均已通过**，批次 3 的退出条件成立。**TW-07 的前端版本 UI（3-T9）也已交付**，TW-07 至此端到端可用（上传新版本、版本列表含失败版本、历史版本下载、按版本引用）。

- T1 必须先做：T2 的归档写入一旦落地，读/执行口径必须已经分开，否则归档会立刻造成过收权（连只读都读不到）。
- 每个任务：实现（TDD 先红后绿）→ 规格符合性评审 → 质量评审 → 修复 → 复审，流程同 1A/1B。
- 3-T8 依赖的 6 条接口已由 3-T7 提供；3-T8 不改后端，只在前端消费（含归档读取轨与个人空间分支）。

## 4. 贯穿约束（违反即回退）

- **个人空间零改动（AC-23）**：双轨判断只作用于团队分支；个人空间接口、页面与授权路径保持现状。
- **不能以只读状态阻止紧急收权**：归档后仍必须能执行撤销访问、转交负责人等治理动作（执行轨的例外要显式列出并加测试）。
- **新增授权拒绝统一抛 `authorizationDenied(...)`**，不要依赖文案分类。
- **API 变更必须同步 OpenAPI 契约**并跑 `pnpm verify`；不得绕过 DSH 另建 Agent 执行逻辑（AGENTS.md）。
- **新增集成套件必须用 `createThrowawayDatabase()`**，不得直连共享库。
- `DSH_WORK_TEST_DATABASE_URL` 需显式传入（`.env` 未配置）：`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。
- 本机 `pnpm test:e2e` 因 OIDC 允许来源只含 `localhost` 而失败（非缺陷），CI 不受影响；详见 `team-workspace-batch-1b-tasks.md` §3.1。

## 5. 已知遗留（进入本批一并处理）

- `GET /workspaces` 的 `owner` 仍是创建者显示名且缺 `status`（3-T2 修）。
- 缺 `PATCH /workspaces/:id`（名称/说明保存，3-T3 依赖）。
- Agent「不可用」第三态与具体原因未落地；员工名册无 `department`（与批次 3 无直接依赖，可另立小任务）。
