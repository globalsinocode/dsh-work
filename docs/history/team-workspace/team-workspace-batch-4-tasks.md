# 批次 4 任务拆分与实施约束（TW-09 空间用量）

**状态：** 进入实施的任务边界（2026-09-12）。产品语义以 `team-workspace-plan.md` 为准，界面以 `team-workspace-design.md` 为准，本文件只拆任务、定验收与顺序。
**范围决定（2026-09-12，产品确认）：** TW-09「协作效率增强」**只做「空间用量」**；其余四项（成果评论与 @成员、个人收藏与空间置顶、空间模板、按试点反馈排期）**明确不做**，不排期、不预留入口。现状核查结论与逐条数据面见 `team-workspace-tw09-survey.md`（保留备查）。
**依赖：** 1A（成员与授权）、批次 3（读/执行双轨、`workspace_activity_events` 的 0026 模式）已交付。

## 1. 口径（实施前已定，2026-09-12 产品确认）

| 项 | 决定 |
| --- | --- |
| 可见范围 | **仅负责人与管理员**（`owner`/`admin`）。普通成员与只读成员看不到用量区块，**前端不渲染且不发请求**（与归档/个人空间同样的「零请求」口径） |
| 展示内容 | **只展示 token 计数与调用次数**（含成功/失败拆分，以及「其中 N 次为估算值」），**不展示任何金额**。补充事实：`model_usage_events.cost_amount` 目前恒为 `0`、`cost_currency` 恒为 `CNY`（`postgres-operations-service.ts` 写入处），展示金额只会误导 |
| 计量口径 | 以 `model_usage_events` 为准（每次 attempt 一行，`occurred_at` 为消耗发生时刻），**不从消息长度或会话数推算**。`estimated = true` 表示平台估算而非 DSH 上报，必须在界面上明示 |
| 聚合维度 | 「空间用量」= 该空间**全部现任与历史会话**的消耗，**不按成员拆分**（按成员的明细属平台治理面，见管理端既有用量页） |
| 时间窗 | `range=7d|30d`（默认 `7d`），按日分桶并**零填充**（含无消耗的日子，保证曲线连续）；日序列升序 |
| 时区 | 与既有管理端用量口径一致：按数据库会话时区做 `current_date` 与按日分桶（`postgres-operations-service.ts` 的 `getUsage` 同口径） |
| 归档空间 | **可读**（读取轨）：负责人/管理员在归档空间仍可查看历史用量；不做任何写入 |
| 个人空间 | 团队专用接口惯例：**422**；个人空间不渲染用量区块、零请求（AC-23） |
| 不可枚举 | 非成员与不存在空间返回**完全一致**的 403（沿用 1A 口径）；非负责人/管理员但为现任成员 → 403（类型化，不能落 500） |
| 是否新增迁移 | **不需要**。既有索引即可支撑：`sessions_by_workspace (tenant_id, workspace_id, last_active_at desc)` → `runs_by_session (tenant_id, session_id, created_at desc)` → `model_usage_by_run (tenant_id, run_id)`；如需再优化，用 1B 的基线工具在真实数据上复核后再单独决策 |
| 是否进团队动态 | **不进**。用量是查询面，不产生 `workspace_activity_events` |
| 是否改后端既有用量面 | **不改**。管理端 `GET /api/admin/v1/usage`、`/model-usage` 保持现状；本批只新增**空间维度**的工作台只读接口 |

## 2. 接口契约（实施前冻结；两个任务都以此为准）

`GET /api/workbench/v1/workspaces/:workspaceId/usage?range=7d|30d`

- 鉴权：团队空间 + 现任成员 + `owner|admin`；读取轨（`purpose: 'read'`，归档可读）。个人空间 → 422；非成员/不存在 → 403（与不存在同文案）；现任成员但角色不足 → 403（类型化 `authorizationDenied`）。
- `range` 缺省 `7d`；只接受 `7d`/`30d`，其它值 → 422（类型化 `requestInvalid`）。
- 200 响应：

```json
{
  "workspaceId": "ws-...",
  "range": "7d",
  "rangeDays": 7,
  "totals": {
    "callCount": 12,
    "successCount": 10,
    "failedCount": 2,
    "estimatedCount": 3,
    "inputTokens": 12345,
    "outputTokens": 6789,
    "totalTokens": 19134
  },
  "daily": [
    { "day": "09-06", "callCount": 2, "successCount": 2, "failedCount": 0, "inputTokens": 1000, "outputTokens": 500 }
  ]
}
```

- `daily` 长度恒为 `rangeDays`，升序，零填充；`day` 为 `MM-DD`。
- token 为整数；`totalTokens = inputTokens + outputTokens`；计数与 token 均**只统计该空间会话所属 Run** 的用量事件。
- 不返回金额、币种、provider/model、员工身份等字段（最小必要面）。

## 3. 任务单元

### 4-T1 空间用量后端（聚合查询 + 只读接口 + 契约）✅ 已完成（2026-09-12，两轮评审已修）
- **目标**：提供上述 `GET /workspaces/:workspaceId/usage` 接口，权限与口径严格按 §1/§2。
- **实现要点**：
  - 新增 `postgres-workspace-usage-service.ts`（或等价命名，**不要塞进已经过大的 `postgres-content-service.ts`**）：先按读轨解析空间（拒绝个人空间 422、非成员 403），再 `requireTeamRole(['owner','admin'], { purpose: 'read' })`，并把角色不足的**裸 Error 翻译成类型化 403**（`requireTeamRole` 角色不足时抛的是普通 Error，若不翻译会被路由器分类成 **500**——本项目反复踩过的坑）。
  - 聚合：一次查询返回按日分桶（`generate_series` 零填充 + 左连接该空间在窗口内的用量事件），totals 在服务端由日序列求和得出（避免第二次往返）；窗口按 `model_usage_events.occurred_at` 过滤，空间过滤走 `sessions.workspace_id`。
  - 事件来源是每次 attempt 一行（`usage-<attemptId>`），`status ∈ ('success','failed')`；不要虚构 `blocked` 桶。
  - 新增路由 `workspace-usage-routes.ts` 并接线 `main.ts`；`docs/development/openapi-workbench.json` 同步新增路径与 schema（含 403/422 说明）。
  - **无迁移**。
- **验收**：AC-30。
- **测试**：新增 `server/src/http/team-workspace-usage-api.integration.test.ts`（`createThrowawayDatabase()`），登记为 `test:m5:usage:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml` 三处）。判别性用例至少覆盖：负责人/管理员可读；**普通成员与只读成员 403 且为类型化（不是 500）**；非成员与不存在空间拒绝逐字一致（不可枚举）；个人空间 422；归档空间负责人/管理员仍可读；`range` 缺省/`7d`/`30d`/非法值；totals 与 daily 的数值正确（造多天、多状态、`estimated` 混排数据）；**只统计本空间会话**（另一空间的 Run 不得计入）；无消耗的日子零填充且天数正确；跨空间会话归属隔离。

### 4-T2 空间用量前端（右栏区块 + 详情弹窗 + 角色门禁）✅ 已完成（2026-09-12，两轮评审已修）
- **目标**：负责人/管理员能在空间详情看到用量摘要与详情；其他角色与个人空间完全不出现、零请求。
- **实现要点**：
  - `WorkspaceInfoPanel.vue`（纯展示、自身不发请求）在成员区之后新增「空间用量」区块：摘要「近 7 天 {callCount} 次调用 · {totalTokens} tokens」，若有估算值则附「其中 {estimatedCount} 次为估算值」；`查看全部/查看详情`按钮打开详情；加载骨架、失败就地错误 + 重试（重试真的重新请求），不用错误态伪装成「零消耗」。
  - 宿主 `WorkspaceDetailView.vue` 只在 `isTeam && (currentUserRole === 'owner' || 'admin')` 时加载（**角色未解析出来时不请求**，沿用既有「宁可漏开不可误开」口径）；切换空间/卸载作废在途请求（沿用 3-T8/3-T9 的世代号模式）。
  - 详情用 `el-dialog`（与版本列表同规范）：`7 天/30 天` 切换、每日明细（日期、调用次数、成功/失败、input/output tokens）、合计行；**不出现任何金额字段**；解析状态/估算说明用文字而非仅颜色。
  - API 客户端与类型：`listWorkspaceUsage(workspaceId, { range })` + `WorkspaceUsage*` DTO；契约字段名严格按 §2（不新增字段）。
- **验收**：AC-30（前端部分）、AC-16。
- **测试**：沿用 vitest + `@vue/test-utils`。判别性用例至少覆盖：负责人/管理员渲染摘要且只请求一次；**普通成员/只读成员不渲染且零请求**；**角色未知不请求**；**个人空间不渲染且零请求（AC-23）**；估算值提示；`7 天/30 天` 切换按正确 range 请求；加载失败错误态 + 重试真的重发；空数据（全零）显示零值而不是错误态；切换空间后旧响应不落回（世代号）；详情弹窗可访问名称与焦点恢复。

### 4-T3 真实 DSH 端到端补全（TW-07 / TW-08 / 空间用量）✅ 已完成（2026-09-12）
- **目标**：批次 3 的 TW-07、TW-08 与批次 4 的空间用量此前只有集成 + 前端用例，**缺少真实 DSH 运行时下的端到端验证**（只有 1B 与 TW-06 归档各跑过一次）。本任务把 `scripts/runtime/team-workspace-e2e.ts` 扩展成一条覆盖三者的真实运行链路并实跑。
- **做法**：在既有「A 上传 → B 引用运行 → 继续对话 → 归档」之后追加三段真实服务调用（不 mock、不打桩）：TW-07 的新版本/失败版本/固定版本引用与追溯；TW-08 的真实成员动作产生的动态、幂等、通知与收权；批次 4 的用量聚合与权限矩阵。归档改为调用真实 `archiveWorkspace`（因此审计与 `workspace_archived` 动态一并产生）。
- **不在 CI**：CI 无 DSH 运行时，本脚本属人工/环境验证；批次 3/4 的 CI 锚点仍是集成与前端套件。
- **验收**：AC-13（新版本/失败版本/固定版本引用与追溯部分）、AC-15（动态幂等、无私有内容、收权后旧通知不可读）、AC-30（用量聚合与权限矩阵）在真实 DSH 运行时下的端到端证据。**不在本 e2e 内**：AC-13 的「文件移除阻止新引用」、AC-15 的「不显示私有对话」、AC-30 的「不展示金额/估算值明示」——这三处由集成与前端套件覆盖（见 §11 边界）。

## 4. 顺序与依赖

```
4-T1（服务 + 路由 + 契约 + 集成用例）  ──>  4-T2（前端区块 + 弹窗 + 用例）
```

- 接口契约在 §2 冻结，4-T2 据此并行开发（前端测试全部 mock 客户端，不依赖服务端）。
- 每个任务：实现（TDD 先红后绿）→ 规格符合性评审 → 对抗性质量评审 → 修复 → 复审，流程同 1A/1B/批次 3。

## 5. 贯穿约束（违反即回退）

- **个人空间零改动（AC-23）**：不渲染、不请求、不改个人空间任何既有行为。
- **不能按文案分类拒绝**：新增拒绝一律 `authorizationDenied(...)`（403）/`requestInvalid(...)`（422）。
- **API 变更必须同步 OpenAPI 契约**并跑 `pnpm verify`；不得绕过 DSH 另建 Agent 执行逻辑（AGENTS.md）。
- **新增集成套件必须用 `createThrowawayDatabase()`**，并三处登记。
- `DSH_WORK_TEST_DATABASE_URL` 需显式传入：`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。
- 本机 `pnpm test:e2e` 因 OIDC 允许来源只含 `localhost` 而失败（非缺陷），CI 侧有 browser smoke。

## 6. 不在本批范围

- TW-09 的其余四项能力（见本文件头部范围决定与 `team-workspace-tw09-survey.md`）。
- 金额/费用展示（数据源 `cost_amount` 恒为 0，且产品已决定不展示金额）。
- 按成员拆分的用量明细（属平台治理面，管理端既有页面负责）。
- 工具调用与检索消耗的计量（口径不同：`tool_audit_logs`），本批不做。

## 6. 交付记录（2026-09-12）

**4-T1 后端**
- 新增 `server/src/modules/workbench/application/postgres-workspace-usage-service.ts`（授权门禁 + 单条零填充聚合）、`server/src/http/workbench/workspace-usage-routes.ts`（`GET /api/workbench/v1/workspaces/:workspaceId/usage`）、`server/src/http/team-workspace-usage-api.integration.test.ts`（**13** 个集成用例）；`server/src/main.ts` 接线；三处登记 `test:m5:usage:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml`）；`docs/development/openapi-workbench.json` 新增路径与 `WorkspaceUsageView`/`Totals`/`DailyPoint` schema。**无迁移、无 schema 变更**。
- 授权顺序：`range` 解析 → 拒绝空白 id 与 `standalone` 哨兵（先于任何空间解析，读接口不得写库）→ `resolveReadableWorkspace`（读轨、归档可读、非成员/不存在同一 403）→ 个人空间 422 → `requireTeamRole(['owner','admin'], { purpose: 'read' })`。
- 聚合：`with workspace_usage_events as (按空间 + 窗口过滤) → daily as (按日聚合) → left join generate_series(日序列)`；totals 由日序列求和，无第二次往返；`totalTokens = input + output`。
- **实现代理的反证**：移除角色翻译（member/viewer 实测落 500）、移除空间过滤（跨空间混入 2≠1）、去掉零填充（daily.length 0≠7）、`estimated` 过滤置空（0≠2）。

**4-T2 前端**
- 新增 `apps/workbench-web/src/components/WorkspaceUsageDialog.vue`（7/30 天切换、合计行、每日明细、骨架/空/错误+重试、可访问名称、无金额）与三组用例（`WorkspaceDetailView.usage.test.ts` 15、`WorkspaceUsageDialog.test.ts` 10、`WorkspaceInfoPanel.usage.test.ts` 8）；`WorkspaceInfoPanel.vue` 新增纯展示区块；`WorkspaceDetailView.vue` 宿主接线 + 角色门禁 + 世代号；客户端 `listWorkspaceUsage` 与 DTO。
- 右栏顺序固定为：成员 → Agent → 空间用量 → 最近动态 → 空间设置（仅负责人）。
- **实现代理的反证**：角色门禁恒真（4 红）、世代号恒真（2 红）、重试置空（2 红）、估算说明无条件渲染（3 红）、弹窗切 range 不重取（2 红）、失败吞成全零（3 红）。

## 7. 两轮评审与修复（2026-09-12）

- **结论**：规格符合性评审 **符合**（0 个功能确认缺陷，3 suspicion + 4 nit）；对抗性质量评审 **PASS with required fixes**（1 × P1 + 3 × P2 + 1 时间语义观察）。两轮独立复现了同一批问题（查询形状、角色回退、`standalone`）。
- **P1 / S3（已修）聚合查询全表扫描**：原形状「日序列 → 全空间会话 → 全 Run → 按日过滤事件」对整个租户的 `model_usage_events` 做顺序扫描并哈希溢写；评审实测 16.36 万行时 exec **130–180ms**、`Seq Scan`、`Batches: 8`、`temp written`，且与本空间事件数无关（只与租户总量有关）。修复为重写形状后，父代理用 `EXPLAIN (ANALYZE, BUFFERS)` 在同规模数据上实测：**同一窗口 5.6ms**、走 `Index Scan using model_usage_by_run`、结果与旧形状逐行一致（`identical(old,new)=true`）。
- **P2-1（已修）读接口写副作用**：`workspaceId='standalone'` 被 `normalizeWorkspaceId` 归一为 null，`resolveReadableWorkspace` 随即 `ensurePersonalWorkspace()` **建库**，接口仍返回 422——即一个 GET 凭空创建了调用者的个人空间。修复：4-T1 与 **3-T7 的动态接口**都显式拒绝该哨兵（`if (!workspaceId || workspaceId === 'standalone')` 422）。两个套件各加判别性用例（临时停用 `users_personal_workspace_provisioning` 触发器构造「没有个人空间」的调用者，断言请求后仍为 0），**反证**：去掉哨兵判定即红（实测「不得触发个人空间创建」失败）。
- **P2-2 / N3（已修）用量门禁回退到姓名推断**：名册失败时 `currentUserRole` 会回退到「负责人姓名 == 登录者姓名 ⇒ owner」，于是同名成员仍会渲染区块并发一次注定 403 的请求。修复：用量只认**服务端**角色（父组件显式传入的 `currentUserRole` 或名册返回的 `currentUserRole`），不回退。新增判别性用例（名册失败 + 负责人姓名与登录者同名 ⇒ 零请求），**反证**：改回 `currentUserRole` 即红（实测 `listWorkspaceUsage` 被调用 1 次）。既有「服务端确认 owner 时用量弹窗挂载」的断言改挂到转交后的新负责人用例上。
- **S1（已修）`callCount` 与分项可能对不上**：`0004` 的 CHECK 允许 `blocked`（当前无写入者），原实现 `callCount=count(*)` 会把将来出现的第三状态计成「调用」却不计入成功/失败。修复：事件集合收窄为 `status in ('success','failed')`，保证 `callCount === success + failed`、`estimatedCount ≤ callCount`；新增用例（插入一条 `blocked` 行断言其既不计调用也不计 token），**反证**：去掉状态过滤即红。
- **S2（已修）角色拒绝依赖中文文案匹配**：`requireTeamRole` 角色不足时原先抛裸 `Error`，HTTP 会分类成 **500**，调用方只能匹配消息前缀。修复：把类型化下沉到授权服务本身（`authorizationDenied(...)`，**消息文本不变**，因此 `workspace-member-routes.ts` 的既有判定与所有既有断言不受影响），用量服务的文本匹配随之删除。回归：members 36/36、agent-members 19/19、sessions 6/6、security 4/4、lifecycle 20/20 全绿。
- **P2-3（记录，不修）JSON 数值精度**：token 为 JSON 整数，极端值（> 2^53-1）不具备精确表示。已在 OpenAPI 描述与代码注释中写明「实际不可达」，不改契约为字符串（会让前端所有计数与合计改用 BigInt，代价大于收益）。
- **P2-4（记录，不修）`model_usage_events` 缺每 attempt 唯一约束**：每 attempt 唯一性只靠写入端确定性 id（`usage-<attemptId>` + `on conflict do nothing`）。补 `(tenant_id, attempt_id)` 唯一索引需要新迁移且属平台表治理，本批明确不做（已记入 §8 已知项）。
- **N1（豁免，已记录）原生 `<table>`**：用量详情用语义化表格（列头 + 行列关系对屏幕阅读器更友好），与设计 §1 基准「不引入原生 `<table>`」冲突，已在设计 §2.10 记为**一次性豁免**（全仓唯一）。
- **N2（已修）OpenAPI `$ref` 兄弟字段**：`403`/`422` 改回裸 `$ref`，逐状态说明并入 operation description（与文件其余 58 处一致）。
- **N4（已修）面板重复「近 7 天」**：删除区块副标题里的重复文案，只保留摘要句。
- **命名（已修）**：`WorkspaceUsageView.test.ts` 实际挂载的是 `WorkspaceDetailView`，改名为 `WorkspaceDetailView.usage.test.ts`。
- **时间语义（观察，已记录）**：按日分桶依赖数据库会话时区（与既有管理端用量页同口径）；中国区「今天」最多偏移 8 小时，需要本地日界时应另行引入时区来源。已写入设计 §2.10 与 OpenAPI 描述。
- **fix round 后的复审（两位评审都在最终提交上复跑）**：规格符合性评审修订为 **符合**（首轮 3 suspicion + 4 nit 全部修复或如实豁免，无新增回归）；对抗性质量评审的 P1 在最终版本上复测通过（usage 套件 2003ms → 802ms，逐日数值一致）。`standalone` 无写副作用、`callCount === success + failed`、前端同名场景零请求、类型化 403 承重——均由评审用独立探针复核。
- **接受的一条低风险观察（不改）**：`assertUsageRole` 把 `requireTeamRole` 抛出的任何 403 都重打成「仅负责人或管理员可以查看空间用量」（该文案由集成用例钉住）。理论上「两次查询之间成员被移除」的竞争拒绝也会显示成角色不足；但 `assertReadableTeamWorkspace` 已先解析成员资格，实际不可达，且 status/code 仍为 403 `permission_denied`。若改回按消息区分两类拒绝，反而要重新引入文案匹配（正是 S2 修掉的坏味道），故保留现状并记录。
- **提交与 CI（2026-09-12）**：`de7d247`（`feat(server),feat(workbench-web),docs: 空间用量（TW-09 / 批次 4）`）已推送 `main`，CI `M6 quality gate`（run `34676010309`）通过。
- **工作树提醒**：本批提交全部按路径暂存；工作树另有**与本批无关**的改动——`docs/index/README.md`(M) 与未跟踪的 `docs/design/skill-installation-plan.md`（Skill 安装产品方案，属另一条工作流），未纳入本批提交，也未删除。

## 8. 已知项（记录，不阻断）

- `model_usage_events` 无 `(tenant_id, attempt_id)` 唯一约束（§7 P2-4）。
- 日界依赖数据库会话时区（§7 时间语义）。
- token 极端值超出 JSON 安全整数范围（§7 P2-3）。
- 用量详情的原生表格豁免（§7 N1）。
- 本机 `pnpm test:e2e` 仍受 OIDC 允许来源限制（非缺陷），真实浏览器联调未做；批次 4 的覆盖是集成 + 前端用例。

## 9. 回归（修复后）

- `test:m5:usage:integration` **13/13**、`test:m5:activity:integration` **22/22**、`test:m5:members:integration` 36/36、`test:m5:agent-members:integration` 19/19、`test:m5:sessions:integration` 6/6、`test:m5:lifecycle:integration` 20/20、`test:m5:security:integration` 4/4、`test:m5:shared-files:integration` 15/15、`test:m5:file-versions:integration` 18/18、`test:m5:workspace:upgrade:integration` 4/4。
- `pnpm test:m5:frontend`：workbench **24 files / 267 tests**、admin **6 files / 18 tests**。
- `pnpm verify`、`pnpm typecheck`、`pnpm lint` 全部通过。
- **一次不可复现的前端失败（如实记录）**：修复轮中有一轮 `pnpm test:m5:frontend` 与 `pnpm lint`、服务端集成套件并发执行时出现 1 例失败（未捕获用例名），随后**连续 8 次单独运行均 267/267 全绿**，无法复现。判断为 CPU 争用下的时序抖动（`WorkspaceMemberDialog` 的 20 个异步用例单个约 0.3–1s，属既有套件），非本批引入；CI 质量门中前端套件独立执行。若后续在 CI 上复现，需按 flake 单独排查。

## 10. 真实 DSH 端到端（4-T3，2026-09-12）

**运行命令（本机，真实 DSH 检出 `legacy-0.1.1-rc.2` 兼容档；生产档不接受兼容模式）**

```bash
DSH_WORK_TEST_DATABASE_URL='postgres://dsh_work:change-me@127.0.0.1:15433/postgres' \
DSH_RUNTIME_HOME=/Users/max/projects/deepseek-harness \
DSH_RUNTIME_COMPATIBILITY=legacy-0.1.1-rc.2 \
DSH_EXPECTED_VERSION=0.1.1-rc.2 \
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
node --experimental-strip-types scripts/runtime/team-workspace-e2e.ts
```

**结果：连续多次运行 `ok: true`**（修复轮后父代理 2 次、两位评审各 2 次；每次在一次性库上跑 3 个真实 DSH Run，同一台机器实测耗时 **26s–82s**，被强制的 240s 超时用例约 277s——不要把耗时写成固定区间）。

| 段 | 实测证据 |
| --- | --- |
| TW-07（3-T6/3-T9） | 上传 v2（说明「e2e 第二版：更新库存数字」）后 `current = v2`、空间列表展示 `versionNo=2`；坏 `.docx` 被拒（`ZIP_STRUCTURE_INVALID：Office 文件不是有效的 ZIP 容器`）但**记录保留**为 v3 且 `parseStatus=failed`、`current` 仍为 v2；引用 **v1 不可变对象**的真实 DSH 运行 `succeeded` 且只回显 v1 标记（未泄露 v2 标记）——该运行现在跑在**独立新会话**里（此前复用第一个会话，历史里已有回显 marker 的助手消息，`includes(marker)` 可能来自回忆而不是读文件；评审实测把 `fileIds` 置空仍能回显）；`run_input_files → workspace_file_versions` 反查得 `version_no = 1` |
| TW-08（3-T7/3-T8） | 泄露搜索词覆盖两版标记、文件名、正文、**更新说明**与**失败版本文件名**；真实业务动作产生动态：`member_added`（两名成员各一条）、`role_changed`、`file_uploaded`、`file_version_added`、`agent_member_added`，移除后 `member_removed`；**同一角色重复变更只留 1 条 `role_changed`**（幂等）；`safe_metadata` 与响应中不含标记/文件名/正文（泄露检查为空）；通知未读 7 → 静音后未读 0 但**条目仍 7 条可见** → 标记已读写入 `lastReadAt` → 取消静音；被移除成员读动态、按旧 id 点击、读通知列表**三种路径全部被拒** |
| 归档（3-T4 复核） | 走真实归档服务：读取轨（运行详情/事件/会话/文件/动态/用量）对现任成员全部可读，且动态中含 `workspace_archived`——**这四项现在都进入 `ok`**（此前只有运行详情/事件被判定，评审实测「删掉 `workspace_archived` 的活动写入后 `ok` 仍为 true」）；执行轨新运行被拒、`activeRunsAfterDeny = 0` |
| 空间用量（批次 4） | 3 个真实 DSH Run 产生实测 `callCount=3`、`success=3`、`failed=0`、`estimated=0`（DSH 上报真实 token，非平台估算）；token 数随真实模型输出浮动（一次样例 `input=682/output=515/total=1197`，另几次 1061/1091 等，**不要当成可复现值**）；`daily` 长度 7、当日桶 3；与 `model_usage_events` **同谓词**交叉核对（含状态过滤与时间窗）计数与 token 双项一致；显式插入一条 `blocked` 样本证明第三状态不计入；插入另一空间同负责人的 500 万 token 事件证明**跨空间隔离**；`range=30d` 返回 30 个日桶且计数不变；管理员同值可读；成员类型化 403；个人空间 422；**归档后仍可读** |

**如实记录的两点**：
- 开发过程中我第一版断言写错了一次（在移除成员**之前**取动态快照却断言含 `member_removed`），实测 `ok: false` 暴露后修正为移除后再取一次快照——这正是该脚本的价值：断言错误会让 `ok` 变 false，而不是静默放过。
- `estimatedCount` 在真实 DSH 下为 0（运行时会回报 token 用量），因此前端「其中 N 次为估算值」提示在本环境不会出现；该提示仍保留以覆盖 DSH 未回报用量的情况。

## 11. 4-T3 两轮评审与修复（2026-09-12）

**结论**：规格符合性评审 **有条件符合**（0 个功能确认缺陷，1 个可误判缺口 + 3 个文档/断言精度问题，全 Low）；对抗性质量评审 **PASS with required fixes**（2 × P1 + 4 × P2）。两位评审都独立实跑脚本（各 2 次 `ok: true`）并做了证伪。

**已修（每条都经过削弱→变红→还原或信号实测）**

| 发现 | 修复 | 验证 |
| --- | --- | --- |
| **P1 信号不安全**：`SIGINT`/`SIGTERM` 下 Node 不执行 `finally`，实测遗留 `dsh_work_e2e_*` 库、临时目录与孤儿 DSH 子进程 | 抽出幂等 `cleanup()` 并注册 `SIGINT`(130)/`SIGTERM`(143) 处理器，等清理完成再退出 | 父代理实测：`SIGTERM` → 退出码 143、无遗留库/临时目录/DSH 子进程；`SIGINT` → 130、同样干净；处理器日志各出现 1 次 |
| **P1 `ok` 未 gate 归档读取轨**：删掉 `workspace_archived` 的活动写入后 `ok` 仍为 true | 把 `sessionsListable`/`filesListable`/`activityReadable`/`activityIncludesArchived` 纳入总判定，并输出 `archivedWorkspace.ok` | 新增判定后两次运行 `archive=true` |
| **P2 固定版本断言被会话历史污染**（规格 F1）：`getTask` 返回整段会话消息，且 `mapMessage` 不带 `runId`，无法按 Run 过滤 | 固定版本运行改用**独立新会话**，让 `includes(marker)` 只能来自文件 | 评审证伪：把 `fileIds` 换成 v2 或置空即可让 `trace`/`leakedV2Marker` 翻红；`trace.versionNo===1` 一直是承重断言 |
| **P2 泄露检查覆盖不足**（规格 F2）：更新说明与失败版文件名不是搜索词 | 搜索词补 `e2e-broken.docx` 与「e2e 第二版：更新库存数字」 | 评审证伪：注入含文件名的 `safe_metadata` 即 `leaks=['e2e-inventory.md']`、`tw08=false` |
| **P2 收权检查接受任意异常**：`.then(()=>false,()=>true)` 会把 500/连接错误当成拒绝 | 新增 `deniedWith403()`，只认 `status === 403` | 与用量段的 403/422 判定口径一致（静态修正） |
| **P2 用量交叉核对无判别力**（规格 F3）：与服务同谓词但缺时间窗、无第二空间、无第三状态、只跑 7d | 交叉核对补时间窗与 token 双项；显式插入 `blocked` 样本；插入另一空间同负责人的 500 万 token 事件；补 `30d` 断言 | 两次运行 `usage=true`；评审证实「不加 `blocked` 样本时删掉状态过滤仍 `ok=true`」（该行为由集成套件 `team-workspace-usage-api.integration.test.ts` 覆盖） |
| **P2 无非生产库护栏**：指向生产库时会用生产凭据 create/drop 数据库 | 仅允许 `localhost`/`127.0.0.1`/`::1`，否则拒绝（可用 `DSH_WORK_E2E_ALLOW_REMOTE_DATABASE=1` 显式放行） | 静态修正；数据隔离本身也已确认只创建/删除 `dsh_work_e2e_*` |
| **P2/nit 文档数字**：`约 3–5 分钟` 与固定 token 值不成立 | 改为实测区间 26s–82s（超时用例 277s），token 明确标注为「一次样例、随真实输出浮动」 | 父代理与两位评审的实测值并列记录 |

**如实记录的边界（评审未能验证 / 本 e2e 不覆盖）**

- **AC-13「文件移除阻止新引用」**、**AC-15「不显示私有对话」**、**AC-30「不展示金额/估算值明示」** 不在本 e2e 内，由集成与前端套件覆盖；§3 的验收描述已按此收紧。
- 幂等断言证明的是「同一角色重复变更只留一行」，走的是成员服务的**状态守卫早退**，不是 `(tenant, workspace, dedupe_key)` 的冲突路径。
- `estimatedCount` 在真实 DSH 下恒为 0（运行时会回报 token），「估算值」提示在本环境不会出现；该分支由集成套件的 `estimated` 行覆盖。
- `resolveDshRuntimeInstallation` 会把生成的 ACP 覆盖层写到 `<repo>/.runtime/dsh-config/`（gitignore、既有行为），不在 `mkdtemp` 临时根内；attempts/storage/session 快照仍在临时根内。
- `scripts/` 不参与 `pnpm typecheck`（只有 lint 覆盖），与本脚本「环境验证」的定位一致。
- **与 4-T3 无关但需知会**：`pnpm test:scripts` 在当前工作树上失败，原因是**并行的那条工作流**新增的未跟踪文档 `docs/design/skill-installation-plan.md`、`docs/design/admin-assistant-plan.md` 里的链接指向尚未落盘的文件（`scripts/checks/checks.test.mjs` 的文档链接白名单检查）；只叠加本任务两个文件时 `test:scripts` 20/20 通过。
