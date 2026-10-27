# 验证记录

历史验证记录：每次实施的阶段、已运行的测试与未覆盖项。只追加，新记录写在最前面；不是验收标准。证据层级与写法见[验收目录索引](../TEST-CATALOG.md)。

### 2026-10-27：M6 第二轮红灯修复

**环境：** Windows 10，Node v24.14.1，`corepack pnpm`（若可用）；PostgreSQL 依赖 `DSH_WORK_TEST_DATABASE_URL`（集成未在本轮全量执行）。

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `node --test run-event-recorder.test.ts` | 0 | 4/4，含档案员原文与重放不二次归档 |
| `node --test openapi-coverage.test.ts` | 1 | 经验路由已补；仍报 admin agent 发布/验证 operation 无对应路由（既有漂移） |
| `node --test --test-name-pattern=abort stops… python-skill-runner.test.ts` | 1 | Windows `DSH_WORK_PYTHON_USER` / `getuid` 环境阻塞 |
| `test:integration` / `test:e2e` / `ci:static` | 未运行 | 待在 CI 或具备 pnpm+PG 的环境收口 |

**层级：** 单测证据为 P0 逻辑；Integration/Browser 需 Linux CI 与 P0 冒烟服务。真实 OIDC、生产 DSH、多账号收权与企业连接器无 P2 证据。

### 2026-10-27：M6 红灯修复（本地 Windows，停在 push 前）

**阶段：** Task 0–8 实施与分层验证（未 `git push`）。

**已通过（本机）：** `pnpm verify`；`skill-plaza-candidates.test.ts`；`agency-agent-fixtures.test.ts`；`runtime-manifest-schema.test.ts`（25）；`test:m5:api`（30）；`run-event-recorder` P1-8 两条；`workspace-activity-writer.test.ts`（2）。

**未通过 / 未跑：** `ci:unit` 在 Windows 上因 `runtime-adapter.test.ts` 只读文件 `mode` 断言（292 vs 256）及若干 DSH/sandbox 依赖用例失败；完整 `test:runtime` 与 `pnpm test:e2e`、P1 集成矩阵未在本机跑绿。真实 OIDC、生产 DSH、多账号撤权与企业连接器未执行。

**提交：** `dev` 顶端 7 条功能提交（Skill 准入、Agency 夹具、Manifest、身份边界、P0 工具治理、通知绑定、员工壳层）；另含契约测试修补（待与文档提交一并入库）。

### 2026-10-24：本地补硬 AUTO/MCP 缺口（正式发布门禁 + 收权/停用）

**阶段：** 针对同日「剩余目录 P2」中标明的缺口补证据；仍为本地密码登录 + 真实 DSH `0.1.2-rc.1`，**非** OIDC/生产。
**代码提交：** `f0cbe3b`　**证据：** `/tmp/p2-harden-evidence.json`、`/tmp/p2-auto-harden-followup.json`

**PF-MCP 补硬（去掉 SQL 绑版本捷径）：**

| 步 | 结果 | 证据 |
| --- | --- | --- |
| 登记 | 通过 | 靶场 `127.0.0.1:18765`；`connector-mcp-d3c5dd53…` 经管理端 DSH 发现登记 |
| 草稿 | 通过 | `quality-analysis` PATCH draft → `1.1.0`，`mcp_scope.selected` 含该连接器；验证前检查 MCP「可用；验证中不执行 MCP 调用」 |
| 验证 | 通过 | `agent-validation-f6f4e2a3…` 1 案例；`run-1faf9ffb…` / `attempt-c2c2ecda…` 机器检查三项通过；人工 verdict `passed` |
| 发布 | 通过 | 发布后活动版本 `1.1.0`，`mcp_scope.selected` |
| 员工调用 | 通过 | Ethan `run-16330a5a…` / `attempt-c34eba2c…` 成功 `put_receipt`+`get_receipt`；receipt `receipt-93508de2…`；审计 2 条 |
| 在途停用 | 通过 | `unknown_after_commit` 进行中停用连接器 → `run-4095a737…` / `attempt-e382ef7a…` `failed`，`result.error.code=AUTHORIZATION_REVOKED`，pending `external_effect_unknown` |
| 回滚清理 | 通过 | 回滚 `quality-analysis` → `1.0.0`/`mcp none`；连接器删除且 `credentialDestroyed=true` |

**AG-AUTO 补硬：**

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 账号停用 | 通过（双路径） | SQL `users.status=disabled` 后：① HTTP run-now → `401 session_expired`；② 同库 `AutomationService.runNow` → `skipped`/`subject_invalid`（`autexec-6078cf6e…`）。本地密码登录下 HTTP 先拦会话，受理层跳过需服务路径留证 |
| 角色收权 | 通过 | 撤销 `role-employee` 后服务受理 `skipped`/`authorization_denied`（`autexec-79ba22ae…`）；随后已恢复角色 |
| 停用任务 | 通过（产品语义） | `DELETE /automations/:id` → `status=disabled`；再 run-now → `404`（`getMine` 对 disabled 不可见）。`task_disabled` reason 留给受理途中竞态，本环境用停用后不可见表达 |
| 暂停拦截 | 通过 | 成功 Run `run-46c7e54e…`/`attempt-autexec-8852d1d6…` 后 pause；再 run-now → `409`「未启用，不能立即运行」 |
| 重叠跳过 | 沿用 | 同日前序与本轮均观察到 `overlap` |

**仍未覆盖：** 停机不补跑/准备中断的进程级演练、自动任务车道容量打满、OIDC 目录同步停用、企业 MCP。PF-07 仍不得标 `verified`。

**结论：** 本地可将 **MCP 正式草稿→验证→发布→真实调用→在途撤权** 与 **AUTO 主体无效/授权拒绝/停用/暂停** 补硬到有 Run/Attempt 或受理记录的程度；不能替代 OIDC/生产门禁。

### 2026-10-24：剩余目录 P2 局部执行（AG-AUTO / PF-MCP / 经验迭代 / PF-WAIT / PF-07）

**阶段：** P2 局部真实验收（同日环境：`localhost:4174/4180/4190`，真实 DSH `0.1.2-rc.1`，本地账号密码登录；**非** AI Hub OIDC 多账号、**非**生产部署）。
**代码提交：** `f0cbe3b`　**角色：** 管理员 `13500000000`；员工 Ethan `13100000000`、Nina `13400000000`。
**证据文件：** `/tmp/p2-remaining-evidence.json`、`/tmp/p2-auto-memory-followup.json`、`/tmp/p2-auto-second.json`、`/tmp/pf07-evidence-filled.json`（`status=evidence_pending`，**未**标 `verified`）。

| 条目 | 结果 | 关键证据 / 说明 |
| --- | --- | --- |
| PF-MCP-P2（本地可丢弃 MCP） | 局部通过 | 靶场 `127.0.0.1:18765`；管理端 DSH 发现登记 A/B；Ethan→`quality-analysis` `run-c9766cba…`/`attempt-382dff2e…` 与 Nina→`production-planning` `run-29f45865…`/`attempt-3b39dc96…` 均成功 `put_receipt`+`get_receipt`；错误凭据→offline；停用后新 Run `403`；删除销毁凭据；列表不回显 Token。另：`pnpm probe:pf07:mcp` 通过（`run-pf07-0408ca48`）。**缺口：** Agent `mcp_scope` 用 SQL 发布版本指针（跳过 AG-CAP 试运行门禁）；非企业 MCP / OIDC |
| AG-AUTO-P2 | 局部通过 | 创建并启用 `automation-8d0d95f0…`（固定 `agent-version-dsh-work-assistant-project-tasks-1`）；连续两次 run-now：第一次 `run-b737f22b…`/`attempt-autexec-14bc3025…` 成功，第二次因 `overlap` 跳过；同幂等键重放同一 execution；间隔后再跑 `run-3ef436d0…`/`attempt-autexec-a50de32c…` 成功；Nina 读取 404。**缺口：** 目录停用/收权、停机不补跑、容量并发未演练 |
| PF-MEMORY-P2 / 经验迭代 | 局部通过（现行入口） | 员工端受控记忆已退役；按 EXPERIENCE-ITERATION：`propose_memory`→`run-8f6dcb11…`/`attempt-6de227bc…`→提案 `memory-proposal-42196708…`；管理员批准发布 `memory-version-0ac0a400…`；后续 `run-938357a5…` 回答引用该经验。**缺口：** OIDC 身份/角色变化、等待中撤回、版本隔离未测；不能宣称经典 PF-MEMORY-P2 全量 |
| PF-WAIT-P2 | 不适用 | 现行内置工具 `approval_mode=never`；bash/停止后台任务未准入；首个需审批工具准入后再补 |
| PF-07 全量 | 未通过门禁 | 已填部分场景观察记录于 `/tmp/pf07-evidence-filled.json`；校验器要求全场景 `passed`+`status=verified`，本轮故意保持 `evidence_pending`，**不得**当作发布门禁通过 |

**结论：** 在本地真实 DSH + 本地账号下，剩余目录 P2 中 **MCP 主路径、自动任务两次成功 Run、经验提出/审核/召回** 有 Run/Attempt 证据；**PF-WAIT N/A**；**PF-07 仍未核验**。不替代 OIDC/生产验收。

### 2026-10-24：E2E P2 局部执行（PS-S6-P2 为主）

**阶段：** P2 真实验收（本地 `localhost:4174/4180/4190`，真实 DSH `0.1.2-rc.1`，本地账号密码登录；非 AI Hub OIDC 多账号全量、非生产部署）。
**代码提交：** `f0cbe3b`　**空间：** `ws-f73fb43e-1b51-47b6-8a1c-e460f29fe467`（风险分析）　**Agent 成员：** `wam-699630e2-f046-43d7-982a-34b23ab67987`（dsh-work 助手 v1.0.2，`project_tasks_enabled=true`）　**角色：** A `13500000000` 负责人、B `13100000000` Ethan Cole 成员、C `13300000000` Ruby Hayes 只读。

**环境探针（不构成业务旅程通过）：** `pnpm test:pf07:matrix` 通过（声明「P2 尚未核验」）；`pnpm probe:handshake` / `pnpm probe:tool` 通过（真实模型只读工具）。

**PS-S6-P2（经工作台 API → Run/Attempt → DSH，等同群聊 @Agent 入口；续跑含真实 09:00 定时）：**

| 步 | 结果 | 关键证据 |
| --- | --- | --- |
| 1 查询 | 通过 | `run-82a457cf…` / `attempt-9722fbfe…` 调用 `project_tasks_list` 成功；Manifest 含四项项目任务工具 |
| 2 新建员工任务 | 通过（截止日期待议） | `run-eec15ae0…` 调用 `project_task_create`；任务 `ptask-ce8ec0cc…` 创建人 B、`created_via` 指向该 Run；截止最初为 `2026-10-23`（「本周五」边界需人工复核） |
| 3 新建 Agent 任务 | 通过 | `run-15fae587…` 创建 `ptask-29ad851a…`「每周整理库存周报」，`schedule.kind=manual`，未自动执行 |
| 4 改截止+改派 | 通过 | `run-f3b5b4da…` `project_task_update`；截止 `2026-10-26`、负责人 → Ethan；事件含 `metadata.via` |
| 5 只改标题 | 通过 | 人建每天任务 `ptask-91eb516e…`；`run-26ce4155…` 改名后 `schedule` 仍为每天 09:00 |
| 6 标记完成 | 通过 | `run-14b2276c…`；`ptask-ce8ec0cc…` → `done`，说明「已提交」，事件含 `via` |
| 7 只读拒绝 | 部分通过（路径不同） | C 创建会话 403、直接改状态 403；UI 无输入。未走「助手口头说明只读」，但无写入成立 |
| 8 定时只读 | 通过 | 槽位 `2026-10-24T01:00:00Z`（上海 09:00）事件 `scheduled_run`；`run-f8ea8c6a…` / `attempt-6bf54ff3…` Manifest 含 `project_tasks_list`/`project_task_get`，**无** `create`/`update` |
| 9 关闭开关 | 通过（回滚路径） | 管理员将活动版本**回滚**到已发布 `1.0.1`（`projectTasksEnabled=false`，非新建草稿再验证发布）；负责人升级成员到 `1.0.1`；B 的 `run-ab2afd99…` / `attempt-d85a8ce7…` Manifest **无**项目任务工具，助手说明无法创建，任务数未增加。验收后已恢复活动版本与成员到 `1.0.2` |

**仍未覆盖（本条当时）：** 目录其他独立 P2 与 PF-07 全量；AI Hub OIDC 多账号与生产部署。同日后续局部补测见上方「剩余目录 P2」记录。历史脏数据 `ptask-e2e544cd…`（经 Agent 却带 `weekly`）仍在库中，本轮第 3 步新任务已为 `manual`。

**结论：** 本地真实 DSH + 本地账号下 **PS-S6-P2 主路径 1–6、8–9 通过**，第 7 步为更强的入口拒绝（与目录「助手说明」表述不完全一致）。**不**等同 PF-07 / 其他条目 P2 或生产门禁。摘要：`/tmp/ps-s6-p2-step8-result.json`、`/tmp/ps-s6-p2-step9.json`。

### 2026-10-17：项目空间 S1 补齐成果来源与停止标注

**背景：** 核对方案发现 S1 第 5、6 节两项未实现却被标为已实现：成果标注所属任务/承接 Agent/发起人，任务线程停止时标注停止人。本次补齐。
**阶段：** Code → Test（服务端集成 + 组件单测）→ Green。改动为既有页面上的标注文字，由组件单测覆盖，未新增 P0 旅程；PS-E2E-03（P1）已包含成果标注所属任务的验收。
**已运行：** `project-space-api` 集成测试 11 组（新增成果来源标注与任务移除后不再标注、停止后 Run 详情与线程执行记录标注停止人且只读成员不能停止），团队讨论/会话/共享文件、迁移、会话摘要编排、收权、持久化等待集成套件共 116 项通过；服务端单测 336 项、员工端 382 项通过；P0 全套 `pnpm test:e2e` 25 项通过；`pnpm ci:static` 通过。
**未覆盖：** 成果来源与停止标注的 P1 浏览器旅程（随 PS-E2E-03 补写）；真实 DSH 下产生成果的标注效果属 P2，未执行。

### 2026-10-17：项目空间 S2 项目档案与项目档案员

**阶段：** 前端原型确认 → Spec（PS-E2E-05、06）→ Code → Verify（P0 冒烟环境浏览器预演，桌面 1280 与手机 390 宽：档案页签条目编辑、添加、删除确认、版本历史变更对比与回退，右栏简报/成员/Agent 收起与刷新后保持，手机端无横向滚动）→ Test → Green。
**预演发现并修复：** 窄屏页签栏横向滚动时深链到“档案”页签不可见，改为激活页签自动滚入可视区域。
**已运行：** P0 全套 `pnpm test:e2e` 25 项通过（新增 PS-E2E-05，PS-E2E-02 页签顺序含“档案”）；服务端 `project-space-api` 集成测试 9 组（新增档案读写轨与版本冲突/回退/归档只读、档案员合并与人工优先、无效输出重试、Agent 任务携带档案并触发整理），以及迁移、会话摘要编排、团队讨论/生命周期/动态、持久化等待、收权、发布治理集成套件通过；服务端单测 336 项、员工端 380 项、管理端 138 项通过；`pnpm ci:static` 通过。
**未覆盖：** PS-E2E-06 P1 浏览器旅程未编写（档案员与读取契约由服务端集成测试固化）；P0 冒烟只有档案内存实现，不触发档案员；真实 DSH 下档案员的整理质量与对 Agent 回答的影响属 P2，未执行。

### 2026-10-17：项目空间 S1 改名、项目简报与项目任务

**阶段：** Spec（PS-E2E-01～04）→ Code → Verify（P0 冒烟环境浏览器预演，桌面 1280 与手机 390 宽，走通简报编辑、员工任务创建→进行中→完成、手机端信息抽屉与新建弹窗，无横向滚动）→ Test → Green。
**预演发现并修复：** 表单内下拉框与日期控件宽度由内容决定，改为撑满；Element Plus 下拉按既有约定用键盘驱动。
**已运行：** P0 全套 `pnpm test:e2e` 24 项通过（含新增 `e2e/project-space.spec.ts`、导航更名后的 `personal-workbench.spec.ts` 与 `mvp-smoke.spec.ts`）；服务端 `project-space-api` 集成测试 5 组（简报版本与读写轨、员工任务权限、Agent 任务线程与简报上下文、执行中拒绝回复、设为任务、个人空间拒绝）及迁移、动态、团队讨论/会话、收权、Agent 成员集成套件通过；服务端单测 330 项、员工端 371 项、管理端 138 项通过；Manifest Schema/编译器与 DSH 适配器渲染单测通过。
**未覆盖：** PS-E2E-03（Agent 任务执行与线程续接）与 PS-E2E-04（只读/归档写入口）的 P1 浏览器旅程未编写；P0 冒烟服务只有员工任务内存实现，不能证明 PostgreSQL、真实 DSH 或多角色权限；真实 DSH 下简报上下文对回答的影响属 P2，未执行。

### 2026-10-17：项目空间 S0 团队交付边界

**阶段：** Spec（PS-E2E-00 登记为 P1 计划）→ Code → 服务端集成测试 + 前端组件单测
**已运行：** `team-workspace-authorization`（角色只取 Agent 授权、数据范围随成员加入收紧/移除恢复、停用账号不计入、个人请求不变）、`m5-revocation-pipeline`（成员加入后清扫取消快照超出共同范围的运行）、`workspace-agent-member-api`（名册可交付范围仅负责人/管理员可见、预览影响与权限）及团队讨论、会话、生命周期、自动任务、企业知识集成套件均通过；服务端单测 328 项、员工端/管理端单测全部通过；lint 与类型检查通过。
**未覆盖：** PS-E2E-00 P1 浏览器旅程与浏览器预演（团队空间多角色 P1 浏览器环境尚未建立，TW-E2E-10 同样待补）；真实 DSH 下的数据交付效果属 P2，未执行。

### 2026-09-17：轻量自动任务首版（AG-03）

**阶段：** Spec（AG-AUTO-00~24 登记）→ Code → Verify（真实 HTTP 旅程预演）→ Test（P0 冒烟 + 服务端集成固化）
**环境：** 一次性 PostgreSQL（自动销毁）集成测试；OIDC + PostgreSQL 本机服务（4190）做真实 HTTP 旅程；Prototype 做 P0 冒烟

- 服务端：`agent_automations`/`automation_executions` 两表（迁移 0040），触发键唯一、Session/Run 关联唯一索引；`AutomationTriggerSweep` 以 pg advisory lock 保证单一调度所有者；`purpose='automation'` 贯穿 Manifest/Runtime Adapter/成果收集；执行授权 = 当前授权 ∩ 启用时 `scope_ceiling`；OIDC 模式按目录同步新鲜度 fail-closed；受理已提交但无 Attempt 的执行在启动恢复时收敛为 `interrupted`。
- 前端：`/automations` 列表/创建编辑/启停/立即运行/试运行/执行历史抽屉，跳转关联 Conversation；Prototype 下 GET 返回空集合、写操作 503，不伪造数据。

**证据：**

- `execution-schedule.test.ts` 8/8（上海时区、纽约 DST 春缺跳过/秋重取首、manual、weekly、非法时区）；`automation.integration.test.ts` 9/9（创建启用、幂等 run-now、重叠跳过、周期扫描游标、撤权跳过、中断恢复、暂停与越权、暂停收敛排队执行、weekly 规则语义比较）。
- 真实 HTTP 旅程（OIDC 服务）：创建解析 Agent 为固定已发布版本 → 启用生成 next slot 与 scope ceiling → run-now 建 Session/Run → 同幂等键重放返回同一 execution → Run 实际进入 DSH running；第二实例无法取得 advisory lock。
- `e2e/automation-smoke.spec.ts` 2/2（P0）；`pnpm verify`、`pnpm check:architecture`、全仓 typecheck、`validate:ui` 通过。

**当时未覆盖：** 该轮尚无 P1 浏览器旅程。2026-09-21 已补 `e2e/automation.integration.spec.ts` 第一批 5 例，见下方新验证记录；P2 真实验收（AG-AUTO-P2）仍未运行。管理端 OIDC 身份下的既有 mvp-smoke 2 例受测试环境配置阻塞（跳转真实 AI Hub 登录），与本改动无关。

### 2026-09-21：B-05/I-08 自动任务 P1 第一批

**阶段：** Spec（沿用 AG-AUTO-20~24）→ Code（隔离夹具与可访问任务卡）→ Verify/Test（P1 浏览器全旅程）→ Green
**环境：** 专用可丢弃 PostgreSQL（套件结束自动销毁）、Prototype 受控身份、显式合成 Runtime；没有 OIDC、DSH 或模型调用

- `e2e/automation.integration.spec.ts` 5/5：同键并发去重与准备中断、遗漏记录与失败后明确再次运行、账号停用与跨员工读取拒绝、固定 Agent Version 与暂停、自动任务车道满时交互任务继续执行。
- 浏览器断言覆盖任务卡状态、执行记录的受理/Run/业务结果三类状态、跳过/中断原因和取消操作；另一员工使用独立 browser context。
- 服务级事务回滚、日历/DST、调度游标、取消/领取竞态、advisory lock 等继续由既有单元/集成套件负责；P1 不重复伪造这些底层实现。

**仍未覆盖：** 团队成员移除、文件来源移除、固定能力撤销、授权服务故障及活动工具/成果提交阶段的完整矩阵；P2 真实 DSH/OIDC/目录/批准工具和目标环境容量验收未运行。

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
