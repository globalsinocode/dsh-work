# 团队工作空间实施交接文档（历史快照）

**归档说明：** 本文保留 2026-09-11 至 2026-09-12 期间的交接上下文，便于追溯阶段性判断与评审结论；不再作为当前事实入口。当前状态以 [现行方案](../../design/team-workspace-plan.md) 第 10 节和本目录 [归档索引](README.md) 为准。

**交接时间：** 2026-09-11  
**分支：** `main`（已推送至 `24774e6`：1A、1B 与批次 3 的 TW-06、TW-07、TW-08 后端均已合入；TW-08 前端 3-T8 未开始）  
**目的：** 供接手的其他 agent/会话从此状态继续。**批次 3（含 TW-07 前端版本 UI 3-T9）已全部交付并合入 `main`、CI 通过**；剩余开放事项见 §10 末与方案 §10（TW-09、发布部署、四账户人工验收等）。本文是当前进度的事实快照；产品语义以 `team-workspace-plan.md` 为准（该方案已于 2026-09-11 按产品决定收敛范围，见 §6.1；归档语义见 §7；批次 3 任务拆分见 §10 所指文档）。

## 1. 文档地图（必读顺序）

| 文档 | 角色 |
| --- | --- |
| `docs/design/team-workspace-plan.md` | 唯一方案入口：范围、TW-01~09 产品规则、权限矩阵、批次与退出条件、验收矩阵 AC-01~29 |
| `docs/design/team-workspace-design.md` | 批次 0 UI 增量设计（第 6 节已确认决策；2A／2B 章节已删除） |
| `docs/history/team-workspace/team-workspace-batch-1a-convergence.md` | 1A 四项技术收敛草案 + 已确认决策（授权来源模型、负责人约束、收权机制、Agent 允许范围） |
| `docs/history/team-workspace/team-workspace-batch-1b-tasks.md` | 1B 五任务拆分与现状核查；T2 已随范围收敛标记取消 |
| `docs/history/team-workspace/team-workspace-batch-3-tasks.md` | 批次 3（TW-06／TW-07／TW-08）任务拆分、事件源结论、交付记录与验收锚点 |

## 2. 进度快照

| 阶段 | 状态 | 关键提交 |
| --- | --- | --- |
| 批次 0 设计收敛 | ✅ 完成、已确认 | `feae774` |
| 1A-T1 数据库迁移 | ✅ 双评审通过 | `aebab9f` 迁移、`c3dfb70` 修复 |
| 1A-T2 授权层 | ✅ 双评审通过 | `a39a560`、`aaf10e9` 修复 |
| 1A-T3 员工成员 API | ✅ 双评审通过 | `35b9fc2`、`b5ca093` 修复 |
| 1A-T4 Agent 成员 API | ✅ 双评审通过 | `eb28e47`、`3f897f1` 契约修复 |
| **1A-T5 收权链路** | ✅ **实现完成、两级评审已修**：`f45686b` + `8a95574`/`94d1ddd` + 评审修复；`pnpm test:m5:revocation:integration` **21/21 且连续多次稳定**，`test:m5:revocation`（分类器单测）接入 `ci:check` | `f45686b`、`8a95574`、`94d1ddd`、`b20a675`、`912497c`、`279e540`、`97b7c5e` |
| **1A-T6 前端成员管理** | ✅ **实现完成、规格评审已修**：`a2a83ed`..`f16fb8c` 六个提交 + 对接修复 `462bfbb`/`dddc794`；`pnpm test:m5:frontend` **workbench 85 / admin 18 全绿** | `a2a83ed`、`2558908`、`db2e016`、`5f9cb67`、`1f2c226`、`f16fb8c`、`462bfbb`、`dddc794` |
| **1A-T7 对账清单与迁移验证** | ✅ **实现完成、规格符合性 + 质量评审已修**：6 个提交 + 锁序/基线修复；reconciliation 8/8、upgrade 4/4、migration 10/10 | `09800d0`、`73578d6`、`27507bb`、`1fab46a`、`272fd10`、`2a09842`、`769fad9`、`a85b703` |
| 1A 合并与 CI 接入 | ✅ `main` 已含 1A 并推送；6 个团队集成套件接入 CI 门禁，`M6 quality gate` 通过 | `bf9d58c`、`7d49c74`、`55da0d7` |
| 测试基础设施 | ✅ 全部 **24 个**集成套件改为一次性库（`test-database.ts` 的 `createThrowawayDatabase()`），消除共享库污染 | `c97db7b` |
| **1B 团队资料与本人对话** | ✅ **已交付**：T1（Session 分页）、T3（共享文件下载/搜索/逻辑移除）、T4（文件与结果读取收权）、T5（可见统计性能基线）全部完成；T2 随 2A／2B 取消；真实 DSH 双账户端到端跑通一次 | `dfeb1f1`、`c196c82`、`963bf61` 等 |
| 2A / 2B | ❌ **已放弃** | 产品确认取消，不再交付 |
| **TW-06 归档语义与生命周期（批次 3 第一部分）** | ✅ **已交付并合入 main**：3-T1 授权双轨 → 3-T2 归档/恢复 API → 3-T3 前端归档体验 → 3-T4 集成验证与真实 DSH e2e → 3-T5 文档收尾 | `58514a2`、`46fecb0`、`befb7c9`、`5058f73` |
| **TW-07 文件更新与版本（批次 3 第二部分）** | ✅ **后端已交付并合入 main**（3-T6）：迁移 0025 逻辑文件/版本、新版本上传、历史版本下载与追溯、读/执行双轨；`test:m5:file-versions:integration` 18 用例。前端版本 UI 未做 | `624acc4` |
| **TW-08 团队动态与通知（批次 3 第三部分）** | ✅ **后端已交付**（3-T7，两轮评审已修）：迁移 0026、事件写入点、动态/通知读取路由、`test:m5:activity:integration` 21 用例；前端（3-T8）✅ 已完成（两轮评审已修） | `24774e6`（CI `34666778699` ✅） |
| TW-09 空间用量（批次 4） | ✅ **已交付**：只做空间用量（4-T1 后端 / 4-T2 前端，各两轮评审已修），其余四项产品决定不做 | 拆分/交付记录 `team-workspace-batch-4-tasks.md`；现状核查 `team-workspace-tw09-survey.md` |
| 遗留清理与工程卫生（批次 5） | ✅ **已交付**：Agent「不可用」第三态与原因、员工名册 `department`、迁移 `0028`（活动 run 部分索引 + 用量每 attempt 唯一索引）、授权服务 403 类裸 Error 类型化（15 处行为不变 + 4 处误分类修为 403）、Playwright 本机解锁、前端测试超时；两轮评审（规格「有条件符合」+ 质量「PASS with required fixes」）的 14 项记录/提交卫生发现已全部修正 | `team-workspace-cleanup-tasks.md` |

**T6/T7 评审结论与关键技术结论（2026-09-10）：**

- **T6 规格评审：有条件符合 → 已修。** 核心发现：实现者把「员工成员管理不可用」归因为后端缺口，但事实是 **`GET /workspaces/:id/members` 在 T3 就不存在**（我核实：`workspace-member-routes.ts` 有候选/增/改/删/退出/转交，**无读取名册**）。我补齐了 `listMembers`（返回名册 + 调用者 `currentUserRole`）+ 契约 + client 方法（`462bfbb`），并把视图接线到该接口、以服务端角色取代按「创建者姓名」推断（`dddc794`）——转交负责人后新负责人不再失去写入口。AC-23 由评审代理**独立**对 10 个团队 API 下 spy 验证通过。
- **T7 规格评审：符合；质量评审：有条件合入 → 已修。** 实证缺陷 D1：`reconcile` 与 Agent 移出**锁序相反**（来源行→workspace 行 vs workspace 行→来源行），PostgreSQL 报 `deadlock detected`；已统一为「先 workspace、后来源」并加并发回归测试（`769fad9`）。D2 取消对账误报错误、D3 基线检查未按表限定（同名对象可误通过）已修（`a85b703`）。
- **AC-27 独立验证**（评审代理自建场景）：运行完整迁移链后删除 `one_personal_workspace_per_user` 再重跑 → 0022 被中止且 `schema_migrations` 无 0022/0023 记录，无半升级。
- **0013 触发器 personal→team 不校验旧空间**：确认为真实缺口，本批次按 plan 6.4「不得改写个人空间保护触发器」只记录决策、不修（见 `0022`/convergence §5），后续批次用独立迁移扩展。

**合并前外部审查（main...feat/team-workspace）修复记录（2026-09-10）：**
审查基线为 `main(404f885)...feat/team-workspace(3b335e5)`，结论「不建议合并，权限闭环与普通成员入口有缺口」。六项已全部修复并各有回归测试（提交 `92ace62`、`b2d50f4`、`20121ca`、`5b5ccd3`）：
1. **P1 收权只覆盖 SSE，REST 读取仍可读。** 被移出成员的 `GET /runs/:runId` 仍 200 返回正文、`/tasks` 仍列出该运行。两个路由接入与 SSE 同一口径（不依赖成员身份判定空间类型 + `authorizeTeamReadAccess`）：详情 404、列表剔除；个人/standalone 不受影响（AC-23）。
2. **P1 执行鉴权未独立校验 Agent 成员可用性。** 对账把 legacy 来源改写为 `manual` 后，停用成员不会撤销该 grant，`authorizeTeamRunExecution` 仍放行，既有会话可续写/重试。新增按 `agent_version_id` 的成员可用性校验；无关联的升级前固定版本授权保持可用。
3. **P1 普通成员没有可达的 Agent 选择入口。** `presetAgentMember` 只能从仅负责人/管理员可见的成员弹窗设置，右栏 Agent 条目不可点 → 普通成员提交时关联 ID 为 `undefined` 被后端拒绝。右栏可用 Agent 条目现提供「开始对话」并对所有成员可用；同时在未选中可用 Agent 时于输入区阻止提交并给出引导（`requiresAgentMember` 仅团队为真，个人路径不变）。
4. **P1 空间锁内未复核操作人角色。** 负责人检查在事务外，转交并发提交后旧负责人仍能写入成员与授权。新增在持有 workspace 行锁的事务内复核（add/disable/enable/upgrade/remove 五处）。
5. **P2 加入接口未复核 Agent 角色可见范围。** 候选查询按 `visible_role_ids` 过滤只是展示，直接提交 ID 仍返回 201。写入前按添加人当前角色复核（`assertAgentVersionVisibleToRoles`）。
6. **P2 并发对账测试假设对账先获锁。** `Promise.all` 不保证顺序：移出先持锁时门禁返回 409 是正确行为。改为接受两种顺序（移出被 409 后在对账完成时重试），仍断言不得死锁。

**第二轮外部复审（`3b335e5..3ff26b2`）修复记录（2026-09-10）：** 复审仍判「不建议合并」，报 5 项（3×P1、2×P2），已全部修复并有回归测试（提交 `5541b58`、`f6223eb`、`c9a017f`）：
1. **P1 升级后旧版本会话漏检成员状态。** 原先按成员**当前** `agent_version_id` 匹配：Agent v1→v2 升级后成员行指向 v2，v1 会话查不到关联被当作「升级前无关联」放行。改为通过**版本所属 Agent** 定位成员，再校验状态（成员可用时旧版本仍可执行）。
2. **P1 新增授权拒绝未接入撤权分类器（与上一条同源）。** 新错误不匹配 `isAuthorizationDenial` 的文案列表：重复停用（事件被去重、走修订号清扫）时被当作基础设施故障，运行未被取消，且修订号被记为已处理。根因是「按中文文案判定授权结果」；已引入类型化 `AuthorizationDeniedError`（status 403），路由按类型映射 403，清扫器按类型识别。**后续新增授权拒绝应抛 `authorizationDenied(...)`，不要再依赖文案。**
3. **P1 取消接口仍可绕过读取限制。** `POST /runs/:runId/cancel`（与 `retry`）返回完整正文，被移出成员可借其读回回答。二者现应用与详情/列表相同的团队读取校验（不通过则 404）。
4. **P2 新入口忽略只读成员允许动作。** 右栏「开始对话」原先只判断 `available`，导致服务端 `allowedActions=[]` 的 viewer 也看到入口并能解除输入区限制。现按 `allowedActions` 含 `start_conversation` 渲染，`ConversationStarter` 的阻止逻辑也改为由该集合驱动（入口、选择、提交三处一致）。
5. **P2 可见范围拒绝被映射为 500。** 越权加入已能拒绝，但普通 `Error` 文案不匹配路由权限分类 → HTTP 500。类型化错误修复后为 403 `permission_denied`，并补了 POST 接口断言。

**已确认的两处设计口径（外部复审确认，勿改）：**
- **类型化授权错误**：新增授权拒绝统一抛 `authorizationDenied(...)`（`AuthorizationDeniedError`，status 403），同时满足撤权清扫器识别与 HTTP 403 映射。**本轮只迁移新增的两处**；旧文案列表 (`LEGACY_DENIAL_MESSAGES`) 作为回退保留，属后续技术债，不要求本轮全量迁移。
- **可见范围按平台角色判定**：加入 Agent 成员必须**同时**满足「空间负责人」（`requireActorRole`，且在 workspace 行锁内复核）与「平台角色符合该 Agent 的 `visible_role_ids`」（`identity.roleIds`）。两者职责不同，**不要**把可见范围改成按空间员工角色判定：
  - 平台角色决定「该员工是否获准使用/加入这个 Agent」；
  - 空间角色决定「该员工能否管理当前空间的 Agent 成员」。
  这保证候选查询（同样按 `sessionAuthorizationContext(identity).roleIds` 过滤）与提交校验口径一致。

**T6/T7 已知遗留（不阻断 1A 退出条件）：**
- Agent「不可用」第三态与具体原因未落地：服务端 `AgentMemberRecord` 不返回 `unavailableReason`，前端红点与 tooltip 因此永不显示（design §2.6）。需服务端补原因码，属后续小任务。
- `GET /workspaces` 的 `owner` 仍是**创建者**显示名（非当前 owner）、缺 `status`，故右栏负责人展示与归档态在契约补齐前不准确。
- 员工名册未返回 `department`（design §2.6 期望「姓名+部门」）；`PATCH /workspaces/:id`（名称/说明更新）缺失，设置弹窗保存只提示未提交、不伪造成功。
- 平台级「停用工具」未加对账门禁（T7 决策：属平台治理，1A 唯一破坏性路径是 agent_member 撤销）。

## 3. T5 收权链路（实现完成、两级评审已修）

`f45686b` 是被打断的实现代理留下的 WIP，含：`run-revocation-sweep.ts`（新）、`systemCancelRun`、`cancelCause='system_revoke'`（runtime adapter + types）、execute 前复核、SSE 团队分支逐批写出检查、新测试文件 `m5-revocation-pipeline.integration.test.ts`。

**验收状态（2026-09-10）：** `pnpm test:m5:revocation:integration` **18/18 通过且连续 10 次稳定**；`typecheck` / `pnpm verify` / `pnpm lint` 通过。规格符合性与对抗性质量评审各一轮，发现项均已修或有明确排期。

WIP 首次运行是 **16 个用例 8 失败**，修复分两类：

**产品缺陷（均已修 + 有回归测试）：**
1. **幽灵态 running 永久卡死。** 调度器 `claimAttempt` 在调用 Runtime **之前**就把 `runs.status` 置为 `running`，而 Runtime 适配器此时还没有执行记录。撤权落在该窗口时 `runtime.cancel` 返回 `accepted:false`，旧 `systemCancelRun` 只处理 `queued` 分支，run 永久停在 `running`。修复：`queued`/`running`/`cancel_requested` 三态统一走 `convergeCancelledRun` 库内收敛。
2. **`cancel_requested` 无收敛兜底（质量评审 D3）。** 该状态非终态，但适配器对二次取消返回 `accepted:true`，一旦终结事件丢失就永久滞留。已并入上面的收敛集合。
3. **事件序列双写者竞态（规格+质量评审一致定位，flaky ~40%）。** 适配器按自身计数器定 `sequence`，系统说明事件按 `max(sequence)+1` 定，两者撞 `run_events_tenant_id_attempt_id_sequence_key`；写入失败会连带丢失该事件的状态迁移副作用（`run.cancelled`/`run.completed` 不生效）。修复：`appendEvent` 冲突时**重算**序列重试，`appendSystemEvent` 同样重试；二者共享 `isSequenceConflict`（限定 23505 + 具体约束名）。
4. **系统说明事件被运行时事件静默吞掉（质量评审 D4）。** 去重键为 `(attempt_id, event_type)` 时，适配器先写的 `run.failed` 会让授权撤销说明被丢弃。修复：去重额外限定系统作者前缀 `id like 'event-system-%'`。
5. **复核异常一律当作「授权已撤销」（质量评审 D2，高危）。** `sweepWorkspaceActiveRuns` 吞掉任何异常并取消该空间**全部**在途运行——一次 DB 抖动即造成 AC-26 所防的误删。修复：新增 `isAuthorizationDenial` 只对可分类的授权拒绝取消；基础设施故障记日志并放行（执行前复核与下一轮修订变更仍会兜底）。
6. **SSE 建连降级绕过（规格评审 GAP-1，高危，已实证）。** 建连用成员相关的 `resolveWorkspaceType` 判定团队分支，被移出成员重连解析为 `null` → 退化为无逐批拦截的个人路径并继续交付内容。修复：改用不依赖成员身份的 `workspaceTypeOf`，非成员 fail-closed 403（显式包装为权限错误，不依赖错误消息分类）。有专测：先移除再建连，去掉修复即失败。
7. **`executeClaimed` 终态守卫。** 复核通过后、`runtime.execute` 前再确认状态，被撤权取消的 run 不得进入 Runtime（AC-09「取消与完成」竞态）。

**测试夹具缺陷（9 处，均为夹具与产品语义不一致，非产品缺陷）：**
- 两处「成员已移除 / Agent 已停用」只在事件表插了行、没有真正改业务状态，被 `isRevocationEffective` 当前状态门（正确地）跳过；须真调 `members.removeMember` / 置 `disabled`（并移除与事件去重键冲突的手工插入）。
- 一处对照空间的 run 请求人不是该空间成员，修订号全量复核会以「非成员」正确取消它，掩盖跨空间隔离断言。
- 一处 run 先于其 session 插入，违反 `runs_tenant_id_session_id_fkey`。
- 一处重复插入个人空间：`0013` 的 `users_personal_workspace_provisioning` 触发器已在插入 users 时自动创建，夹具应复用而非再插。
- 调度容量：`claimAttempt` 按 runtime 全局统计 `status='running'` 的 attempt，多个用例直接落库 `running` 夹具会跨用例耗尽默认容量 2。测试运行时容量提升到 32。
- 两处 SSE 竞态用例在流启动前就落库了「撤权后」的事件，首轮即全量交付、竞态窗口根本不存在；改为在竞态点之后才写入事件。
- 一处复核失败断言在 run 置 `failed` 后立即读说明事件，而说明事件是随后写入的；改为等待事件落库。

**两条硬约束的落地证据：**
- 事件去重 + 当前状态门：`isRevocationEffective` 逐事件复核当前授权状态；`team_auth_revision` 变更触发全空间复核兜底。`team_auth_revision` 全仓只有 `+1` 自增（不可能回退，重启重放安全）。Agent 事件此前把操作人写进 payload/`user_id`，导致重复生命周期产生多行、违反去重语义，已改为只由被撤销对象决定。
- 个人空间零改动：`recheckExecutionAuthorization` 在 `workspaceType !== 'team'` 时早退；`streamRunEvents` 的 `teamAccess` 可选，路由只在团队分支传入；授权层 workspace capabilities 仅在 `workspaceType === 'team'` 时校验；用户 `cancel()` 逐字未改。

**已知遗留（评审记录，非 T5 阻断项，转 T7 或后续批次）：**
- ~~清扫器错误处理无 attempts 上限/死信（D7）~~ **已修**：迁移 `0023` 增加终态 `dead_letter` + `last_error`，`MAX_EVENT_ATTEMPTS=20`（约 40s）后单语句升级，有回归测试。
- `readWorkspacesNeedingSweep` 的 pending 事件不限空间状态，归档/非 active 空间的 pending 事件无归宿（D8）。
- 清扫器 `close()` 不 await 在飞清扫，关闭序列有竞态噪声（D9）。
- 三个 `listActiveRuns*` 查询缺少 `(tenant_id, status)` 起始索引，修订号变更时是 O(active runs × 查询数)（D10）。
- ~~`teamReadAccessCache` 只写不淘汰（D5）~~ **已修**：超阈值清理 TTL 过期项并硬性封顶；缓存键已加租户维度（D6 已缓解）。
- `failRunForRevokedAuthorization` 先置 `failed`、后写说明事件，二者之间事件不可见（产品可接受，测试已等待）。
- `isAuthorizationDenial` 仍按 15 条错误文案子串判定（授权服务抛普通 Error）；已加单测锁定契约（`test:m5:revocation`），后续若引入类型化错误码应替换。

## 4. T6 前端成员管理（已完成，见 §2 与 §3 评审结论）

- 依据 `team-workspace-design.md` §2.5/2.6/2.7：成员管理弹窗（员工/Agent 同屏分段、角色下拉、添加员工搜索、添加 Agent 确认流）、`WorkspaceInfoPanel` 团队分支（员工+Agent 分区、「管理成员」入口、「空间设置」入口）、`ConversationStarter` 预选 Agent（团队分支）。
- 后端 API 已就绪（T3/T4），API client 方法已同步（`client.ts`/`domain.ts`），只需做 UI + store + 前端测试（`pnpm test:m5:frontend`）。
- 空间设置弹窗中「归档」行为属批次 3，1A 只做入口或不做（按设计文档 2.7 的批次标注）。

## 5. T7 对账清单与迁移验证（已完成，见 §2 与 §3 评审结论）

- admin 运营端 legacy 授权来源对账清单（`admin/operations-routes.ts` 现有 `GET /workspaces` 基础）+ 对账完成前阻止破坏性调整。
- `agents.allow_workspace_join` 的 admin 治理开关（T4 迁移注释写明"no API yet"，此任务补）。
- 迁移集成验证：全新安装/升级/重跑/回滚（AC-17/AC-27 口径）。
- 遗留观察：0013 触发器对 personal→team 移动不校验旧空间（评审已记录，可在此任务一并修或记录决策）。

## 6. 1B 团队资料与本人对话（进行中）

### 6.1 范围决策（2026-09-11，产品确认）

**放弃 2A（共享与派生基础）与 2B（团队成果沉淀）。** 连带影响：

- 不再交付：对话分享快照、同团队派生、来源撤回传播与依赖失效、团队成果发布／撤回／下架。
- **`scope` 参数整体移除**：`GET /workspaces/:workspaceId/sessions` 固定按 `sessions.created_by = actorUserId` 过滤本人会话，前端不再传递范围参数，也不渲染「我的对话／团队共享」筛选；空态由三种收敛为两种（本人空态 + 筛选无结果）。
- **批次 1B 的 T2「来源限制采集」取消**：它此前只是 2A／2B 的前置，不再有意义。
- **代价（必须如实记录）**：来源失权后，已生成并交付的答案仍对其作者可读可导出；平台不再记录「某次运行读过哪些文件／知识／工具返回」。真实 DSH 实测已确认 B 的会话可读入 A 上传的文件内容，而平台当前无专门来源记录。若将来需要追溯来源，必须重新立项，且**无法补记已发生运行的来源事实**。

方案侧已同步：`team-workspace-plan.md` §7 删除 2A／2B 批次行、§9.1 新增「内容分享、派生与成果发布｜已放弃」、删除 AC-11／AC-12／AC-24、§6.2／§6.3／§6.5／§6.6 收敛；`team-workspace-design.md` 删除 §2.4／§2.8；1B 任务文档将 T2 标记取消。

**范围（方案 §7 批次 1B，已收敛）**：TW-03 本人历史列表、TW-05 共享文件、团队 Session 分页、文件／SSE 收权、可见统计性能基线。**依赖 1A 的授权与撤权机制（已交付）**。

**任务状态**：T1（本人历史列表）、T3（共享文件）、**T4（文件与结果读取收权）**、**T5（可见统计性能基线）已交付**；**T2 已取消**。1B 四个任务至此全部完成。

**退出条件（方案 §7，已收敛）**：A 上传不可变文件，B 引用完成真实 DSH 对话并能继续；AC-09 收权通过，个人空间回归不变。

### 6.2 T4 交付记录与遗留（2026-09-11）

**实测缺口**（推翻了原任务描述里的「文件侧已随 T3 落地」）：`readFile` 的「会话作者」SQL 分支不校验团队身份，`artifactFileId`／`listArtifacts` 只按 `sessions.created_by` 授权 —— 被移出或主动退出的成员仍能下载本人团队会话文件与团队成果。

**修复**：抽出共享门禁 `canReadWorkspaceObject`（`server/src/modules/authorization/authorization-errors.ts`），文件、成果、运行/结果、SSE 建连共用同一口径；新增拒绝改抛 `authorizationDenied(...)`（不再依赖路由中文文案分类）。

**评审共发现并已修六处（第一轮 3 + 复审 3）**：
1. 归档空间 fail-closed（旧口径 null 即放行，实测归档后仍交出 Run 正文）。**新连接**不依赖授权缓存 TTL；
    **已建立的 SSE 流**原先仍受逐批门禁的 10s 缓存 TTL 限制（归档不提升 `team_auth_revision`），
    `hasStreamAccess` 已改用 `canReadWorkspaceObject`（每批重新解析空间类型），归档立即终止在流。
2. `readFile` 工作区分支补 `session_id is null`，他人私有会话附件不再对空间成员开放（AC-10）；
3. `listArtifacts` 改为按空间去重后复核一次，消掉逐行门禁的 N+1（评审实测 200 条：改前个人 201 次、团队冷启动 ~1001 次；改后个人 1 次、团队冷 7 次／热 3 次）；
4. **Run 输入挂载**（`prepareRuntimeFiles`）：此前成员 B 可把成员 A 的私有会话附件挂进自己的 Run 交给 DSH 读取，绕过 `readFile` 的同一条限制（复审 P1）。现只允许「本会话附件 + 本人其它会话附件 + 空间共享文件（`session_id is null`）」，**本人跨会话挂载的既有行为保持不变**（复审指出的 AC-23 收窄已修回）；
5. **SSE `GET /runs/:runId/events`** 归档后不再降级为无拦截路径（旧代码仅在 `workspaceType === 'team'` 时加门禁，归档返回 null 即跳过，实测 200 且交付正文）；
6. 执行前复核 `recheckExecutionAuthorization` 对 null 类型改为拒绝，归档后排队中的团队运行不再进入 Runtime；无 workspace 的独立运行在类型解析之前显式放行，保持 AC-23 语义。
7. `GET /artifacts` 列表对「空间行缺失」（left join 为 null）也 fail-closed，不因「非团队」而放行。

测试：`test:m5:shared-files:integration` 11/11、`test:m5:revocation:integration` 28/28；全部 **24** 个集成套件（169 用例）与 `pnpm verify`／`lint`／`typecheck`／`build` 通过。

**已知未覆盖（记录，不阻断）**：`recheckExecutionAuthorization` 的 null/standalone 分支无针对性集成用例（评审以 stub 分支探针 + 真实库端到端验证过，当前因 `sessions.workspace_id` 非空而不可达）；`prepareRuntimeFiles` 的「本会话附件」分支未额外校验空间活跃/成员（端到端由 `authorizeRuntime` 与执行前复核兜住，纵深防御留待后续）；Run 输入挂载的失败仍是普通 Error（文案映射 403），未改为类型化拒绝。

**本地 e2e 环境限制（非缺陷）**：`pnpm test:e2e` 在本机失败，原因是 Playwright 访问 `127.0.0.1:4174` 而 OIDC 允许来源只有 `http://localhost:4174`（`AI_HUB_WORKBENCH_PORTAL_URL`），登录跳转被 421 拒绝；在干净 HEAD 检出上同样复现，改用允许来源即可通过。CI 不受影响。

### 6.3 T5 交付记录（2026-09-11）

**交付物**：`docs/history/team-workspace-1b-statistics.md`（由 `scripts/bench/team-workspace-statistics.ts` 在一次性库上生成，入口 `pnpm bench:team-workspace-statistics`）+ `docs/history/team-workspace-1b-statistics-findings.md`（口径、结论与待办）。

**口径**：计数单位是 **SQL 语句数**（postgres.js `debug` 每语句一次；`prepare: false` 下带参语句约两次线级往返），连接池 `pg_type` 探测已排除；测量层次是服务层，不含路由层 `authorizeWorkbench` 与序列化。

**结论**：会话列表 1 条语句（首页／深翻页／搜索同量级）、文件列表 3 条（与行数无关）；**成果列表 N+1 修复成立** —— 同批 200 条成果上，当前「按空间去重复核」6 冷 / 3 热 vs 候选「逐行门禁」404（对照实现已写入工具，可复跑）。**待优化**：`listWorkspaces` 每可见空间 2 条语句，实测 `2 × 可见空间数 + 4`（N=3/5/8/12 → 12/16/22/30），6 空间热路径 p50 ≈ 27ms；候选修法（主查询内单次聚合）已出证未实施。另记录主聚合中间结果规模（8656 行 / shared hit 17919）与「计数断言无法保护该退化」的原因，并注明放大来自连接乘积而非缺连接条件。10 路并发 59 条语句、p50 约 60ms，无错误。

**方法论修订**：首版基线经独立验证后修正了七处（单位误标为往返、池探测污染冷启动与并发、T4 对比不可复跑、未披露路由层成本、公式把 N 当可见空间数、文档间数字不一致、计划 SQL 与实现不等价），全部已修并重测，明细见 findings §7。

**归档语义已定（2026-09-11 产品确认）：只读保留。** 归档后现任成员仍可按权限查看会话、文件、成果与历史运行并下载；新对话、续写、重试、上传、成员与 Agent 变更、设置修改一律拒绝；失权成员仍拒绝；归档空间仍允许必要的访问撤销与负责人治理。

因此 1B-T4 当时「归档一律拒绝」的统一是**过渡口径**，批次 3 的 3-T1 会把它拆成读取轨（允许归档 + 现任成员）与执行轨（要求活动状态）。已落笔：方案 §6.4 末条与 §6.5 第 8 条、设计 §2.7，以及新的批次 3 任务拆分 `team-workspace-batch-3-tasks.md`（T1 授权双轨 → T2 归档/恢复 API → T3 前端 → T4 集成验证 → T5 文档收尾）。

**实现要点（设计 §2.2 / §2.3 + 方案 §6.2 / §6.3 / §6.6）**：
- 员工端对话页签「新对话／历史对话」segmented 切换，写入 `?view=history`，历史视图替换 Starter：标题搜索 + 游标分页（「加载更多」／「已加载全部」）、行含状态点/标题/发起人/最近活动/最新运行状态、整行进入 `/conversations/:runId`（服务端解析到 Session，兼容 Run ID 链接）。**历史列表固定为本人范围，服务端强制过滤，前端不传范围参数（`scope` 已移除）。**
- 团队 Session 分页服务端接口：按 Session 去重、稳定排序（最近活动倒序，keyset 游标 `(last_active_at, id)`）、按授权结果汇总分页与计数；新增必要索引与摘要投影（方案 §6.3「Session 查询」）。公共分页游标必须用原始 ISO 时间，不要用展示格式（曾因此导致第二页恒空，`dfeb1f1`）。
- 共享文件页签：名称搜索、状态映射（上传中/处理中/可引用/失败+原因）、操作区「引用到对话 + 下载 + 更多（移除）」、权限（只读成员不渲染上传与移除；成员仅对自己上传的显示移除）。**「上传新版本」属 TW-07（P1），本批不渲染。**
- 文件与 SSE 收权按 1A 已有机制扩展：文件下载、结果读取与已建立订阅在失权后拒绝（AC-09 口径）。
- 可见统计性能基线（方案 §6.6）：多成员、多会话、单会话 >50 Run、共享文件与成员数据的基线，记录查询计划、延迟分位数、数据量与并发。

**承接 1A 的硬约束**：
- **个人空间零改动（AC-23）** 仍是红线：团队分页/收权只在团队分支生效，个人空间接口与页面行为保持现状；`scope` 移除后仍不得改变个人空间查询入口。
- 新增集成套件必须用 `createThrowawayDatabase()`（见 §7），不要直连共享库。
- 新增/修改 API 必须同步 OpenAPI 契约并跑 `pnpm verify`；新增授权拒绝统一抛 `authorizationDenied(...)`（勿再依赖文案分类）。

**1A 遗留中与本批相关的项**：`GET /workspaces` 的 `owner` 仍是创建者显示名且缺 `status`（历史列表「发起人/负责人」展示口径、归档筛选依赖它）；员工名册无 `department`；Agent「不可用」第三态与原因。

**1B 已落地的两个小修（记录备查）**：`scripts/runtime/team-workspace-e2e.ts` 曾把 `operations` 传成 `undefined`（`?.` 静默跳过）导致工具审计为空，现已接真实 `PostgresOperationsService`；`pnpm probe:*` 曾因未加载 `.env` 报 `DSH runtime version mismatch`，已加 `--env-file-if-exists=.env`（`c196c82`）。

### 6.4 3-T1 交付记录（2026-09-11，归档读/执行双轨）

**交付**：`status='active'` 这一个判断拆成两条显式口径，实现位置集中在 `postgres-authorization-service.ts`、`authorization-errors.ts`、`postgres-workspace-service.ts`、`postgres-content-service.ts`、`postgres-workspace-member-service.ts` 与两个 workbench 路由文件。

- **执行轨（默认，保持原语义）**：`workspaceTypeOf`、`requireTeamRole`（默认 `purpose: 'execution'`）、`requireWorkspaceMembership`（默认 `allowArchived=false`）、`resolveAccessibleWorkspace` 仍只认 active；新对话、续写、重试、上传、成员/Agent 变更、退出在归档空间一律拒绝。执行前复核与排队领取继续走这条轨。
- **读取轨（新增，逐调用点显式opt-in）**：`readableWorkspaceTypeOf`（active+archived）、`requireTeamRole(..., { purpose: 'read' })`、`authorizeTeamReadAccess(..., { allowArchived: true })`、`resolveReadableWorkspace`。共享读门禁 `canReadWorkspaceObject` 改用前者：归档 + 现任成员可读文件/成果/历史运行/会话列表与 SSE；被移出成员、非成员与不存在空间仍按不可枚举「不可访问」拒绝。
- **治理例外（显式列出）**：归档空间仍可执行**撤销访问**（`DELETE /members/:userId`）与**负责人转交**（`POST /owner-transfer`），成员服务的 `assertTeamWorkspace` 新增 `allowArchived` 按调用点传入；新增成员、角色调整、主动退出、候选人查询仍拒绝。
- **缓存键与状态轨**：`authorizeTeamReadAccess` 的缓存键追加状态轨后缀（`archived`/`active`），且**修订号查询本身按轨过滤 status**——否则归档前预热的 active 缓存会在归档后继续放行默认（执行）轨，使「省略参数即保持执行语义」失效。`ttlMs` 改为 `options.ttlMs`，由共享读门禁从 `TeamStreamAccess.ttlMs` 透传（SSE 逐批复核间隔）。
- **测试**：`team-workspace-authorization` 17/17、`team-workspace-sessions-api` 6/6、`team-workspace-shared-files-api` 15/15、`workspace-member-api` 36/36、`m5-revocation-pipeline` 29/29。旧断言「归档对 owner 也一律拒绝」按新语义改写为「执行轨仍拒绝 + 读取轨对现任成员放行」；1B-T4 的三条「归档 fail-closed」回归断言（已建立 SSE、SSE 建连、REST 详情/列表）同样改写为读取轨放行，收权（移出成员）仍会立即终止流。个人空间在团队会话接口的状态码由 422 改为 403（统一为「非团队资源」口径，功能未变）。
- **名册轨道（已定）**：`GET /members` 与 `GET /agent-members` 属**读取轨**（归档详情右栏需展示成员与 Agent 身份）；`GET /member-candidates` 与 `GET /agent-candidates` 保持**执行轨**（归档不允许新增成员，不暴露候选）。为此两个服务的 `listMembers`/`listAgentMembers` 也传 `assertTeamWorkspace(..., { allowArchived: true })`。
- **会话删除（已定）**：`DELETE /sessions/:sessionId` 属执行轨，归档空间拒绝（删除会销毁只读保留的历史内容）；`POST /runs/:runId/cancel` 仍允许（在途收敛，且 3-T2 才会做「运行中禁止归档」）。
- **修复轮验证（2026-09-11）**：独立验证确认 8 项修复功能全部成立、无功能/安全回归（真实 HTTP 探针逐项复核了状态码与文案）。同时抓出**两个回归断言不具鉴别力**并已修：① 归档 `removable` 的断言原先用「普通成员看他人上传的文件」，即使归档判断被删也照样通过——改用**本有权移除的视角**（负责人）断言；② 缓存状态轨的修复**完全没有测试守护**（把修订号查询改回状态无关，团队授权套件仍 17/17 全绿，但探针能复现归档后被预热缓存放行）——已补「先预热读取轨 → 归档 → 默认执行轨必须拒绝」的判别性用例，并反证（削弱实现即变红）。另修三处文档/分类问题：AC-23 的个人空间例外原先写成「团队专用接口统一 403」，实际只有团队会话分页改了（其余仍 422）；OpenAPI `/files` 描述重复了同一句；身份校验拒绝在 `identity/session-repository.ts` 仍有一处纯 Error（映射 404），已类型化为 403。
- **符合性评审修复（2026-09-11）**：① `GET /workspaces/:id/files` 路由闸门原在执行轨，归档现任成员被 403、服务层读轨不可达——已改为同轨，并补 HTTP 级用例（服务层直调测试曾给假绿）；② `POST /sessions/:sessionId/files` 不校验 workspace 状态，归档空间上传返回 201——已补 `requireActiveWorkspace`；③ 团队会话接口对「不存在空间」返回 422、存在空间 403，可枚举——已统一为同一 typed 拒绝，并把不变量（活跃/归档/不存在三者同状态码）固化进测试；④ 身份校验与空间访问拒绝改为 `authorizationDenied(...)`，消除「含『不存在』被归 404」的错分。
- **契约**：`docs/development/openapi-workbench.json` 为运行详情、SSE、团队会话列表、共享文件列表补充 3-T1 读取轨说明；`pnpm verify` 通过。

## 7. TW-06 归档语义与生命周期（批次 3 第一部分，已合入 main）

**交付记录（2026-09-11）**：4 个提交 —— `58514a2`（3-T1 授权双轨）、`46fecb0`（3-T2 归档/恢复 API）、`befb7c9`（3-T3 前端归档体验）、`5058f73`（3-T4 集成验证与真实 DSH e2e + 文档）。3-T5 文档收尾即本节与方案/设计/任务文档的同步。

**归档语义（产品确认：只读保留）**：归档后现任成员仍可按各自权限查看会话、文件、成果与历史运行并下载；新对话、续写、重试、上传、成员与 Agent 变更、设置修改一律拒绝；失权成员仍拒绝；归档空间仍允许紧急撤权与负责人转交（治理例外）。

**交付内容**：
- **授权双轨（3-T1）**：原先同时管读与执行的 `w.status='active'` 拆成执行轨（active-only）与读取轨（active+archived，现任成员）；放宽一律按调用点 opt-in，默认仍执行语义。
- **归档/恢复 API（3-T2）**：`POST /workspaces/:id/archive|restore`（仅负责人、事务内、审计事实、运行中 409 提示等待或取消）；`GET /workspaces` 补 `status`/`archivedAt`、`owner` 改为当前负责人、`?status=active|archived|all`（默认 all）。空间设置补 `PATCH /workspaces/:id`（1A 遗留）。
- **并发保护**：归档与开跑/重试/领取共用同一把 `workspaces` 行锁（锁序 workspaces → sessions/run_attempts/runs/runtimes）；**并修正一处既有死锁**（成员增删/改角色与转交锁序相反，实测 39/40 次 40P01 → HTTP 500）。
- **前端归档体验（3-T3）**：列表「全部/活动/已归档」筛选（含键盘与深链）、归档卡片与空态、归档详情只读提示条 + 负责人「恢复空间」、隐藏全部写入口（详情页 + 成员/Agent 弹窗 + 全局新对话空间选择器 + 侧栏会话删除）。
- **验证（3-T4）**：`test:m5:lifecycle:integration`（20 用例，含 5 条判别性并发用例）已在 `server/package.json`、根 `package.json`、`.github/workflows/ci.yml` 三处登记；真实 DSH e2e 追加归档环节，实测读取轨可用、执行轨被拒且不落库。

**评审轮次**：每个任务都走「实现 → 规格符合性评审 → 对抗性质量评审 → 修复 → 复审」。抓出的实质问题包括路由闸门错档导致归档读轨不可达、会话附件上传在归档空间返回 201、空间存在性可枚举、授权缓存状态轨洞、**并发用例不具鉴别力（删掉行锁仍全绿）**、成员变更 TOCTOU、排队期间归档的调度器不收敛、写入口审计遗漏（成员/Agent 弹窗、composer、侧栏删除）。关键回归断言均做过反证。

**AC-23 例外（产品已确认接受）**：团队会话分页在个人空间上的状态码由 422 改为 403，与「空间不存在/非成员」一致，以消除用状态码枚举空间是否存在的差异；个人空间功能行为不变，其余团队专用接口仍 422。

## 8. 工程约定

- **测试数据库**：本机 docker 容器 `dsh-work-postgres-local`，端口 15433，`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。`DSH_WORK_TEST_DATABASE_URL` 必须显式传入（`.env` 只配了 `DSH_WORK_DATABASE_URL`，未配它时集成套件会以「DSH_WORK_TEST_DATABASE_URL 未配置」直接失败）：`DSH_WORK_TEST_DATABASE_URL='postgres://dsh_work:change-me@127.0.0.1:15433/postgres'`，只需指向该实例的 `postgres` 维护库；**全部 24 个集成套件**（`server/src/**/*integration.test.ts`，含 `modules/identity/identity.integration.test.ts`）统一通过 `server/src/infrastructure/postgres/test-database.ts` 的 `createThrowawayDatabase()` 各自创建、迁移、销毁一次性库，因此不再有共享库历史污染问题——此前「**不要**对共享 dev 库 `dsh_work` 跑 T2 套件（历史污染导致误失败）」的警告已随该迁移失效。**新增集成套件请直接用该 helper，不要再直连共享库。**
- **验证命令**：`pnpm verify`（文档/契约静态检查，改 OpenAPI 后必跑）、`pnpm lint`（含 architecture 与 UI 校验）、`pnpm --filter @dsh-work/server typecheck`。测试脚本已并入 server/package.json 与根 package.json（`test:m4:team-auth:integration`、`test:m5:workspace:integration`、`test:m5:members:integration`、`test:m5:agent-members:integration` 等）。
- **提交规范**：conventional commits，中文或英文 message 均可，`feat(server):`/`fix(server):`/`docs:` 前缀；每任务一个 feat + 若干 fix。
- **工作流**：subagent-driven-development——实现子代理（TDD，先红后绿）→ 规格符合性评审（独立验证、重跑测试）→ 代码质量评审（对抗性验证，前序任务靠它抓到 6 个并发类缺陷）→ 修复 → 复审。评审不可跳过；本批次每个任务的修复轮都来自评审发现。
- **个人空间零改动**是贯穿所有任务的验收红线（AC-23）。

## 9. 1A 退出条件（已达成）

- 两名员工和一个 Agent 可协作 ✅：员工成员 API（T3）+ Agent 成员 API（T4）+ 名册接口 + 员工端成员管理与 Agent 发起入口（T6）。
- 多 Agent 共享授权不误删（AC-26）✅：`workspace_grant_sources` 多来源、撤销单来源不误删（`workspace-agent-member-api` 用例）、legacy 对账后保留共享工具授权（T7）。
- Agent 或员工收权能阻止新增、排队和后续交付（AC-09）✅：撤权清扫 + 执行前复核 + 系统取消 + SSE 逐批拦截 + REST 详情/列表/取消读取拦截（T5 及其评审修复）。

以上三条由 `pnpm verify` 的 `team-workspace-1a` 检查组锁定证据锚点（契约路径、迁移、关键用例），任一处被删或改名即失败。`team-workspace-plan.md` 第 10 节已同步交付状态。后续进度：1B 已交付（见 §6）；批次 3 的 TW-06 已交付（见 §7）、TW-07 后端已交付、TW-08 后端已交付（见 §10）。

## 10. TW-07 / TW-08（批次 3 第二、三部分）

详细交付记录在 `docs/design/team-workspace-batch-3-tasks.md`（3-T6 / 3-T7 两节），此处只留接手所需的要点与坐标。

**TW-07 文件更新与版本（3-T6，✅ 后端已合入 `main`，`624acc4`）**
- 迁移 `0025_workspace_file_versions.sql`：`workspace_files`（逻辑文件）+ `workspace_file_versions`（版本），`file_objects` 保持不可变（AC-13）；既有团队共享文件回填为 v1，个人空间文件与会话附件不回填。
- 服务与路由：`listWorkspaceFiles` 按逻辑文件聚合、`GET/POST …/files/:logicalFileId/versions`、按版本下载走既有 `readFile` 读取轨；版本号在逻辑文件行锁内按 `max(version_no)+1` 分配，失败版本保留记录但不上移 `latest_version_no`。
- 前端版本 UI 未做（属批次 3 剩余工作）。AC-29 的规模基线**未在本任务重测**，`docs/history/team-workspace-1b-statistics-findings.md` §8 已标注 1B 的文件列表查询形状在 TW-07 之后过时。

**TW-08 团队动态与通知（3-T7，✅ 后端已完成、两轮评审已修）**
- 迁移 `0026_workspace_activity.sql`：`workspace_activity_events`（12 种 kind 的闭合集合、`(tenant_id, workspace_id, dedupe_key)` 唯一、feed 索引）+ `workspace_notification_states`（`last_read_at`/`muted_at`）；纯新增、可重复执行、**不回填历史**。
- 事件源结论（为什么自建）：`workspace_revocation_events` 是收权输入且按撤权语义去重、文件操作此前**完全不写事件**、`audit_events` 是治理投影、`run_events` 是执行细节——都不能当通用动态。**普通消息、未共享对话活动、Run 执行细节明确不进入动态**。
- 写入方式：**与业务变更同事务**（`recordWorkspaceActivity`），`on conflict do nothing` 幂等；去重键按事件形状选自然键／`pg_current_xact_id()`／`team_auth_revision`，「是否真的变了」由各调用点的 `returning`/`is distinct from` 守卫保证（A→B→A→B、归档→恢复→归档都要各自留痕）。
- 读取：6 条路由全为读取轨（归档可读），每次读取重新解析成员资格（不缓存跨撤权）；非成员与不存在空间拒绝一致（不可枚举）；个人空间 422（AC-23）。`safe_metadata` 只放 id／角色／版本号，**任何名称与正文都不进入动态**。
- 游标：`(occurred_at, id)` keyset，游标令牌取 DB 侧 `occurred_at::text`（JS `Date` 只有毫秒精度，直接用会把同毫秒内的行重复/漏掉）；构造型畸形游标由形状校验 + SQLSTATE 22007/22008/22021/22P02 翻译统一落类型化 422（评审 P1）。「标记已读」用 `greatest()` 保持 `last_read_at` 单调不回拨。
- 评审：规格符合性「有条件符合 → 已修」；质量评审「PASS，一处 P1 必修」；两轮发现已全部修复并各自反证。交付：`24774e6` 已合入 `main`，CI `M6 quality gate` 通过（`34666778699`）。
- 前端（3-T8）：右栏「最近动态」摘要 + 「查看全部」抽屉 + 未读徽标与按空间静音；两轮评审发现（质量 2×P1 + 8×P2、规格 1×P3 + 1×P2 归档写入口遗留缺口）全部修复并逐条反证。
- **批次 3 退出条件已满足**（归档恢复、文件升级追溯、动态去重与收权）。**TW-07 前端版本 UI（3-T9）随后也已交付**：文件行版本显示、上传新版本、版本列表（含失败版本）与历史版本下载、按版本引用；TW-07 至此端到端可用。
- **4-T3（2026-09-12）**：`scripts/runtime/team-workspace-e2e.ts` 扩展为覆盖 TW-07／TW-08／空间用量的真实 DSH 端到端（新增：独立会话的固定版本读取、坏版本不破坏旧版、动态幂等与泄露检查、通知与收权三条路径、用量同谓词交叉核对 + `blocked` 样本 + 跨空间隔离 + 30d、归档读取轨全部纳入 `ok`），并补了信号安全清理与非本地库护栏；已多次实跑 `ok: true`，两轮评审后的修复见 `team-workspace-batch-4-tasks.md` §11。
