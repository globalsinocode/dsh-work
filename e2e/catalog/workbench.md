# 个人工作台

对话、成果、结果核验、Skill 广场与 AI 同事目录、跨轮成果延续。证据层级与写法见[验收目录索引](../TEST-CATALOG.md)。

### ART-E2E-01 HTML 成果沙箱预览

**优先级：** P0
**角色：** 员工（冒烟测试身份）
**前置数据：** `ws-supply` 团队空间包含一个 `html` 类型成果（`华东区交付风险看板.html`）及既有 xlsx/pdf 成果
**spec：** `e2e/mvp-smoke.spec.ts`

1. 进入 `/workspaces/ws-supply?tab=artifacts`，验证 HTML 成果卡片可见且提供「预览」入口，xlsx/pdf 卡片不提供「预览」。
2. 点击「预览」，对话框在 `sandbox="allow-scripts"` 的 iframe（opaque origin，无 `allow-same-origin`）中渲染 HTML 内容。
3. 切换「源代码」视图查看原始标记，关闭对话框。

**验收：** 预览内容与成果文件一致；iframe 不带 `allow-same-origin`，页面脚本不能访问工作台 Cookie/DOM；加载失败就地报错可重试；下载仍走鉴权附件通道。本层只证明页面与沙箱隔离，不证明 PostgreSQL 成果发布。

### I06-E2E-01 员工对话结果核验（I-06 任务结果外层）

**优先级：** P1
**角色：** 员工（受控测试身份）
**运行层级：** P1 集成用户旅程（专用可丢弃 PostgreSQL + 合成 Runtime；P0 不可达：Prototype 无会话持久化与真实结果投影）
**前置数据：** `personalWorkbenchFixture` 一次性库；合成 Runtime 对标记 prompt `P1-成果缺口` 声明 2 个成果但不登记；`P1-成果达成` 标记由启动脚本钩子在 run.completed 前登记真实成果行（含 `source_attempt_id`）
**spec：** `e2e/personal-integration/task-result.spec.ts`

1. 员工发送含 `P1-成果达成` 标记的任务：受控运行完成且成果已登记后，回答卡显示业务核验状态「目标已达成」而不是仅执行完成；「对话详情」抽屉的「结果核验」区展示回答与成果登记回执及遥测（登记成果数）。
2. `GET /api/workbench/v1/runs/{runId}/result` 返回 `task-result/v1`：`execution` 为 Run 终态、`outcome` 为 `achieved`、含 answer 与 artifact 回执。
3. 员工发送普通任务（仅回答、无可核验交付物）：执行终态仍为成功，消息流不展示「结果待核验」警示且不出现「目标已达成」；结果接口继续返回 `outcome=unverified`，`pendingItems` 含 `no_verified_deliverable`，详细核验信息仅在用户主动打开「对话详情」时展示。
4. 员工发送含 `P1-成果缺口` 标记的任务：执行终态仍为成功，消息流不展示「结果待核验」警示且不出现「目标已达成」；结果接口继续返回 `outcome=unverified`、回执含 `missing`，用户可在「对话详情」查看成果登记缺口。
5. 历史中由平台直接登记的旧 Run（无 Attempt 事件与回答登记）打开后同样按证据核验展示，不由 `succeeded` 推断达成。

**验收：** 执行状态与业务结果状态仍独立建模；模型自述不构成核验依据；普通问答及外部业务结果缺少登记证据时不在消息流展示待核验警示，核验详情按需查看；结果接口与详情保持同一授权边界。

### I06-E2E-02 自动任务执行记录的业务结果（I-06）

**优先级：** P1
**角色：** 员工（自动任务 owner）
**运行层级：** P1 集成用户旅程（P0 下自动任务 API 为 503/空集合，不可达）
**前置数据：** 专用可丢弃 PostgreSQL；一条已启用自动任务与至少两条执行记录（受理中 queued、受理并完成）
**spec：** `e2e/personal-integration/task-result.spec.ts`（计划）；服务端口径由 `automation.integration.test.ts` 固化

1. 打开自动任务「执行记录」抽屉：受理/执行列与「业务结果」列分列展示。
2. 已受理但 Run 未终结的执行显示「结果生成中」；未受理记录业务结果为「—」。
3. Run 完成的执行按 `task-result/v1` outcome 显示「目标已达成／结果待核验／目标未达成」。

**验收：** 受理（admission）、执行（runStatus）、业务结果（resultOutcome）三层状态独立呈现；受理或执行成功均不直接显示为业务达成。

- 负责人经「管理成员」管理员工、调整角色并验证收权；经右栏 Agent 区块「管理 Agent」独立入口管理 Agent 成员（P1，需多角色测试身份）。
- 上传文件、上传新版本、失败版本保留且旧版本仍可引用（P1）。
- 归档后历史读取仍可用、新对话/上传/重试被拒（P1）。
- 真实 DSH 双账号上传共享文件、引用执行、收权和归档验收（P2，复用 `scripts/runtime/team-workspace-e2e.ts`，已通过）。

P1/P2 的执行结果须单独记录数据库、身份、Runtime/DSH 版本和实际账号；没有这些证据时只能报告 P0 Prototype 浏览器结果。

## 个人工作闭环（B3/B4/B5/D12，2026-09-18）

### EMP-CATALOG-01 员工 Skill 广场与 AI 同事目录

**优先级：** P0

**角色：** 普通员工

**运行层级：** P0 原型浏览器冒烟（内存合成、员工安全字段）

**前置数据：** 至少一个当前员工可见的已发布 Skill，以及至少一个当前员工角色可用、执行身份有效的已发布 Agent

**操作步骤：**

1. 从员工主导航进入「Skill 广场」，按分类查看卡片并选择一个 Skill。
2. 回到新对话后确认所选 Skill 名称与推荐提问可见，且员工端不出现安装、版本发布或配置入口。
3. 从员工主导航进入「AI 同事」，查看可用 Agent 卡片并选择一位同事。
4. 回到新对话后确认所选 AI 同事以可移除的胶囊项显示在对话框操作区，名称与开场提示可见；发起对话时沿用既有 Run/Attempt → Runtime Adapter → DSH 链路。
5. 在窄屏下重复打开导航和两个目录页，筛选、卡片、空态与错误重试不溢出且具备可访问名称。

**可观察结果：** 工作模式主导航依次保留「新对话、Skill 广场、AI 同事、项目空间、定时任务」（S5a 起“自动任务”改称“定时任务”；协作模式见 MODE-E2E-03）；目录只展示服务端按当前员工授权返回的已发布对象。卡片选择只负责预选已有 Skill/Agent，不赋予员工上传、安装、编辑、发布或调整能力依赖的权限。

**spec：** `e2e/personal-workbench.spec.ts`

- **P0 原型导航**，普通员工，内存合成资料：工作模式主导航只显示新对话、Skill 广场、AI 同事、项目空间和定时任务；历史对话与我的文件保留上下文入口及直达路由，不显示为主导航项。个人空间不作为可管理卡片或选择器，旧个人链接继续解析到本人资源入口。对应 `e2e/personal-workbench.spec.ts`。原型不承诺持久化或真实执行。
- **P1 集成工作闭环**，有效员工 A 与 B，独立可丢弃 PostgreSQL + 受控身份、无真实模型：准备 A 的 60+ 轮旧会话、空会话、个人材料、会话附件、生成成果及一个已撤权团队。通过页面搜索并恢复旧对话；上传和引用文件；下载并逻辑移除；对话移除后成果保留、来源标记已移除。B 和失权团队数据不得返回。对应 `e2e/personal-integration/closure.spec.ts` 与服务器 `review-b3/b4/b5` 集成套件；页面的 API 模拟测试只证明交互，不代替这些真实 PostgreSQL 测试。
- **P1 归属与竞态**：团队页面发起明确团队任务；随后全局新对话仍属个人，默认个人解析失败不得回退团队；切换用户/筛选后迟到响应不得恢复旧内容。对话/资源恢复不改变 Workspace 归属。
- **P2 真实验收**：上述闭环追加真实 OIDC、DSH 与企业扫描及成果质量检查，单独留证，本轮未运行不得标记业务验收通过。

**本批实际执行记录：** P1 使用专用 PostgreSQL、受控 HTTP 与合成 Runtime，不使用页面 API 拦截。浏览器预演和首条 Playwright 均因容器 Chromium URL 管理策略报 `ERR_BLOCKED_BY_ADMINISTRATOR`；其他浏览器用例未运行，未宣称浏览器通过。组件/Store 和真实数据库 HTTP 回归已单独通过；详见 `docs/development/review-d12-evidence.md`。

## EX-02 跨轮成果延续

### EX-TOOL-01 工具调用结果在执行步骤中可见

**优先级：** P1 · **角色：** 员工 · **运行层级：** 一次性 PostgreSQL、Mock ACP Worker、平台工具桥<br>
**前置数据：** 一次 Run 中有成功、失败和未返回结果的工具调用<br>
**spec：** `server/src/modules/runtime/tool-call-summary.test.ts`、`server/src/modules/runtime/platform-tool-bridge.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`、`apps/workbench-web/src/stores/tasks.test.ts`、`apps/workbench-web/src/views/ConversationView.test.ts`

1. Attempt 成功结束时，每次工具调用按顺序产生一条 `tool.completed` 事件，均在 `run.completed` 之前；`run.completed` 带工具调用总数和失败数。
2. Attempt 失败时，已发生的工具调用仍在 `run.failed` 之前登记。
3. 平台工具失败显示与错误码对应的固定原因（如“调用参数不符合工具要求”“已达到本次执行的工具调用次数上限”）；未知错误码和内置工具失败显示“工具返回失败”；无结果记录显示“未收到调用结果”。
4. 事件不含工具参数和输出内容。
5. 工作台执行步骤逐条显示工具名与结果，失败步骤为失败状态；结果核验显示“工具调用 N（失败 M，原因见执行步骤）”。
6. **实时（2026-10-17）：** DSH 在执行中发出 ACP `tool_call`/`tool_call_update` 时，平台随即产生 `tool.started`（“正在调用”）与带 `live: true` 的 `tool.completed`，同一 `call_id` 在执行步骤中只占一行并原地更新；“正在处理”提示显示“正在调用 工具名”。结束时按会话日志补齐未实时完成的调用，已实时完成的不重复；`run.completed` 的总数与失败数不变。本轮结束仍无结果的“正在调用”显示为“未收到调用结果”。

**验收：** 上述测试通过；P2 另需在目标环境用真实 DSH 让 Agent 读取一个不存在的文件，确认执行步骤出现失败的工具调用、任务本身仍可完成，并留证 Run/Attempt 与 DSH 版本。实时部分另需确认：执行过程中（而非结束后）出现“正在调用 read”，随后原地变为失败，最终每个调用只有一行。

**本地 P2（2026-10-16）：** 已通过。真实 `read` 失败 1 次，步骤和失败计数可见，`tool.completed` 早于 `run.completed`，Run 为 `succeeded`。服务基线、Run/Attempt、DSH 精确版本与截图见验收记录（Git 历史：提交 `9521be2` 的 `docs/development/runtime-execution-local-p2-2026-10-16.json`）；未覆盖目标部署环境及 ACP 实时通知。

### EX-ARTIFACT-01 引用上一轮成果并产生新版本

**优先级：** P1 · **角色：** 员工（成果发起人）、同空间外的另一员工 · **运行层级：** 一次性 PostgreSQL、受控 Runtime、Manifest 编译器与前端组件<br>
**前置数据：** 个人或团队会话中一次成功 Run 已登记的 Markdown、文本、CSV 或 HTML 成果<br>
**spec：** `server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/modules/runtime/runtime-manifest-schema.test.ts`、`apps/workbench-web/src/views/ConversationView.test.ts`

1. 成果发布时保存原文文本作为解析结果；回答下方的成果卡片对可引用成果显示“继续修改”，点击后成果以“名称 · V版本”标签出现在输入框上方，可移除；不可引用（非 UTF-8、空文件或超长）的成果不显示该入口。
2. 发送下一条消息时，成果按既有附件权限重新校验后只读挂载；Manifest 的挂载项带 `artifact_revision`，Runtime 说明提示“修改时写回同名文件，登记为下一版”。
3. 本轮挂载了同会话成果且输出同名文件时，登记为该成果的下一版本；未引用或同名指向多个成果时作为新成果。旧版本保持可下载。
4. 另一员工不能把他人成果挂进自己的会话；团队会话中未 @Agent 的讨论消息不能携带引用成果。

**验收：** 两轮后同一成果有 V1、V2，两版下载内容分别为原文与修改后内容；附带的新文件是独立成果；跨用户引用被拒绝。P2 另需在目标环境用真实 DSH 完成“第一轮生成 Markdown/CSV、第二轮修改指定部分”，下载两版核对差异，并留证 Run/Attempt 与 DSH 版本。

**本地 P2（2026-10-16）：** 已通过两轮 Markdown 修改。V1 按 `artifact_revision` 只读挂载，输入权限为 `0400`；同名成果登记 V2，仅改指定行，附录为独立 V1。V2 完成后重新下载 V1 与原文一致。服务基线、Run/Attempt、成果 ID、SHA-256 与截图见验收记录（Git 历史：提交 `9521be2` 的 `docs/development/runtime-execution-local-p2-2026-10-16.json`）；跨用户拒绝仍以既有 P1 证据为准，本次未复跑。

### EX-CONTEXT-01 长对话保留首条约束并使用对话摘要

**优先级：** P1 · **角色：** 员工 · **运行层级：** 一次性 PostgreSQL、受控 Runtime、Manifest 编译器<br>
**前置数据：** 一个个人会话，较早消息合计超过 64000 字符，首条消息写明目标与约束<br>
**spec：** `server/src/domain/conversation-context.test.ts`、`server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`、`server/src/modules/runtime/runtime-manifest-schema.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`

1. 摘要尚未生成时，新一轮的历史保留首条消息原文与最新消息，合计不超过 64000 字符，中间较早的消息被裁掉，员工端没有任何提示。
2. 该轮结束后后台生成一次摘要：`session-summary` 运行没有 Session、不带工具，首条消息不进入摘要输入，摘要回答不写入会话消息。
3. 下一轮的 Manifest 带首条消息原文、摘要和摘要之后的最近消息；已被摘要覆盖的消息不再以原文带入。
4. 摘要失败、DSH 不可用或会话被移除时，下一轮退回步骤 1 的裁剪，任务正常执行。

**验收：** 上述测试通过；P2 另需用真实 DSH 跑一段超过 48000 字符的会话，确认摘要生成，并在第 20 轮之后首条消息与中间轮次给出的约束仍被遵守，留证 Run/Attempt、摘要内容与 DSH 版本。

**本地 P2（2026-10-16）：** 已通过。基于 `8d63f23`，真实 DSH `0.1.2-rc.1` / `76fda729799fe9b3848dbe2c211d4b231032b81e` 完成 22 轮、72,108 字符合成会话。原文达到 49,152 字符后后台生成摘要，最终保存两次增量摘要（872/899 字符，覆盖 14/27 条消息）；摘要 Run 无 Session、工具、文件或聊天消息。后续 Manifest 保留首条原文且历史与摘要合计不超过 64000 字符；第 21 轮的中间配置仅在摘要中，第 21、22 轮均正确遵守首条与中间约束。完整 Run/Attempt、摘要原文、哈希和截图见验收记录（Git 历史：提交 `e05baa4` 的 `docs/development/runtime-context-baseline-local-p2-2026-10-16.json`）。本次没有注入摘要失败或复跑团队、多账号权限与生产环境。
