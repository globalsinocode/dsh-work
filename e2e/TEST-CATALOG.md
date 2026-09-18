# 团队工作空间 E2E 验收目录

这里记录面向用户的关键旅程。测试代码在页面交互稳定、通过浏览器预演后再固化；本目录中的“通过”必须注明运行层级，不能把 Prototype 冒烟当成真实 DSH、OIDC 或生产权限验收。

## 环境与证据层级

| 层级 | 环境 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| P0 | Prototype 身份、内存合成数据、Playwright Chromium | 页面启动、路由、核心展示与基本交互 | PostgreSQL 持久化、真实 DSH、OIDC、多账号授权 |
| P1 | 专用可丢弃 PostgreSQL、受控测试身份与 Runtime/Worker | 团队空间读写、版本、失败和权限契约 | 生产身份、企业连接器和生产容量 |
| P2 | 真实 DSH Run/Attempt、Runtime Adapter、OIDC 与多账号 | 真实执行、收权和目标环境验收 | 未实际执行的环境或未覆盖的角色 |

## P0 浏览器旅程

### TW-E2E-01 团队空间导航与资源查看

**优先级：** P0
**角色：** 员工（Prototype 受控身份）
**前置数据：** `ws-supply` 团队空间，包含两个共享文件及团队成果
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开 `/workspaces`，选择“供应链经营分析”。
2. 验证“对话”“共享文件”“成果”三个工作空间页签可见。
3. 进入“共享文件”，验证两个合成文件名称和“引用到对话”入口。
4. 进入“成果”，验证团队成果名称可见。

**验收：** 当前空间 URL 正确；对应页签处于选中状态；文件和成果内容没有串到其他空间。

### ART-E2E-01 HTML 成果沙箱预览

**优先级：** P0
**角色：** 员工（Prototype 受控身份）
**前置数据：** `ws-supply` 团队空间包含一个 `html` 类型成果（`华东区交付风险看板.html`）及既有 xlsx/pdf 成果
**spec：** `e2e/mvp-smoke.spec.ts`

1. 进入 `/workspaces/ws-supply?tab=artifacts`，验证 HTML 成果卡片可见且提供「预览」入口，xlsx/pdf 卡片不提供「预览」。
2. 点击「预览」，对话框在 `sandbox="allow-scripts"` 的 iframe（opaque origin，无 `allow-same-origin`）中渲染 HTML 内容。
3. 切换「源代码」视图查看原始标记，关闭对话框。

**验收：** 预览内容与成果文件一致；iframe 不带 `allow-same-origin`，页面脚本不能访问工作台 Cookie/DOM；加载失败就地报错可重试；下载仍走鉴权附件通道。本层只证明页面与沙箱隔离，不证明 PostgreSQL 成果发布。

### TW-E2E-02 管理端冒烟（现有基线）

**优先级：** P0
**角色：** 平台管理员（Prototype 受控身份）
**前置数据：** Prototype 管理端能力与 Runtime 数据
**spec：** `e2e/mvp-smoke.spec.ts`

验证管理端从能力页切换连接器页签并进入 Runtimes 页面，作为团队空间相关管理能力变更的公共导航回归基线。

### ADMIN-E2E-03 管理端用户菜单查看系统信息

**优先级：** P0
**角色：** 平台管理员（Prototype 受控身份）
**运行层级：** P0 浏览器冒烟
**前置数据：** 管理端 Prototype 会话与构建时版本元数据
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开管理端运营概览，点击右上角当前用户下拉菜单。
2. 选择“关于 dsh-work”。
3. 验证关于页面显示系统发布版本、构建 Commit 和 DSH Runtime 信息。

**验收：** 用户无需进入任何治理模块即可查看当前管理端构建身份；显示的系统版本来自构建元数据，Runtime 版本来自锁定配置。

## P1/P2 待补旅程

### TW-E2E-10 团队共享讨论与 @Agent 触发（TW-10）

**优先级：** P1
**角色：** 空间成员（member）、负责人（owner）、只读成员（viewer），各自独立 browser context
**运行层级：** P1 集成用户旅程（P0 不可达：Prototype 模式无会话持久化，命令面 503）
**前置数据：** 专用可丢弃 PostgreSQL；团队空间含 owner/member/viewer 三个测试身份与至少一个可发起的 Agent 成员
**spec：** `e2e/team-discussion.integration.spec.ts`（计划）；API 契约已由 `server/src/http/team-workspace-discussion-api.integration.test.ts` 固化

1. 成员 A 在空间「新对话」直接输入普通消息发送（不 @）：创建讨论会话并出现全员可见的讨论消息，不产生 Run。
2. 成员 B 打开同一会话（历史列表对全员可见）：读到 A 的消息并回帖，消息标注各自发送者。
3. 成员 B 输入 `@` 触发 Agent 成员补全，选择 Agent 后发送：创建 Run 并沿用该成员固定版本，回复进同一消息流且标注「由 B 发起」。
4. viewer 打开同一会话：消息流可读，输入框隐藏并显示只读提示。

**验收：** 无 @ 消息零 Run；@ 触发复用既有 Run/Attempt/Runtime 链路；发送者与触发人归因逐条可见；viewer 写入口不出现；归档空间全部写入口隐藏。

### TW-E2E-11 空间内对话视图（TW-10 导航）

**优先级：** P1
**角色：** 空间成员（member）
**运行层级：** P1 集成用户旅程（P0 不可达：Prototype 模式无会话持久化）
**前置数据：** 专用可丢弃 PostgreSQL；团队空间含至少一个可发起的 Agent 成员与一段历史会话
**spec：** `e2e/team-discussion.integration.spec.ts`（计划，与 TW-E2E-10 同文件）；组件行为由 `WorkspaceDetailView`/`ConversationView` 单测固化

1. 成员在空间页「新对话」发送消息（或 @Agent 触发 Run）：不离开 `/workspaces/:id` 上下文，地址栏进入 `/workspaces/:id/conversations/:target`，空间标题、页签与右栏保持可见。
2. 在对话视图内点「返回」：回到同一空间页的「新对话/历史对话」页签。
3. 「历史对话」打开任一会话：同样落在空间内对话视图。
4. 从空间外入口（工作台最近对话）打开团队会话 `/conversations/:id`：自动跳转到对应 `/workspaces/:id/conversations/:id`，空间外壳完整。
5. 个人空间会话仍使用 `/conversations/:id` 独立页，不发生跳转。

**验收：** 空间内发起/打开团队会话始终停留在空间上下文；返回键回到空间页而非工作台；空间外旧链接可解析但归位到空间 URL；个人空间路径行为不变。

- 负责人经「管理成员」管理员工、调整角色并验证收权；经右栏 Agent 区块「管理 Agent」独立入口管理 Agent 成员（P1，需多角色测试身份）。
- 上传文件、上传新版本、失败版本保留且旧版本仍可引用（P1）。
- 归档后历史读取仍可用、新对话/上传/重试被拒（P1）。
- 真实 DSH 双账号上传共享文件、引用执行、收权和归档验收（P2，复用 `scripts/runtime/team-workspace-e2e.ts`，已通过）。

P1/P2 的执行结果须单独记录数据库、身份、Runtime/DSH 版本和实际账号；没有这些证据时只能报告 P0 Prototype 浏览器结果。

## 管理端受控工具与操作计划旅程

### ADMIN-E2E-01 DSH 工具目录遵守审批能力边界

**优先级：** P1
**角色：** 平台管理员
**运行层级：** 专用可丢弃 PostgreSQL、受控 Runtime 工具目录
**前置数据：** 健康的 DSH 工作区连接器；Runtime 同时报告安全文件工具、`bash` 与未知工具
**spec：** `server/src/infrastructure/postgres/m4-tool-connector-management.integration.test.ts`

1. 打开工具目录并读取 Runtime 实际加载的工具。
2. 添加受 output 目录约束的 `edit`，使用平台固定的无需审批策略。
3. 尝试添加 `bash` 或未知工具。
4. 尝试从权限页把 DSH 内置工具改为其他审批策略。

**验收：** `edit` 可添加并锁定版本；`bash` 明确显示因任意 Shell/逐次审批能力未就绪而不可用；未知工具不可添加；客户端输入不能覆盖平台审批策略；被拒工具不能进入 Agent Runtime 授权闭包。

### ADMIN-E2E-02 管理操作在并发和重启后确定性收敛

**优先级：** P1
**角色：** 平台管理员
**运行层级：** 专用可丢弃 PostgreSQL、受控测试身份与 Mock ACP Worker
**前置数据：** 一个可更新 Agent、一个 Runtime、已成功完成的专用助手 Run
**spec：** `server/src/infrastructure/postgres/admin-skill-installation.integration.test.ts`

1. 生成 Agent 或 Runtime 精确操作计划，在确认前由另一写入改变目标版本。
2. 确认旧计划，观察领域服务在目标行锁内再次校验版本。
3. 将计划模拟为服务退出时的 `executing`：分别保留执行前状态，以及先落地目标写入。
4. 启动恢复并重新读取对话与计划。

**验收：** 旧计划不覆盖新状态；执行前状态收敛为 `failed` 且不自动重试；目标已达到计划后状态时收敛为 `executed`；两种结果都形成持久化对话消息和审计事件。

## 验证记录

### 2026-09-17：轻量自动任务首版（AG-03）

**阶段：** Spec（AG-AUTO-00~24 登记）→ Code → Verify（真实 HTTP 旅程预演）→ Test（P0 冒烟 + 服务端集成固化）
**环境：** 一次性 PostgreSQL（自动销毁）集成测试；OIDC + PostgreSQL 本机服务（4190）做真实 HTTP 旅程；Prototype 做 P0 冒烟

- 服务端：`agent_automations`/`automation_executions` 两表（迁移 0040），触发键唯一、Session/Run 关联唯一索引；`AutomationTriggerSweep` 以 pg advisory lock 保证单一调度所有者；`purpose='automation'` 贯穿 Manifest/Runtime Adapter/成果收集；执行授权 = 当前授权 ∩ 启用时 `scope_ceiling`；OIDC 模式按目录同步新鲜度 fail-closed；受理已提交但无 Attempt 的执行在启动恢复时收敛为 `interrupted`。
- 前端：`/automations` 列表/创建编辑/启停/立即运行/试运行/执行历史抽屉，跳转关联 Conversation；Prototype 下 GET 返回空集合、写操作 503，不伪造数据。

**证据：**

- `automation-calendar.test.ts` 8/8（上海时区、纽约 DST 春缺跳过/秋重取首、manual、weekly、非法时区）；`automation.integration.test.ts` 9/9（创建启用、幂等 run-now、重叠跳过、周期扫描游标、撤权跳过、中断恢复、暂停与越权、暂停收敛排队执行、weekly 规则语义比较）。
- 真实 HTTP 旅程（OIDC 服务）：创建解析 Agent 为固定已发布版本 → 启用生成 next slot 与 scope ceiling → run-now 建 Session/Run → 同幂等键重放返回同一 execution → Run 实际进入 DSH running；第二实例无法取得 advisory lock。
- `e2e/automation-smoke.spec.ts` 2/2（P0）；`pnpm verify`、`pnpm check:architecture`、全仓 typecheck、`validate:ui` 通过。

**未覆盖：** P1 浏览器旅程（AG-AUTO-20~24，`e2e/automation.integration.spec.ts` 计划）；P2 真实验收（AG-AUTO-P2）未运行；管理端 OIDC 身份下的既有 mvp-smoke 2 例受测试环境配置阻塞（跳转真实 AI Hub 登录），与本改动无关。

### 2026-09-18：团队共享讨论与 @Agent 触发（TW-10）

**阶段：** Spec（TW-E2E-10 登记为 P1 计划）→ Code → 服务端集成测试 + 前端组件单测
**环境：** 一次性 PostgreSQL（自动销毁）、受控测试身份与 Runtime 替身

- 服务端：会话写授权上移至编排层（仓储不再做创建者过滤）；讨论消息 `run_id=null` + `sender_user_id` 归因；`POST /sessions/:id/messages`、`GET /sessions/:id`（共享线程含 `currentUserRole`）、`POST /sessions/:id/runs` 支持按 `workspaceAgentMemberId` 选固定版本且必须显式携带幂等键（body 或 Idempotency-Key 头，缺失 422）；共享会话的取消/重试对写轨成员（owner/admin/member）开放、不限发起人，团队重试强制沿用原 Attempt manifest 固定版本；`createAttempt` 恢复文件范围兜底（同会话/同空间/发起人自有会话，跨空间他人附件拒绝）。
- 前端：TaskComposer `@` 补全（键盘导航/选中）；ConversationView 支持零 Run 会话模式与讨论消息分流；归因渲染（发送者/触发人/Agent）；viewer 与归档输入禁用；ConversationStarter 无 @ 时创建讨论会话。

**证据：**

- `team-workspace-discussion-api.integration.test.ts` 5/5；团队会话 6/6；共享文件 18/18；生命周期 20/20；Agent 成员 22/22；收权管线 29/29；编排 12/12；API 契约 12/12。
- `pnpm --filter @dsh-work/workbench-web test`：292/292；`vue-tsc` 与 `eslint` 无告警。
- `playwright test`（P0 Prototype）：8/8 通过（回归基线，Prototype 无会话持久化故不覆盖讨论流本身）。

**未覆盖：** P1 浏览器旅程（TW-E2E-10，待多角色 browser context）；成员级消息实时同步仍靠刷新拉取（SSE 仅覆盖 Run 事件）。

### 2026-09-17：管理端开发接入文档页

**阶段：** Spec（ADMIN-E2E-04）→ Code → Test（P0 Playwright 固化旅程）
**环境：** Prototype 受控身份、内存合成数据、独立端口 4380/4390/4374

- 左侧导航新增「开发接入」组：接入规范（/docs/guide）与接口文档（/docs/api）。
- 接口文档由内置渲染器（`apps/admin-web/src/utils/openapi-doc.ts`）渲染构建期内嵌的 `docs/development/openapi-mobile-h5.json`（移动端实际调用的 Workbench API 子集，带完整 parameters/requestBody/响应 schema），与契约同版本发布；页面按「接口信息表 + 请求/响应报文 + 字段表」展示，左侧接口目录固定。接入规范页提供 Markdown 下载（`docs/development/mobile-integration-guide.md`），接口文档页提供 OpenAPI JSON 下载。

**证据：**

- `pnpm --filter @dsh-work/admin-web test`：71/71 通过；`validate:ui` 通过；`vue-tsc` 通过。
- `playwright test`（含既有 7 条基线）：8/8 通过，含下载事件与文件名断言。

### 2026-09-17：HTML 成果生成与沙箱预览

**阶段：** Spec（ART-E2E-01）→ Code → Verify/Test（P0 Playwright 固化旅程）
**环境：** Prototype 受控身份、内存合成数据、独立端口 4280/4290/4380，未触碰 4174/4180/4190 开发环境

- 服务端：`artifactTypeForExtension` 接受 `.html`/`.htm`（`type: 'html'`，mime `text/html; charset=utf-8`）；成果下载仍走 `Content-Disposition: attachment` + `nosniff`，直接访问下载 URL 不会被浏览器同源渲染。
- Prototype 模式新增 `registerPrototypeArtifactFileRoutes`：仅 `mockArtifactFiles` 登记的种子成果（`artifact-003`）提供确定性字节；Postgres 模式下成果下载仍由 `registerContentRoutes` 经鉴权与读门禁处理。
- 前端：`ArtifactCard` 仅对 `html` 类型显示「预览」；`ArtifactPreviewDialog` 用 `sandbox="allow-scripts"`（无 `allow-same-origin`，opaque origin）iframe 渲染，附「源代码」视图与鉴权下载；预览属读取轨，归档空间与个人空间同样可用。

**证据：**

- `pnpm --filter @dsh-work/workbench-web test`：286/286 通过，含新增 7 个 `ArtifactPreviewDialog` 用例（沙箱属性、源码切换、失败重试、竞态与可访问名称）。
- `pnpm test:m3:integration`（一次性 PostgreSQL，自动销毁）：12/12 通过，含新增「HTML Runtime output is published as a previewable html Artifact」。
- `playwright test e2e/mvp-smoke.spec.ts`：5/5 通过，含新增沙箱预览旅程（frameLocator 断言渲染内容、sandbox 属性与关闭路径）。

**未覆盖：** 真实 DSH 产出 `.html` 的端到端验收（P2）；Prototype 模式下未登记种子的成果仍无内容字节（下载 404 为既有口径）；工作区上传的 `.html` 文件不参与文本提取（`extractDocument` 支持集未变）。

### 2026-09-16：管理端列表分页 P0 冒烟

**阶段：** Verify（浏览器预演）+ 组件逻辑单测
**环境：** Prototype 受控身份、内存合成数据（临时注入 25 条会话用于翻页验证，验证后已还原）、独立端口 4280/4290，未触碰 4180/4190 开发环境

- Session 管理页：第 1 页显示 10 行，分页控件可见；切换到第 2 页表格内容变化（10 行），第 3 页显示剩余 5 行——原假分页已修复。
- 搜索过滤命中 1 条时自动回到第 1 页，分页控件按 `hide-on-single-page` 隐藏。
- 审计页、能力管理页正常渲染；480px 窄视口下分页控件可见且布局未破坏。
- `use-list-pagination` 组合式函数单测覆盖：翻页切片、过滤重置回第 1 页、结果收缩时页码钳制、自定义 pageSize、空列表。
- 控制台仅有 `/assistant/sessions` 503（Prototype 模式下助手依赖 DSH，为既有行为，与本次改动无关）。

**未覆盖：** 嵌套抽屉/工作台内列表的逐页交互仅做了代码审查与单测，未逐一浏览器点击；真实 PostgreSQL 大数据量下的性能属 P1+ 范围（本次为前端分页，数据仍由既有接口全量返回）。

### 2026-09-17：管理端列表服务端分页改造

**阶段：** Code + Verify（P0 浏览器冒烟）+ Test（一次性 PostgreSQL 集成断言）
**范围：** `/sessions`、`/audit-events`、`/model-usage`、新增 `/model-usage/employees` 改为服务端分页（`{items,total,page,pageSize}` + 各端点 summary/facets），过滤参数下沉服务端；`getRunOperations` 行为不变。配置类有界列表（Agent/工作空间/Skill/工具/连接器/Provider/路由/角色/Runtime/权限/对账）维持前端分页。

**PostgreSQL 集成证据（一次性库，自动销毁）：**

- `m4-audit-operations` 新增用例验证：`getSessions` 页大小截断与 trace 查询过滤、`summary`/`facets` 形状；`getAuditEvents` 第 1/2 页不相交且 total 正确、query 过滤收窄；`getModelUsage` status 过滤与 facets；`getModelUsageEmployees` 聚合行。
- `m3`/`m5` 既有用例适配新返回形状后通过。

**P0 浏览器冒烟（Prototype 内存适配器，临时注入 25 条会话后还原）：**

- 网络层确认翻页触发 `?page=2&page_size=10` 服务端请求；关键字/状态/工作空间过滤分别携带 `query=`/`status=` 参数回源。
- 指标卡显示服务端 `summary.total=25` 而非当页行数；搜索命中 1 条自动回第 1 页。
- 模型用量「员工统计」页签请求 `/model-usage/employees` 并渲染聚合行；480px 窄屏分页控件可见。
- `use-paged-list` 组合式函数单测覆盖拉取、换页、重置与错误捕获。

**未覆盖：** 生产规模数据量下的索引与性能、真实 OIDC 会话鉴权路径、P2 验收。

### 2026-09-14：本地 OIDC 只读浏览器预演

**阶段：** Verify（尚不是自动化 Test/Green）
**环境：** 本地 OIDC 已登录会话、当前开发数据；未使用专用可丢弃测试库
**数据保护：** 不记录真实账号、工作空间名称、业务 ID 或正文

- 工作空间列表显示个人空间和两个活动团队空间，可以进入已有团队空间。
- “对话”“共享文件”“成果”三个页签可见，选择状态和 URL 查询参数同步变化。
- 当前空间为无文件、无成果、无本人历史对话的空空间；三个空态及上传入口正常显示。
- 空间信息面板显示 1 位员工、0 个 Agent、近 7 天 0 次调用及暂无团队动态。
- 无可用 Agent 时，新对话区域给出联系负责人的明确提示，发送按钮保持禁用。
- 本轮浏览器控制台未观察到 warning 或 error。

**未覆盖：** 文件上传/版本、成员与 Agent 管理、归档恢复、角色切换和收权、真实 DSH Run/Attempt。由于当前数据为空且不是隔离测试库，本记录只能作为只读浏览器预演证据，不能标记 P1/P2 通过。

### 2026-09-14：一次性 PostgreSQL + 真实 DSH 完整运行

**阶段：** Test/Green（P2）
**命令：** `DSH_WORK_TEST_DATABASE_URL="$DSH_WORK_DATABASE_URL" node --env-file-if-exists=.env --experimental-strip-types scripts/runtime/team-workspace-e2e.ts`
**身份：** 一次性数据库中的合成负责人、成员、管理员和只读成员；不触碰现有业务数据
**Runtime：** DSH `0.1.1-rc.2`，既有 `RunOrchestrationService` → `DshAcpRuntimeAdapter` → ACP 链路；临时数据库、文件根和运行时在退出时清理

- 完整结果 `ok: true`：首次运行、连续对话和固定 v1 文件引用均 `succeeded`，助手正确回显 v1 标记且未泄露 v2。
- 共享文件 v2 成为 current；损坏 docx 版本被拒并保留失败记录，current 不前移，输入文件可追溯到 v1。
- 成员角色变更幂等、动态与通知收权通过；被移除成员读取动态/通知均得到类型化 403。
- 用量聚合与逐行交叉核对一致（3 次成功调用、7517 tokens），跨空间与 blocked 样本隔离，成员 403、个人空间 422。
- 归档后历史运行/事件/会话/文件/动态/用量仍可读；新运行被拒且没有活动运行落库。

本记录证明受控本地 P2 真实 DSH 链路，不等同于真实 OIDC 多账号或生产验收。

### 2026-09-14：已登录浏览器写入型验收

**阶段：** Verify/Test（本地 OIDC，合成测试空间）
**账号：** 当前已登录平台管理员 `max`；未输入或记录密码
**空间：** `E2E 写入验证空间`（本轮新建的专用团队空间）

- 浏览器创建团队空间后，空间信息确认负责人是当前账号，初始为 0 个 Agent。
- 通过“管理成员 → 添加 Agent”关联已发布的 `dsh-work 助手`，页面显示 Agent 可用，对话发送入口解除阻止。
- 上传合成文件 `dsh-work-ui-e2e-inventory.md` 后，文件列表计数变为 1，动态记录“上传了文件”。
- 在同一页面生命周期内点击“引用到对话”，发送文件分析请求；Run 显示“已完成”，回复包含 `UI-E2E-WRITE-20260914`。
- 上传第二版本并填写更新说明，文件列表显示 `V2 · 共 2 个版本`；版本历史同时显示 V1/V2，V2 标记为当前版本。
- 再次通过版本历史“引用此版本”引用 V2，在同一页面生命周期内发送成果写入请求；Run `run-94280467-6b4f-4c28-bfca-e1932a536a50` 显示“已完成”，回复确认读取 `UI-E2E-WRITE-20260914-V2` 与 `East warehouse available: 90`，并生成 `output/ui-e2e-report.md`。
- “成果”页签显示 `成果 1`，成果卡片显示 `ui-e2e-report.md V1 · 455 B`；“对话详情”显示进入队列、DSH Worker 开始、执行完成三步及成果文件。
- 空间信息最终显示对话数 4、近 7 天 4 次调用及 `35132 tokens`；控制台未观察到 warning/error。期间一次未携带文件引用的尝试按运行时授权正确拒绝目录探测，随后使用显式版本引用重试成功。

本记录证明当前登录账号下的浏览器写入交互与真实 DSH 执行可用；测试空间及合成数据暂保留，便于复查，不代表生产数据验收。

## AG 发布治理（服务端持久化，已实现）

Agent 发布主线已由服务端接口持久化（`agent_release_submissions` / `agent_trial_runs` / `agent_version_evidence` / `agent_packages`），前端内存 overlay 已移除。试运行通过真实 **Run/Attempt → Runtime Adapter → DSH** 链路执行：服务端为每次试运行建立 admin 会话（`purpose=agent-release-trial`，执行时复核平台管理权限），按封存修订的运行时快照装配 manifest，逐案例发起 admin 派发并断言 Attempt 终态。全部案例执行成功后试运行停在 `asserting`：管理端展示每个案例的预期与实际输出摘录，审核人逐项确认（任一不符合即失败），全部确认通过试运行才记为 `passed`。发布门禁只接受与当前封存修订一致且经逐项确认的试运行。工具候选治理页仍为前端原型（AG-PROTO-03），仅在开发构建可见。

### AG-REL-01 创建、试运行与发布（AG-01）

**角色：** 平台管理员 · **入口：** `/agents` → 创建 Agent → 独立发布流程 `/agents/:agentId/release/definition`

1. 点击「创建 Agent」，在同一对话框顶部切换「配置创建 / ZIP 导入」；编辑已有 Agent 时不显示创建方式切换。保存或导入完成后弹窗原位展示结果，不自动跳转；管理员可选择关闭，或点击「进入定义与依赖」。
2. 配置创建：填写名称、说明、Skill/Tool 引用与权限，创建草稿版本；服务端自动为草稿建立发布候选（默认三条试运行案例：成功、无效输入、权限拒绝）。
3. ZIP 导入：选择包文件后先由服务端解析预览（manifest、已解析/缺失依赖、包内候选、试运行案例与警告），确认后正式导入：服务端安全解包、落 `agent_packages` 与草稿版本、创建 `source=zip` 候选。包内 `evals/cases.yaml` 存在时其案例为权威；缺省时平台按 Agent 定义自动生成三类默认案例，不因缺文件失败。声明依赖未解析不阻塞导入，进入候选的 `missingDeps` 列表。
4. 四个阶段独立路由：`/definition` 展示定义与统一依赖表（已解析/缺失/随包候选按行内状态区分，缺失行可就地移除引用）；`/checks` 运行检查并查看部署计划；`/trial` 发起试运行（真实 DSH 执行，多案例逐条派发，输出展示供逐项确认）；`/review` 提交审核与复核发布。
5. 任一检查项失败阻塞试运行；定义或案例变更推进候选修订号并作废既有检查、封存与试运行结论；试运行执行完毕须由审核人对每个案例输出逐项确认（任一不符合即失败）；取消试运行会同步取消底层 Run；试运行通过后可「提交审核」进入 `submitted`——候选封存，案例/依赖/检查/试运行与 ZIP 重导均被拒绝，草稿漂移只标记 `definitionChanged` 不推进修订；审核人可「退回修改」（必须填写意见，转 `changes_requested` 后解除封存）或「撤回候选」（转 `withdrawn` 终态，历史保留，再次同步创建新候选）；发布仅允许 `submitted` 状态，在同一事务内锁定候选行重校验 revision、封存修订与绑定指纹，要求最近一次通过的试运行与当前封存修订一致，否则拒绝；发布不隐式重新启用已停用 Agent。
6. ZIP 导入幂等：相同 Agent + 相同声明版本 + 相同包内容时直接返回既有治理状态；同版本不同内容报版本冲突（409），平台不自动改写包声明版本。
7. 发布成功后版本证据（配置检查、逐案例真实试运行 runtime_verified 含 Run 引用、业务确认）写入 `agent_version_evidence`，在详情抽屉「版本历史」按版本展示；发布只切换活动版本与草稿指针，已停用 Agent 保持 disabled 状态，重新启用走独立状态变更。

**验收：** 两种入口产生同一候选/检查/试运行/发布流程与持久化数据；缺失依赖、包内候选、修订不一致均可复现地阻塞或放行；提交→退回→重提交→发布往返与撤回全程留痕；证据随版本持久保存。

### AG-PROTO-02 生命周期（AG-01，部分已实现）

**角色：** 平台管理员 · **入口：** `/agents` → 详情抽屉「概览与生命周期」/「版本历史」

已实现的为停用（排空，保留进行中 Attempt，与待发布草稿互不阻挡）、启用（含带草稿重新启用）、回滚（仅切换活动版本指针）与版本证据展示。原型中的紧急撤销、卸载归档与单版本撤销暂无服务端语义，已从界面移除；需要时另行设计真实语义后恢复。

### AG-PROTO-03 工具候选治理（AG-02，管理端）

**角色：** 平台管理员 · **入口：** `/tools` → 「候选」视图与详情抽屉

1. 登记独立候选（名称/标识/执行器/Schema 摘要）与随包候选同一流程。
2. 签发测试准入 → DSH 验证 → 发布；发布后并入已发布列表。
3. 详情抽屉查看绑定修订（端点/执行器/凭据槽位/过滤策略/封存时间）、证据与 Agent 引用方。
4. 已发布工具支持停用/启用与紧急撤销；存在阻塞原因（如首版仅只读）的候选不可签发准入。

### AG-REL-02 包内候选与缺失依赖阻塞（AG-01/AG-02）

**角色：** 平台管理员 · **入口：** `/agents/:agentId/release/definition` 处理依赖，再到 `/checks` 验证

1. 「依赖状态」统一表展示全部声明依赖：已解析引用、缺失引用（平台未接入）与随包候选三类；缺失与候选行置顶。
2. 缺失依赖使「依赖闭包与授权」检查失败并阻塞试运行；就地「移除引用」推进修订后重跑检查放行，或先在 Skill/工具管理接入同名能力后重新运行检查（服务端重解析）。
3. 随包候选（包内 `skills/*/SKILL.md`、`tools/*/tool.yaml`）本期只读展示并标记「待准入」：使「测试授权」检查失败并阻塞发布放行——候选须先在 Skill/工具管理中完成安装发布或准入后重新导入；联合发布与就地准入操作待准入流水线迭代接入。

## AG-03 轻量自动任务（首版已实现，P0 冒烟通过；P1/P2 待补）

依据：[总方案 §9](../docs/design/agent-tool-extension-and-automation-plan.md#9-受控自动执行)与[轻量实施方案](../docs/design/automation-implementation-plan.md)。首版不补跑停机遗漏、不自动重试、不续办准备、不新增独立投递系统；任务试运行可选，当前授权和原子去重仍必需。

当前覆盖状态：AG-AUTO-00 已由 `e2e/automation-smoke.spec.ts` 固化（P0，Prototype）；AC-20~24 的事务去重、扫描游标、撤权跳过、重叠与中断收敛等机制已由服务端 `server/src/infrastructure/postgres/automation.integration.test.ts`（9 例）与 `automation-calendar.test.ts`（8 例，含 DST）覆盖。`e2e/automation.integration.spec.ts` 与 `e2e/automation.acceptance.spec.ts` 仍为计划路径，不表示文件已存在或测试已通过。

P1 每例准备独立任务、Session、测试用户与数据，结束后清理；多角色使用独立 browser context/storageState。使用专用可丢弃 PostgreSQL 和受控 Runtime，禁止连接开发业务库或生产库。时钟、故障和执行阻塞由测试环境受控依赖提供，不增加生产测试开关。事务/重启故障同时由服务端集成测试验证，浏览器验证其用户可见结果。

### AG-AUTO-00 自动任务入口与配置反馈

**优先级：** P1（功能优先级）
**角色：** 员工（Prototype 受控身份）
**运行层级：** P0 浏览器冒烟
**前置数据：** 合成已发布 Agent、个人 Workspace、默认限制及成功/失败/遗漏记录
**spec：** `e2e/automation-smoke.spec.ts`（P0 已实现；Prototype 下自动任务集合为空、写操作 503，当前覆盖入口导航、空态与命令面不可用反馈）

1. 从已发布 Agent 进入设为定时任务，配置每日/每周、时间、时区与输入，查看下次运行预览。
2. 查看可选试运行、启用确认及“停机不补跑、失败不自动重试”的说明。
3. 在我的自动任务查看最近结果、跳过与遗漏原因，进入关联会话，返回后暂停任务。
4. 检查空列表、加载、无权限和错误反馈；键盘完成主要操作，窄屏下内容和操作可访问。

**验收：** 页面导航、可访问名称和状态反馈明确，结果不是只有 toast；此层不证明 PostgreSQL、DSH 或真实权限有效。

### AG-AUTO-20 触发去重、原子关联与准备中断（AC-20）

**优先级：** P0（功能优先级）
**角色：** 任务创建者
**运行层级：** P1 集成用户旅程
**前置数据：** 已确认任务、已批准 Agent、受控 Runtime、可注入受理事务/准备/入队故障的独立测试环境
**spec：** `e2e/automation.integration.spec.ts`（计划）

1. 并发提交同一个立即运行请求，刷新执行记录；同一键更换输入后再次提交。
2. 在受理事务回滚、事务提交后尚无 Attempt、Attempt 已提交尚未入队三个位置分别模拟中断并重启，每个场景使用独立数据。
3. 服务恢复后查看任务记录、关联会话和 Run 详情，再重放原请求。

**验收：** 同触发只产生一组 Session/Run 关联，同键异输入明确拒绝；事务回滚无部分关联。无 Attempt 的已受理 Run 显示准备中断失败，未自动续办；当前 queued Attempt 由原 Run 恢复，Worker 丢失则失败，不另建 Attempt 或运行。重放不会把旧失败变成新执行。

### AG-AUTO-21 日历、遗漏与明确再次运行（AC-21）

**优先级：** P0（功能优先级）
**角色：** 任务创建者
**运行层级：** P1 集成用户旅程（DST 边界同时由日历单元测试覆盖）
**前置数据：** 固定测试时钟、具有夏令时的 IANA 时区、每日/每周任务及可失败 Runtime
**spec：** `e2e/automation.integration.spec.ts`（计划）

1. 预览跨夏令时的下次运行，再推进受控时间到对应槽位。
2. 模拟跨多个槽位停机后启动，查看遗漏说明和下次运行；另例暂停后重新启用、修改规则后收到旧规则回调。
3. 让一次执行失败，观察没有自动重试；明确点击再次立即运行，并重放该手动请求。

**验收：** 缺失本地时刻跳过，重复时刻只取第一次；预览与调度一致。停机遗漏按区间留痕，旧规则及暂停期间不补跑；恢复安排未来槽位。失败不自动重试，再次运行产生新触发及新 Session/Run，同一手动请求重放不再增建。

### AG-AUTO-22 当前授权与个人/团队空间撤权（AC-22）

**优先级：** P0（功能优先级）
**角色：** 创建者、另一员工、执行收权操作的管理员
**运行层级：** P1 集成用户旅程；真实目录与工具边界另做 P2
**前置数据：** 独立个人/团队空间、角色及数据范围、受控目录同步状态、可阻塞排队和工具调用的 Runtime
**spec：** `e2e/automation.integration.spec.ts`（计划）

1. 启用任务后为用户增加数据授权，执行并核对实际授权仍受启用上限约束。
2. 分例在排队及活动执行阶段停用账号、撤销个人空间数据范围、移除团队成员、归档空间或紧急撤销能力。
3. 保持用户 active，仅撤销对象权限，查看已有运行和后续工具调用的拒绝/取消反馈。
4. 分例设置目录从未成功、同步失败、超窗及重试中尚未恢复的状态，再触发任务；另一员工尝试读取或修改该任务。
5. 分例令工具审批策略变为需要人工批准，再领取执行。

**验收：** 新权限不扩大旧任务；旧 Manifest 已越权时拒绝，不原地缩小后继续运行。排队和活动执行按收权规则收敛，外部调用再次检查；个人空间不能跳过。身份未知或工具需审批时拒绝并留证，越权员工不能访问任务及内容。普通能力停用与紧急撤销分例验证，仍获授权的活动任务可按普通停用规则排空。

### AG-AUTO-23 可选试运行、固定版本与暂停（AC-23）

**优先级：** P0（功能优先级）
**角色：** 任务创建者、发布新版本的管理员
**运行层级：** P1 集成用户旅程
**前置数据：** 具备有效发布证据的 Agent v1/v2、无需人工审批的工具、已授权固定文件版本及未获授权输入
**spec：** `e2e/automation.integration.spec.ts`（计划）

1. 不做任务级试运行，完成确定性检查及本人确认后启用；另例执行可选试运行，查看实际成功或失败结果。
2. 用无发布证据、需要人工审批或输入越权的配置尝试启用。
3. 执行一次后发布 Agent v2，再执行原任务并对照两次会话。
4. 排队时暂停，确认未开始的运行停止；活动执行中暂停并单独执行取消当前任务。
5. 修改执行输入但不确认，尝试运行；重新确认/启用后查看下一次计划。

**验收：** 试运行可选不妨碍合规启用，但确定性门禁不能绕过，试运行失败不标为成功。两次 Session 隔离且原任务保持 v1/固定文件引用。暂停清理未开始任务，仍获授权的活动运行只在明确取消后停止；未确认配置不能运行，重新启用不复活旧 Run 或补跑旧槽。

### AG-AUTO-24 结果持久化、默认限制与交互容量（AC-24）

**优先级：** P0（功能优先级）
**角色：** 自动任务创建者、同时发起交互任务的员工
**运行层级：** P1 集成用户旅程；真实限制和容量另做 P2
**前置数据：** 多个独立自动任务、受控并发容量及默认限制、可生成成果的 Runtime、消息/成果写入与读取故障
**spec：** `e2e/automation.integration.spec.ts`（计划）

1. 完成自动任务并打开关联 Session，读取消息、成果及其归属；以未获授权身份尝试访问。
2. 分例注入必要结果持久化失败和完成后的页面读取失败，修复后刷新，核对 Runtime 调用次数。
3. 多任务同时到期使自动任务达到限额，队首保留受限自动任务，同时提交交互任务。
4. 分例达到 pending 上限、每任务重叠、默认超时/工具调用/成果文件限制，检查用户反馈；取消未释放 Worker 时观察占用。

**验收：** 成果和消息有持久化及权限依据，Session 存在不代表成功；必要写入失败明确可见，完成后的读取失败不修改成功 Run 为重新执行，刷新不新增 DSH 调用。超额/重叠有原因，默认限制真实执行；自动任务不占满交互保留容量，受限队首不阻塞后续交互，取消中尚未释放的 Worker 仍计入占用。

### AG-AUTO-P2 发布前真实验收

**优先级：** P0（发布门禁）
**角色：** 两名真实员工、治理管理员
**运行层级：** P2 真实验收
**前置数据：** 目标 DSH Lock/Adapter、真实 OIDC/目录同步、获准测试空间与只读数据源、目标环境 Runtime/存储限制
**spec：** `e2e/automation.acceptance.spec.ts`（计划，仅受控发布环境执行）

1. 经 Run/Attempt → Runtime Adapter → DSH 完成两次固定版本自动任务，读取隔离 Session 的消息与成果。
2. 使用独立账号验证成果不可越权读取，分别执行真实目录停用和对象收权，核对排队/活动运行及后续工具调用。
3. 在受控环境演练停机不补跑、准备中断、默认资源限制及自动任务与交互并发。

**验收：** 保留身份、版本、Run/Attempt、实际结果、故障和容量证据；P0/P1 通过不能替代本层。此处仅登记计划，未运行、不代表已部署或生产验收。

## 开发接入文档（管理端）

### ADMIN-E2E-04 管理端开发接入文档浏览

**优先级：** P0
**角色：** 平台管理员（Prototype 受控身份）
**运行层级：** P0 浏览器冒烟
**前置数据：** 管理端 Prototype 会话
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开管理端任意页面，左侧导航「开发接入」组可见「接入规范」「接口文档」两项。
2. 进入「接入规范」，验证认证流程、API 包络与事件流章节可见，并可下载 Markdown 版规范（`dsh-work-移动端接入规范.md`，源文件 `docs/development/mobile-integration-guide.md`）。
3. 进入「接口文档」，验证移动端 H5 API 契约渲染且非空（`openapi-mobile-h5.json`，仅收录移动端实际调用的 Workbench 子集，含结构化入参/返回字段），并可下载该 OpenAPI JSON。

**验收：** 两个页面无需离开管理平台即可阅读与下载；接口文档内容与仓库移动端 OpenAPI 契约一致（构建期内嵌，同版本发布）；下载产物适合 Agent/其他工程直接消费（Markdown 规范 + OpenAPI JSON）。
