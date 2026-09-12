# TW-09（协作效率增强）现状核查

**状态：** 只做现状核查，**不改代码、不排期、不定范围**（2026-09-12）。
**范围决定（2026-09-12，产品确认）：TW-09 只做「空间用量」**，其余四项（成果评论与 @成员、个人收藏与空间置顶、空间模板、按试点反馈排期）**明确不做**，不排期、不预留入口。本文件据此从「候选评估」转为**决定留档与备查**：§1 是空间用量的落地依据，§2–§5 保留当时核查结论以便日后审计（若重新启用，需重做核查）。实施拆分与口径见 `team-workspace-batch-4-tasks.md`。
**空间用量的最终口径（产品已定）**：仅负责人与管理员可见；只展示 token 与调用次数、不展示金额；归档空间可读；个人空间 422 且前端零请求；不需要新迁移。

**实施后补充（2026-09-12，批次 4 评审发现）**：
- 聚合查询形状在实施中改为「先按空间+窗口过滤用量事件并聚合，再与日序列左连接」——原形状会顺序扫描整个租户的 `model_usage_events` 并溢写 temp（实测 16.3 万行 130ms+），新形状实测 5.6ms 且走 `model_usage_by_run` 索引，结果逐行一致。
- 状态口径收窄为 `success`/`failed`：`0004` 的 CHECK 虽允许 `blocked`，但没有写入者；不收窄会让「总数 ≠ 成功 + 失败」在未来某天成立。
- 顺带修掉一个读接口写副作用：`workspaceId='standalone'` 会被 `normalizeWorkspaceId` 归一为 null，从而让 `resolveReadableWorkspace` 回退到 `ensurePersonalWorkspace()` **建库**；4-T1 与 3-T7 的动态接口都已显式拒绝该哨兵。
- 已知未修（记录）：`model_usage_events` 没有 `(tenant_id, attempt_id)` 唯一约束，每 attempt 唯一性只靠写入端确定性 id（`usage-<attemptId>` + `on conflict do nothing`）保证；补唯一索引需要新迁移，本批不做。
**依据：** 方案 `team-workspace-plan.md` §7 批次表与 TW-09 条目（P2，依赖实际试点反馈，范围单独确定，不混入首版交付）。本文件把五个候选逐条核到**表、接口、权限点与既有限制**，供产品据此选范围；结论中的「代价」是相对量级，不是承诺。

## 0. 结论速览

| 候选 | 现有数据面 | 需新迁移 | 关键前置 | 相对代价 |
| --- | --- | --- | --- | --- |
| 空间用量 | ✅ 数据源已具备（`model_usage_events` + 空间维度可由 sessions 关联） | 可选（仅在规模需要时加聚合索引） | 展示口径与可见角色 | 低（1 个任务） |
| 个人收藏与空间置顶 | ❌ 无任何字段/表 | 需要（1 张偏好表） | 「个人 vs 团队管理员」语义、是否含个人空间、归档空间可否置顶 | 低–中（1–2 个任务） |
| 空间模板 | ⚠️ 可模板化的空间面很窄（名称/说明 + Agent 成员及其派生能力） | 需要（模板定义 + 套用记录） | 字段级边界（不得携带成员授权与凭据）、模板归属与套用主体、是否审计 | 中–高（2–3 个任务） |
| 成果评论与 @成员 | ❌ **缺载体**：当前成果只对作者本人可见 | 需要（评论表；若 @ 进站内通知还要改 `kind` CHECK） | 是否重启「跨成员可见成果」的一部分（2B 已放弃）；评论挂载对象 | 高（3+ 个任务，或被裁到「共享文件评论」后 1–2 个） |
| 试点依据（使用频率/反馈排期） | 🟡 使用频率可从 `runs`/`sessions`/`model_usage_events` 统计；**没有反馈收集机制** | 不需要（若只出统计） | 产品提供反馈，或明确按给定顺序做 | 低（0.5 个任务）或由产品提供 |

另有一项**跨候选的流程前置**：方案 AC-01~29 里**没有 TW-09 的验收项**，设计文档 `team-workspace-design.md` 也**没有 TW-09 章节**（模板/收藏/置顶/用量/评论均无）。开工前需要补「验收项 + 设计增量」，否则无法按既有「实现 → 规格评审 → 质量评审 → 反证」闭环。

## 1. 空间用量

**现有数据面（已核）**

- `model_usage_events`（`server/migrations/0001_m2_platform.sql:440`）按 `run_id` + `attempt_id` 记录：`provider`、`model`、`input_tokens`、`output_tokens`、`latency_ms`、`cost_amount`、`cost_currency`、`occurred_at`；`0004_m3_observability.sql:3-6` 补 `status`、`trace_id`、`estimated`。**已满足方案「不从消息长度猜测模型消耗」的要求。**
- 索引：`model_usage_by_time (tenant_id, occurred_at desc)`、`model_usage_by_run (tenant_id, run_id)`（`0001:508-509`）。
- 空间维度不是直接列，但可关联：`runs.session_id` → `sessions.workspace_id`，而 `sessions_by_workspace (tenant_id, workspace_id, last_active_at desc)`（`0001:500`）与 `runs_by_session (tenant_id, session_id, created_at desc)`（`0001:501`）都在，按空间聚合不需要新索引即可走索引。
- 管理端**已有平台级用量面**：`GET /api/admin/v1/usage`（近 7 天 runs + tokens）与 `GET /api/admin/v1/model-usage`（最近 200 条明细），实现在 `server/src/modules/admin/application/postgres-operations-service.ts:378`(`getUsage`)/`:387`(`getModelUsage`)，路由 `server/src/http/admin/operations-routes.ts:32-33`；前端 `apps/admin-web/src/views/ModelUsageView.vue`。**但都是租户级，不按空间过滤。**
- `runs.requested_by` 存在（`getModelUsage` 已用它关联员工），因此「按成员拆分」也不需要新列。

**要做的是**：新增按空间的聚合查询（`sessions.workspace_id` 过滤）+ 一组工作台只读接口 + 展示。**不需要新表**；若真实数据规模下聚合慢，再考虑 `model_usage_events` 的空间维度冗余列或物化视图（那才需要迁移）。

**需要确认**：给谁看（负责人/管理员/全员/只读成员——权限矩阵只规定「查看空间资料」对所有角色允许，用量是否同档未定）；时间窗与粒度（日/月/自定义）；失败、取消、阻止的 Run 是否计入；是否只统计模型消耗还是也含工具调用（工具审计在 `tool_audit_logs`，口径不同）；是否含个人空间（AC-23 要求个人空间行为不变，新增要显式确认）；金额币种与「平台计量」的权威来源是否就是 `model_usage_events`；是否只读（不允许导出/分享）。

## 2. 个人收藏与空间置顶

**现有数据面（已核）**

- **完全没有**收藏/置顶的表、列或接口（全仓 `favorite|pinned|pin_` 只命中无关注释）。
- 空间列表排序目前是 `order by "updatedAt" desc`（`postgres-content-service.ts:208`）；`workspaces` 表只有 `name/description/workspace_type/created_by/status/archived_at`（`0001:...`），**没有排序或置顶列**。
- 个人空间与团队空间同表（`0013_m5_personal_workspaces.sql:4-8` 把 `workspace_type` CHECK 放宽为 `('personal','team')`），因此「个人空间是否也能收藏/置顶」是一个纯产品决定，技术上同表即可支持。

**要做的是**：1 张「每人 × 空间」偏好表（收藏 + 置顶 + 排序权重），空间列表排序改为「置顶优先 + 原有 updatedAt」，工作台列表与卡片加交互。属于纯个人偏好，**不触碰授权模型**，风险低。

**需要确认**：方案写「区分个人行为与团队管理员行为」，但没说置顶属于哪一类——是**每人各自置顶**（推荐，纯偏好表）还是**管理员设置的空间级置顶**（需要权限与审计，且归档空间要定规则）；置顶对象是空间本身还是空间内的会话/文件/成果（后者要挂到对应对象上，范围明显更大）；个人空间是否也支持（AC-23 显式确认）；归档空间能否置顶（读轨 vs 执行轨）；收藏/置顶是否要进团队动态（**建议不进**，属个人行为）。

## 3. 空间模板

**现有数据面（已核）**

- 空间级可配置面很窄：`workspaces.name/description`（+ `status`）。
- 「允许启用的能力」在实现上就是 `workspace_agent_members`（`agent_id` + 固定 `agent_version_id` + `status`，`0022:...`）以及由 Agent 成员派生的 `workspace_grant_sources`（`capability_type ∈ agent|skill|tool`，`source_type ∈ agent_member|manual|legacy_unresolved`，`0022:...`）与更早的 `workspace_capability_grants`（`0001:260`）。
- **凭据由平台管理**：`credential_refs`（`0001:159`），tool 版本以 `credential_ref_id` 引用（`0001:179`、`0001:226`）——模板**绝不应携带**这一列，这正是方案「不复制凭据」的落点。
- **成员授权不在空间设置里**：`workspace_members`（`0001:247`）独立成表，模板天然不会复制成员权限；但「不复制成员权限」这句话在实现上要变成**明确不写 `workspace_members`**，需要写进验收项。
- 管理端目前只有只读视图 `apps/admin-web/src/views/WorkspaceManagementView.vue`（搜索/查看，含规模、成员、Session、文件、成果列），**没有模板概念**；工作台侧也没有。

**要做的是**：模板定义表（可复用的空间设置 + 允许启用的能力，指向 Agent 版本与 skill/tool 版本 id）+ 套用记录/审计 + 套用流程（负责人创建空间时选择模板）+ 管理端或工作台 UI + 契约。**属于本批候选里最重的一项**，因为它会触碰授权派生链路（Agent 成员 → 授权来源），任何「模板启用能力」都必须走既有 `workspace_grant_sources` 派生与对账，否则会与撤权/对账机制打架。

**需要确认**：模板来源与归属（平台预置 / 团队自建 / 管理端维护）；可见范围（所有团队可选用 vs 指定团队）；由谁套用（负责人建空间时，还是管理员在管理端）；模板能包含哪些字段（说明默认值、Agent 成员清单与版本策略、Skill/Tool 启用项）；版本策略（钉住 `agent_version_id` 还是跟随最新发布版——跟随后续升级会波及所有套用过的空间，风险高）；套用是否写审计、能否撤销、撤销语义（移除模板带来的 Agent 成员？会不会连带撤权）；与归档的关系（归档空间不套用）。

## 4. 成果评论与 @成员

**现有数据面（已核，且与方案内部冲突）**

- 成果数据模型：`artifacts`（`0001:411`，**`session_id not null`**，有 `workspace_id` 与 `created_by`）+ `artifact_versions`（`0001:426`，指向不可变 `file_object_id` 与 `source_run_id`）。
- 成果**只对作者可见**：`listArtifacts(actorUserId)` 用 `s.created_by = ${actorUserId}` 过滤（`postgres-content-service.ts:373`），工作台成果页签取的就是这份数据（`WorkspaceDetailView.vue:191-193` 按 `workspaceId` 过滤）。
- 方案 §4 内容边界明确写着：**「团队成果发布已放弃，不新增跨成员可见的成果列表」**（`team-workspace-plan.md:44`，2B 随 2A 一并放弃）。而 TW-09 第一条就是「成果评论与 @成员」——**同一份方案里自相矛盾**：评论需要一个「成员之间可见的成果」载体，而这个载体正是被放弃的 2B。
- @ 的候选名单现成：`GET /workspaces/:id/members`（1A-T6 交付，所有角色可读名册摘要），满足方案「仅在具有内容读取权限的成员范围内选择」。
- 若要「被 @ 时进站内通知」，需要给 `workspace_activity_events` 增加 `kind`；该表的 `kind` 是 `0026_workspace_activity.sql:28` 的**内联 CHECK**，改它必须用新迁移 `alter table … drop constraint / add constraint`，并**同步四处**：迁移 CHECK、`workspace-activity-writer.ts` 的 kind 联合、前端 `types/domain.ts` 联合、`packages/workbench-components/src/workspace-activity.ts` 联合；此外 3-T9 新增的「前端 kind 集合 ↔ 迁移 CHECK」契约测试会立刻变红（这正是它存在的意义，属于预期成本而非缺陷）。

**可选路线**（需产品选）

1. **重启部分 2B**：先做「团队可见成果」面（发布/共享 + 读取权限），再做评论/@。范围与风险最大，且等于推翻 2A/2B 的放弃决定。
2. **把评论挂到共享文件上**（`workspace_files`/版本已是团队可见对象）：范围小得多，1–2 个任务，但与 TW-09 原文的「成果评论」不是同一件事，需要产品改名确认。
3. **只做 @成员 的轻量版**（例如在共享文件或空间层面留言/@），同样需要重新定义挂载对象。
4. **暂不做**：等试点反馈证明需要跨成员成果协作再启动。

**需要确认**：评论挂载对象；是否重启跨成员成果可见（2B 的一部分）；@ 是否进站内通知（进则要改 `kind` CHECK + 迁移 0027）；评论的编辑/删除/审计语义；归档空间能否评论（读轨 vs 执行轨）；评论是否进团队动态；是否需要富文本（**建议纯文本**，避免新的注入面）。

## 5. 试点依据（使用频率与数据规模）

- **使用频率/规模可以从现有数据算出**：`listWorkspaces` 已在算 `sessionCount`/`artifactCount`（`postgres-content-service.ts`），`runs` 有创建时间与 `requested_by`，`model_usage_events` 有 tokens；1B 还留下了可复跑的基线工具 `scripts/bench/team-workspace-statistics.ts` 与 `docs/history/team-workspace-1b-statistics*.md`。
- **「反馈」没有数据源**：全仓没有 feedback/埋点表（`grep feedback server/migrations/*.sql` 无命中），也没有前端反馈入口。方案要求的「团队使用频率、反馈及数据规模」里，只有前两项之一（频率）与第三项能自动产出。
- 因此：要么产品提供试点反馈，要么明确「按父代理建议顺序先做」，不要把它当成已经有依据。

## 6. 需要产品确认的清单（汇总）

1. **是否现在开工**：方案要求按试点反馈排期、不预先增加空入口；若无反馈依据，是否明确破例先做？
2. **范围与顺序**：五条候选选哪些。
3. **验收项**：是否为 TW-09 新增 AC-30… 并登记进方案 §4 与 AC 矩阵（否则无法规格评审）。
4. **设计增量**：设计文档需要新增 TW-09 章节（`team-workspace-design.md` 目前完全没有相关内容）。
5. **逐条口径**：见 §1–§4「需要确认」。
6. **贯穿约束是否沿用**（建议沿用并要求产品点头）：AC-23 个人空间不变；归档＝只读保留（并明确各功能在归档空间是读还是写）；读/执行双轨；类型化拒绝；OpenAPI 同步；集成测试用一次性库；允许新增迁移（0027+）。
7. **是否要求 TW-09 覆盖真实 DSH 端到端与四账户人工验收**。
8. **与发布部署的关系**：是否先完成已交付批次（1A/1B/批次 3）的发布与人工验收，再叠加 P2 新功能。

## 7. 建议顺序（若现在做）

`空间用量`（数据源已就绪、不触碰授权）→ `个人收藏/置顶`（纯个人偏好）→ `空间模板`（触碰授权派生，需最谨慎）→ `成果评论/@`（先解决载体与 2B 冲突）。

## 8. 本次核查未覆盖 / 不确定

- 未测量真实生产数据规模（本机是测试库），空间用量查询的延迟与索引需求需在真实数据上复核（可复用 1B 的基线工具）。
- 未评估「团队可见成果」若重启需要多少既有 2B 设计（`team-workspace-design.md` 已删除 2A/2B 章节，需重做设计增量）。
- 未细查管理端（admin-web）若要承载模板/用量管理需要的权限与菜单改动。
- TW-09 各项都是**平台业务功能**，不涉及 Agent 执行链路，因此与 AGENTS.md 的「Agent 执行统一使用 DSH」不冲突，也不需要 DSH 侧新能力（如后续出现需要 DSH 参与的能力，另行核查）。
