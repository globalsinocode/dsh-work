# 团队工作空间 E2E 验收目录

这里记录面向用户的关键旅程。测试代码在页面交互稳定、通过浏览器预演后再固化；本目录中的“通过”必须注明运行层级，不能把 P0 冒烟当成真实 DSH、OIDC 或生产权限验收。

## 环境与证据层级

| 层级 | 环境 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| P0 | 测试专用冒烟服务（测试身份、内存合成数据）、Playwright Chromium | 页面启动、路由、核心展示与基本交互 | PostgreSQL 持久化、真实 DSH、OIDC、多账号授权 |
| P1 | 专用可丢弃 PostgreSQL、受控测试身份与 Runtime/Worker | 团队空间读写、版本、失败和权限契约 | 生产身份、企业连接器和生产容量 |
| P2 | 真实 DSH Run/Attempt、Runtime Adapter、OIDC 与多账号 | 真实执行、收权和目标环境验收 | 未实际执行的环境或未覆盖的角色 |

## 写法

- 实现前先在对应分册登记关键用户旅程（AGENTS.md 的 Spec 步骤）；新领域没有合适分册时新建分册并在下表登记。
- 每条至少写明优先级、用户角色、运行层级、前置数据、操作步骤、可观察结果及对应 spec 文件；验收标准用业务语言，不预设尚未成型的 DOM 选择器。
- 条目 ID 全局唯一，标题行以 `### <ID> <名称>` 开头，便于按 ID 检索。
- 每次实施的运行结果写进 PR/发布说明或仓库外受控证据，不写进旅程条目；[验证记录](catalog/verification-log.md)仅说明留证约定，不堆积长文。

## 分册

| 分册 | 范围 | 条目 |
| --- | --- | --- |
| [个人工作台](catalog/workbench.md) | 对话、成果、结果核验、Skill 广场与 AI 同事目录、列表页统一页头、跨轮成果延续。 | `ART-E2E-01`、`I06-E2E-01`、`I06-E2E-02`、`EMP-CATALOG-01`、`SHELL-HEADER-01`、`EX-TOOL-01`、`EX-PROGRESS-01`、`EX-ARTIFACT-01`、`EX-ARTIFACT-02`、`EX-ARTIFACT-03`、`EX-ARTIFACT-04`、`EX-ARTIFACT-05`、`EX-ARTIFACT-06`、`EX-ARTIFACT-07`、`EX-ARTIFACT-08`、`EX-SHELL-01`、`EX-SHELL-02`、`EX-CONTEXT-01`、`EX-ATTACH-01` |
| [项目空间](catalog/project-space.md) | 团队空间导航与共享讨论、项目空间 S0–S4、Agent 维护项目任务（S6）。 | `TW-E2E-01`、`TW-E2E-10`、`TW-E2E-11`、`PS-E2E-00`、`PS-E2E-01`、`PS-E2E-02`、`PS-E2E-03`、`PS-E2E-04`、`PS-E2E-05`、`PS-E2E-06`、`PS-E2E-07`、`PS-E2E-08`、`PS-S6-01`、`PS-S6-P2` |
| [员工端双模式（S5）](catalog/collab-mode.md) | A 工作模式与 B 协作模式：模式切换、协作壳层、对话列表、单聊、群聊、群组任务详情、群组与成员选择、@ 同事提醒。 | `MODE-E2E-01`、`MODE-E2E-02`、`MODE-E2E-03`、`MODE-E2E-04`、`MODE-API-01`、`MODE-E2E-05`、`MODE-E2E-06`、`MODE-E2E-07`、`MODE-E2E-08`、`MODE-API-02`、`MODE-E2E-09`、`MODE-E2E-10`、`MODE-E2E-16`、`MODE-E2E-11`、`MODE-E2E-12`、`MODE-E2E-14`、`MODE-E2E-15`、`MODE-E2E-13`、`MODE-API-03`、`MODE-E2E-17`、`MODE-API-04` |
| [Agent](catalog/agents.md) | Agent 定义与能力、详情与发布、岗位权限、轻量自动任务、经验迭代与主动记忆。 | `AG-SOUL-P0`、`AG-CAP-P0`、`AG-DETAIL-01`、`AG-DETAIL-02`、`AG-CAP-P1`、`AG-CAP-P2`、`AE-02`、`AG-SOUL-01`、`AG-REL-01`、`AG-PROTO-02`、`AG-REL-02`、`AG-AUTO-00`、`AG-AUTO-20`、`AG-AUTO-21`、`AG-AUTO-22`、`AG-AUTO-23`、`AG-AUTO-24`、`AG-AUTO-P2`、`EXPERIENCE-ITERATION-01`、`MEMORY-EMPLOYEE-REMOVAL`、`PF-MEMORY-01`、`PF-MEMORY-P2`、`AE-MEMORY-01` |
| [管理端与平台](catalog/admin-platform.md) | 冒烟环境、登录与身份、管理端、内置工具与操作计划、开发接入文档、MCP、持久化等待与审批、平台内置 Skill。 | `E2E-ENV-01`、`TW-E2E-02`、`ADMIN-E2E-03`、`LOCAL-AUTH-P1`、`LOGIN-ENTRY-P1`、`LOGIN-OPTIONS-P1`、`ADMIN-E2E-01`、`ADMIN-E2E-05`、`ADMIN-E2E-02`、`ADMIN-E2E-04`、`C7`、`PF-MCP-01`、`PF-MCP-P2`、`PF-WAIT-01`、`PF-WAIT-P2`、`BSK-01`、`BSK-02`、`BSK-P2` |
| [验证记录](catalog/verification-log.md) | 留证约定（非验收标准）；不在工作树堆积某次跑测长文。 | — |

### MCP-E2E-01 用户授权 MCP 分权

**优先级：** P1 · **角色：** 员工与管理员 · **运行层级：** 可丢弃 PostgreSQL
**前置数据：** 管理员登记 `user_oauth` 连接器；两名员工账号。
**验收：** `server/src/infrastructure/postgres/mcp-user-grant.integration.test.ts` 与 `server/src/infrastructure/postgres/mcp-connector-governance.integration.test.ts`；P0 冒烟不能代替本条。

1. 管理员登记用户授权连接器并完成探活；两名员工分别在用户中心授权。
2. 使用 `selected` 范围的 Agent：未授权员工发送前被阻止并看到连接器名称；授权后可发送。
3. 使用 `all` 范围的 Agent：未授权连接器不出现在本次工具装配，发送前说明被移出名称。

## P0 浏览器旅程

### E2E-ENV-01 默认冒烟环境隔离

**优先级：** P0 · **角色：** 本地开发者 / CI · **运行层级：** P0 冒烟服务、内存数据
**前置数据：** 仓库可以保留配置开发数据库和正式登录的 `.env`；无需启动 PostgreSQL、AI Hub 或 DSH。
**验证：** `scripts/testing/playwright-p0-config.test.mjs` 与默认 `pnpm test:e2e` 全套冒烟。

1. 直接执行 `pnpm test:e2e`，自动在独立端口启动员工端、管理端和测试专用冒烟服务（`scripts/testing/p0-smoke-server.ts`），不启动应用服务端。
2. 冒烟服务不读取数据库与身份配置，测试子进程覆盖前端 API 地址，不继承开发环境的数据源；浏览器地址与服务端口一致。
3. 如果测试端口已被占用，明确报错，不复用已有服务；可显式指定另一组端口重跑。

**验收：** 默认命令不连接或迁移开发数据库，不启动真实身份/模型链路；P1 专用配置保持独立。

### TW-E2E-01 团队空间导航与资源查看

**优先级：** P0
**角色：** 员工（冒烟测试身份）
**前置数据：** `ws-supply` 团队空间，包含两个共享文件及团队成果
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开 `/workspaces`，选择“供应链经营分析”。
2. 验证“对话”“共享文件”“成果”三个工作空间页签可见。
3. 进入“共享文件”，验证两个合成文件名称；原型数据没有明确的可引用授权，因此不显示“引用到对话”入口。
4. 进入“成果”，验证团队成果名称可见。

**验收：** 当前空间 URL 正确；对应页签处于选中状态；文件和成果内容没有串到其他空间。

### ART-E2E-01 HTML 成果沙箱预览

**优先级：** P0
**角色：** 员工（冒烟测试身份）
**前置数据：** `ws-supply` 团队空间包含一个 `html` 类型成果（`华东区交付风险看板.html`）及既有 xlsx/pdf 成果
**spec：** `e2e/mvp-smoke.spec.ts`

1. 进入 `/workspaces/ws-supply?tab=artifacts`，验证 HTML 成果与 xlsx 成果卡片均可见。
2. 点击 HTML 成果的文件名，对话框在 `sandbox="allow-scripts"` 的 iframe（opaque origin，无 `allow-same-origin`）中渲染 HTML 内容。
3. 切换「源代码」视图查看原始标记，关闭对话框。
4. 点击 xlsx 成果的文件名，对话框说明暂不支持在线预览，且不渲染 iframe。

**验收：** 预览内容与成果文件一致；卡片上无名为「预览」的独立按钮，下载仍为独立操作；iframe 不带 `allow-same-origin`，页面脚本不能访问工作台 Cookie/DOM；加载失败就地报错可重试；下载仍走鉴权附件通道。本层只证明页面与沙箱隔离，不证明 PostgreSQL 成果发布。

### TW-E2E-02 管理端冒烟（现有基线）

**优先级：** P0
**角色：** 平台管理员（冒烟测试身份）
**前置数据：** Prototype 管理端能力与 Runtime 数据
**spec：** `e2e/mvp-smoke.spec.ts`

验证管理端从能力页切换连接器页签并进入 Runtimes 页面，作为团队空间相关管理能力变更的公共导航回归基线。

### ADMIN-E2E-03 管理端用户菜单查看系统信息

**优先级：** P0
**角色：** 平台管理员（冒烟测试身份）
**运行层级：** P0 浏览器冒烟
**前置数据：** 管理端 Prototype 会话与构建时版本元数据
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开管理端运营概览，点击右上角当前用户下拉菜单。
2. 选择“关于 dsh-work”。
3. 验证关于页面显示系统发布版本、构建 Commit 和 DSH Runtime 信息。

**验收：** 用户无需进入任何治理模块即可查看当前管理端构建身份；显示的系统版本来自构建元数据，Runtime 版本来自锁定配置。

### AG-SOUL-P0 无依赖 Agent 创建页面冒烟

**优先级：** P0 · **角色：** 平台管理员（冒烟测试身份） · **运行层级：** P0 浏览器冒烟<br>
**前置数据：** 隔离 Prototype 管理端，不连接 PostgreSQL；使用唯一 Agent 标识<br>
**spec：** `e2e/admin-agent-soul.spec.ts`

1. 打开 Agent 管理，选择配置创建，填写名称和说明。
2. 在定义页填写 `SOUL.md` 内容，工作规程留空；下一步不选择 Skill，MCP 保留默认“不使用 MCP”。创建阶段不填写员工可见角色和平台数据范围。
3. 确认页面显示 0 个 Skill 与 MCP 范围，创建后显示独立执行身份和草稿已保存。

**验收：** 页面能在不手选 DSH 工具的情况下创建基础 Agent，Soul 有清晰的名称和边界提示；只证明 Prototype 页面交互，不证明 PostgreSQL、发布或真实 DSH。

### AG-CAP-P0 Agent 定义与 MCP 范围配置

**优先级：** P0 · **角色：** 平台管理员（冒烟测试身份） · **运行层级：** P0 浏览器冒烟<br>
**前置数据：** 隔离 Prototype 管理端；一个可用的企业知识 MCP Connector；唯一 Agent 标识<br>
**spec：** `e2e/admin-agent-capabilities.spec.ts`

1. 创建 Agent，填写 Soul 和可选的 `AGENTS.md` 工作规程；不选择 DSH 基础工具。
2. 在 Skill 与 MCP 步骤检查默认“不使用 MCP”，切换为“仅选定”，先验证空集合无法前进，再选择连接器并查看只读工具详情及登记的上游权限说明。
3. 保存并重新打开草稿，检查工作规程和 MCP 模式回显。
4. 切换为“不使用 MCP”后再切回“仅选定”，确认旧选择已清空且空集合无法进入确认页。

**验收：** 表单只有定义、Skill 与 MCP、确认保存三步；不展示逐 Agent 的基础/扩展工具开关或全部工具预览。状态、空列表、加载失败和缺失连接器均有可理解反馈；本层只证明页面交互，不证明数据库、发布或实际调用限制。

## P1 集成与 P2 待验收旅程

### main-flow-hardening B1 会话与 Run 可靠性（CR-01–CR-06）

| ID | 优先级 | 角色 | 旅程 | 前置 | 操作 | 可观察结果 | spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CR-01 | P1 | employee | 服务端已提交但响应丢失后重试讨论 | 同一 Session、同一意图键 | 发送讨论；代理丢弃首次响应；点击重试 | 线程只有一条消息，响应返回同一 messageId | `e2e/conversation-reliability.integration.spec.ts` |
| CR-02 | P1 | employee | 服务端已提交但响应丢失后重试 Run | 可用 Agent 与受控 Runtime | 启动 Run；丢弃响应；点击重试 | 只有一个 Run/Attempt，未重复扣费或执行 | `e2e/conversation-reliability.integration.spec.ts` |
| CR-03 | P1 | employee | 新会话首步失败不污染历史 | 附件上传或 Run 受理失败 | 新建任务并触发失败；返回历史 | 草稿不出现在历史；重试沿用同一 Session | `e2e/conversation-reliability.integration.spec.ts` |
| CR-04 | P1 | team member | 团队纯讨论恢复 | 无 Run 的团队 Session | 从历史打开；发普通讨论；再选择 @Agent | 讨论不产生 Run；@Agent 只产生一个 Run | `e2e/conversation-reliability.integration.spec.ts` |
| CR-05 | P1 | employee | 部分附件失败补偿 | 两个附件，第二个失败 | 从恢复页提交 | 第一个附件被安全移除，输入仍可重试 | `e2e/conversation-reliability.integration.spec.ts` |
| CR-06 | P1 | employee | 终态快照瞬时失败恢复 | SSE 已终态，首次 GET Run 失败 | 等待自动恢复 | 最终回答、成果、token 与终态一致 | `e2e/conversation-reliability.integration.spec.ts` |

### main-flow-hardening B2 内容与工作空间契约（CW-01–CW-07）

| ID | 优先级 | 角色 | 旅程 | 前置 | 操作 | 可观察结果 | spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CW-01 | P1 | team member | 无效 logicalFileId 上传新版本 | 可丢弃存储与数据库 | 上传到不存在文件 | 请求失败；对象被记录为候选且最终无孤儿 | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-02 | P1 | team member | 团队文件真实引用 | 当前空间有可引用文件 | 输入框选择文件并发送 | 请求携带 logicalFileId，刷新前后行为一致 | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-03 | P1 | team member | 解析失败仍显示文件事实 | 合成解析失败文件 | 首次上传 | 列表出现 failed 行和安全错误；不生成重复 logical file | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-04 | P1 | viewer | 上传能力门控 | viewer 身份 | 打开空间 Files | 不显示上传入口；伪造请求仍 403 | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-05 | P1 | employee | 局部读取失败 | /artifacts 返回 503，/workspaces 成功 | 进入团队空间 | 空间仍显示，成果模块独立报错 | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-06 | P1 | team member | 成功上传即时引用 | 可解析文件 | 上传后不刷新 | 立即出现引用按钮并可选择 | `e2e/content-workspace-contracts.integration.spec.ts` |
| CW-07 | P1 | employee | 大文件列表分页 | 单空间超过一页文件 | 滚动/加载更多 | 空间首页响应不携带全量文件，详情不重不漏 | `e2e/content-workspace-contracts.integration.spec.ts` |

### main-flow-hardening B3 工作空间通知（NT-01–NT-06）

| ID | 优先级 | 角色 | 旅程 | 前置 | 操作 | 可观察结果 | spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NT-01 | P1 | two team members | 新讨论通知参与者 | 已有共享 Session | A 发讨论 | B 收到一条通知，A 不收到自己通知，正文不进入 metadata | `e2e/workspace-notifications.integration.spec.ts` |
| NT-02 | P1 | mentioned member | 明确 @成员 | 团队 Session | A @B | 只有 B 收到 mention 通知 | `e2e/workspace-notifications.integration.spec.ts` |
| NT-03 | P1 | Run requester | Agent Run 终态 | 受控 Runtime | 启动并完成/失败 Run | 请求者收到对应终态通知 | `e2e/workspace-notifications.integration.spec.ts` |
| NT-04 | P1 | employee | 跨空间发现 | 两个空间 | 停留空间 A，空间 B 产生事件 | 全局入口和 B 卡片未读数更新 | `e2e/workspace-notifications.integration.spec.ts` |
| NT-05 | P1 | employee | 游标已读并发 | 已加载 sequence N | 标记到 N，同时提交 N+1 | N 已读，N+1 仍未读 | `e2e/workspace-notifications.integration.spec.ts` |
| NT-06 | P1 | revoked member | 撤权后隐私 | 已有旧通知 | 撤销空间成员后打开通知 | 不泄露对象标题/摘要，入口不可访问 | `e2e/workspace-notifications.integration.spec.ts` |

### main-flow-hardening B6 撤权后客户端收敛（AR-01–AR-05）

| ID | 优先级 | 角色 | 旅程 | 前置 | 操作 | 可观察结果 | spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AR-01 | P1 | admin | 管理角色被撤销 | 页面已打开 | 另一管理员撤权；回到窗口 | 导航/按钮收敛到当前权限，不重放失败写请求 | `e2e/authorization-refresh.integration.spec.ts` |
| AR-02 | P1 | admin | 完全失去后台访问权 | 已在管理路由 | 停用角色；进入下一路由 | 进入无权限页，不循环登录 | `e2e/authorization-refresh.integration.spec.ts` |
| AR-03 | P1 | employee | 数据范围被收回 | 工作台已打开 | 管理员收回 scope；窗口恢复可见 | 身份摘要和相关入口更新，服务端继续 403 | `e2e/authorization-refresh.integration.spec.ts` |
| AR-04 | P1 | admin | 并发 403 合并刷新 | 三个请求同时 403 | 等待页面处理 | 只发一次 /session 刷新，三个原请求都不自动重放 | `apps/admin-web/src/utils/authorization-change.test.ts` |
| AR-05 | release | operator | 六批次证据隔离 | 任一批单独发布 | 填写矩阵 | 只更新该批状态，未运行批次保持 not-run | `docs/release/main-flow-hardening-release-matrix.md` |

### LOCAL-AUTH-P1 独立账号登录与管理

**优先级：** P1 · **角色：** 平台管理员、普通员工 · **运行层级：** P1 集成用户旅程<br>
**前置数据：** 专用可丢弃 PostgreSQL、独立账号认证模式、一次性初始化的合成管理员；不配置或访问 AI Hub，不使用真实模型<br>
**spec：** `e2e/local-auth.integration.spec.ts`

1. 未登录访问管理端，进入账号密码登录页；错误密码显示可理解的错误，正确密码返回原入口。
2. 管理员在“员工与权限”创建员工账号并分配员工角色；页面不提供自助注册或目录同步入口。初始化管理员、新建账号、重置及修改密码统一要求 8–64 个字符：8 位和 64 位可成功，7 位和 65 位被拒绝且不改变密码或会话；表单提示与接口规则一致。已有长密码仍可登录和验证当前密码，随后可改为新规则内的密码。
3. 使用独立浏览器上下文登录员工端；普通员工不能进入管理端或创建账号。
4. 员工端与管理端首次登录完成改密后直接进入原访问页面，无需再次登录；当前门户获得新的登录会话，所有旧会话失效，旧密码不能登录。管理员重置后的首次改密遵循相同流程；密码校验失败留在改密页，不签发新会话、不跳转。外部返回地址不能跳出本站。
5. 管理员停用员工，员工现有会话立即失效；重新启用后可重新登录。最后一个有效本地管理员不能停用或撤去管理员角色。
6. 退出登录后回到登录页；窄屏表单可操作，键盘和表单标签可访问。
7. 员工端与运营平台默认展示账号密码主入口，无自助注册。AI Hub 配置有效时显示“使用 AI Hub 账号登录”，点击后直接进入企业认证，保留原访问目标，清空密码。
8. 未配置或配置无效时隐藏 AI Hub 入口，独立账号仍可用；配置加载失败可重试。上游故障返回账号密码页说明原因。
9. 新建账号的“登录账号、姓名、初始密码”标注必填星号；留空不能提交且在对应字段提示。新登录账号仅接受中国大陆 11 位手机号（可带 +86）或邮箱，部门与联系邮箱可选；旧账号仍可登录。提交重复的独立账号（包括已停用账号）时，在账号字段提示“登录账号已存在”，不创建身份、不变更已有授权；邮箱大小写或等价手机号写法不能绕过查重。

**验收：** 账号、授权与会话均在 PostgreSQL 持久化；整个旅程不跳转或请求 AI Hub。账号开通、密码变更、停用和会话撤销保留审计且不记录密码。P1 不代替生产 HTTPS、密码交付和既有账号迁移验收。

### LOGIN-ENTRY-P1 默认密码登录与可选 AI Hub 入口

**优先级：** P1 · **角色：** 员工、平台管理员 · **运行层级：** 隔离 PostgreSQL、受控 OIDC 入口及本地浏览器<br>
**前置数据：** 两门户的合成独立账号、受控 AI Hub 配置；不访问真实 AI Hub、模型或业务库<br>
**spec：** `e2e/local-auth.integration.spec.ts`、`server/src/modules/identity/portal-auth.integration.test.ts`

1. 正式部署始终支持独立账号；AI Hub 根据接入配置自动可用，旧登录模式记录不影响启动或撤销会话。
2. 点击“使用 AI Hub 账号登录”后直接进入对应门户的企业认证，不显示中间确认页，保留返回路径及切换账号意图；上游不可用时回到账号密码表单显示错误，不自动重试或切换身份。
3. 成功登录一种身份后撤销并清理当前门户另一种身份的旧会话；不同提供方、不同门户的 Cookie 不能混用，两个提供方同时有 Cookie 时要求重新登录。
4. 首次改密、退出、权限收回仍遵循原认证边界；本地登录不请求 AI Hub。

**验收：** 页面、HTTP 路由与会话选择均有回归证据；真实 AI Hub 授权、回调和生产部署另行验收。

### LOGIN-OPTIONS-P1 默认登录能力与独立账号边界

**优先级：** P1 · **角色：** 平台管理员、只读管理员 · **运行层级：** P1 集成用户旅程<br>
**前置数据：** 专用可丢弃 PostgreSQL、独立账号管理员、受控 OIDC 配置及独立的上游账号；不连接真实 AI Hub 或模型<br>
**spec：** `e2e/login-options.integration.spec.ts`、`server/src/modules/identity/authentication-startup.integration.test.ts`

1. 管理员登录后主导航无“登录设置”，旧模式配置 API 不再提供读写；账号管理仍可使用。
2. 未配置、配置不完整、配置有效但上游故障时，独立账号均可登录；配置有效时两端显示可直接跳转的 AI Hub 入口。仅配置旧门户地址和后端回调地址时，保留原回调且同时启用两种登录；显式配置的新旧入口冲突仍需提示，不能被兼容逻辑忽略。
3. 员工授权列表的“来源”列显示“独立账号”或“AI Hub”。新建独立账号始终产生独立身份；姓名或资料邮箱相同也不合并，角色和个人数据各自归属。已有身份不迁移。
4. AI Hub 员工的授权配置不显示“开通独立登录”或密码操作；旧绑定 API 及带既有用户 ID 的创建请求拒绝，不改变上游账号。
5. 旧登录模式记录不参与启动、不会撤销现有会话；原 prototype 模式已移除，设置后服务拒绝启动。最后一位独立管理员不能被停用或移除权限。
6. 员工列表独立展示姓名与邮箱、登录账号、来源、组织、角色、状态和最近活跃情况；独立账号显示本地用户名，AI Hub 账号显示同步的登录账号，不能把员工 UUID 当成账号。搜索登录账号可找到对应员工；空邮箱和无访问记录有明确反馈。
7. 员工详情展示登录账号、来源、最近活跃及 AI Hub 用户标识、同步时间；只读管理员可查看这些信息，不能改动凭据或授权。桌面与较窄视口保持账号信息可读和行操作可达。
8. 新建账号时，输入框失焦及提交均校验格式与账号是否存在。已同步 AI Hub 的登录账号（包括已停用账号）也参与查重，资料邮箱不作为登录账号；重复时在登录账号字段提示，不创建或绑定身份。查重失败保留输入并允许重试，旧输入的迟到结果不能覆盖新输入；提交时发现冲突仍保留表单并提示。

**验收：** 浏览器验证入口、账号管理与绑定入口移除，隔离 PostgreSQL 验证启动、旧配置兼容和账号隔离；不删除或迁移旧身份、角色和业务数据。真实 AI Hub 与生产部署按 P2 另行验收。

### AG-CAP-P1 Agent 能力装配与发布执行

**优先级：** P1 · **角色：** 平台管理员、可运行 Agent 的员工 · **运行层级：** P1 集成用户旅程<br>
**前置数据：** 专用可丢弃 PostgreSQL、受控 Runtime/Worker、两个同租户合成 MCP Connector；已准入的文件工具、可发布 Agent 及运行身份<br>
**spec：** `e2e/agent-capabilities.integration.spec.ts` 覆盖管理端创建、持久化、导出包、运行快照与选定连接器失效；包、试运行 Attempt 的实际 Manifest、跨租户校验及策略边界由对应服务端集成测试覆盖

1. 通过界面配置分别创建有、无 `AGENTS.md` 的 Agent；工作规程只来自配置，不读取宿主目录或输入附件中的同名文件。
2. 无需手选 DSH 文件工具即可试运行；配置创建选择依赖文件工具的 Skill 时，平台自动解析并固定依赖，移除该 Skill 后隐式工具不残留，原先直接声明的工具保留；检查实际 Attempt 的精确工具与绑定快照、成果和授权范围。未授权文件、未批准集合及无获准委派目标不能因默认装配而被访问。
3. 修改 Soul、`AGENTS.md`、默认工具依据或 MCP 模式后，旧试运行证据不能发布新候选；历史 Attempt 仍保留原依据。
4. 验证 `all` 在新的 Attempt 中获得当前可用连接器、`selected` 只获得所选连接器、`none` 不获得 MCP；空选择或跨租户 ID 拒绝，已选连接器失效时拒绝试运行和新执行，不回退到 `all`。
5. 在受控 Runtime 中尝试调用未选 MCP，以及停用或改变已固定连接器后继续调用；调用被阻止且留有可回查的失败与审计依据。
6. 编辑草稿并重新打开，确认未展示的身份授权、数据需求、预算和委派配置未被清空；对话、试运行与主动任务沿同一能力装配规则运行。

**验收：** 界面配置形成统一发布契约；默认工具由平台准入和当前授权约束，MCP 范围在 Manifest 与实际调用处一致，三个运行入口均沿既有 Run/Attempt 链路。P1 不替代真实 DSH/OIDC 与获准 MCP 的 P2 验收。

### AG-DRAFT-ERR-P1 Agent 草稿请求错误分类

**优先级：** P1 · **角色：** 平台管理员 · **运行层级：** P1 集成用户旅程<br>
**前置数据：** 专用可丢弃 PostgreSQL、受控 Runtime；不连接真实 DSH 或 OIDC<br>
**spec：** `e2e/agent-capabilities.integration.spec.ts` 证明合法创建只发出一次 POST、出现“Agent 草稿已保存”，以及同一标识再次提交返回 409。冲突与不完整结构都不增加版本、也不留下成功审计，该证据由 `server/src/infrastructure/postgres/agent-draft-api.integration.test.ts` 持有；不完整结构作为输入错误（422）同样由该 PostgreSQL 集成测试覆盖，本旅程不另走浏览器点击

1. 管理员提交一份结构完整的 Agent 草稿：创建只发出一次 POST，草稿保存成功。
2. 用已经保存的同一 Agent 标识再次提交：这是可恢复的冲突，已保存的草稿仍然有效。
3. 提交结构不完整的草稿：这是输入错误，不会保存。
4. 上述两种失败都不产生额外版本，也不留下成功的审计记录。

**验收：** 浏览器旅程证明单次 POST、保存对话框和重复标识的 409。冲突与非法请求体不增加版本、不写入成功审计的证据由 `server/src/infrastructure/postgres/agent-draft-api.integration.test.ts` 持有。P1 使用可丢弃 PostgreSQL 和受控 Runtime，不证明真实 DSH 或 OIDC。

### AG-CAP-P2 真实 DSH 能力装配验收

**优先级：** P2 · **角色：** 平台管理员、OIDC 员工及独立 Agent 身份 · **运行层级：** 真实 DSH/模型与 OIDC；本轮获准的 MCP 验收范围仅为本地可丢弃服务<br>
**前置数据：** 目标版本的真实 DSH、两个独立 OIDC 账号、两个本地可回查且可清理的 MCP 测试目标及单独的验收数据库<br>
**入口：** `pnpm probe:pf07:mcp:platform` 核对真实 DSH/本地 MCP 执行；管理端与员工端完整旅程须另留浏览器和 Run/Attempt 证据

1. 管理员通过真实 OIDC 创建包含 Soul、可选工作规程、默认 DSH 工具和选定 MCP 的 Agent，查看五类试运行的完整实际输出并逐项审核后发布；回答后段的错误声明也必须可见，不能仅凭前 240 字判断。
2. 员工从真实会话运行它，核对 Agent Principal、版本、Attempt Manifest、MCP 精确范围、文件成果、回执与逐调用审计。
3. 以第二账号及撤权、停用、能力变化场景核对新 Attempt 和活动调用均被正确限制；核对 `all`/`selected`/`none` 的真实使用结果。
4. 在可丢弃 MCP 上制造“写入已发生、回执未确认”的在途撤权，核对未知效果提示、先查权威回执的要求和通用重试禁用；Worker 审计未完成时也不能重试原 Attempt。

**初始探针证据（2026-09-27）：** DSH 0.1.2-rc.1 握手与文件读写探针通过；一次性 PostgreSQL + 合成身份 + 两个同租户本地 Bearer MCP 的真实 Run/Attempt 探针通过。`all` 完成写入与回执查询；`selected` 的 Run `run-06f46c24-04c0-4244-bbe1-11908578e905`、Attempt `attempt-adcba313-2821-4c25-b994-e48810b7042e` 含工作规程、`glob/grep/read/write` 默认工具精确引用和所选连接器，排除另一健康连接器，并实际完成写入与回执查询；`none` 的 Run `run-1933f836-274a-4008-9970-469182bcc1d5`、Attempt `attempt-a31bdcc6-279e-4966-8ca5-c1d50608449f` 无 MCP 连接或调用审计，使用默认文件工具生成并核对了 `artifact-version-011d7471ac2f08d4fa3713939975f30a`。删除选定连接器后拒绝后续解析。一次性数据库已清理。该阶段尚未覆盖真实 OIDC、多账号收权和完整发布试运行，因此初始探针本身不足以判定 AG-CAP-P2 完成；后续补充证据见下文。

**真实 OIDC 局部证据（2026-09-27）：** 隔离库完成 `max` 初始管理员认领，为 `eric` 分配普通员工角色；两账号分别登录。真实页面登记两个本地可丢弃 Bearer MCP，均发现 3 个工具。只选择 MCP A 的 `P2 能力验收 Agent`（`agent-mujx063z`）rev1 因回答夸大 Shell/后台能力而人工判失败；修复当前能力提示和试运行回答截断、重启隔离服务后，rev2 五案例 `trial-97f5dd34-14c1-4b30-a6cf-ec024aa4dbd0` 经真实 DSH 执行、全文人工复核通过，并发布不可变 v0.1.0。`max` 的 Run `run-25a33e55-fd01-4a11-96d9-962dff97478a` 与 `eric` 的 Run `run-6ac2aa99-3262-4b0c-942d-0bd6fe9e71aa` 均通过所选 MCP A 写入并查询同键回执；各自读回一致，Manifest 排除 MCP B，四条调用审计归因到各自请求者和同一 Agent Principal。`max` 的文件 Run `run-eae62de0-6f11-4b72-a26b-9a8dff56a36c` 实际 `write/read` 并登记匹配正文摘要的 Artifact V1。停用 A 时 `eric` 的新请求未生成 Run/调用审计，A 已恢复。

**追加证据（同日，仍限本地可丢弃 MCP）：** `max` 的在途 Run `run-c6129a71-3533-4250-bc65-e1a8b2520a63` / Attempt `attempt-8b6f3a72-93f2-4f30-9a4d-18159bda3f4b` 调用 A 的 `unknown_after_commit`，本地目标先产生 `receipt-fc507f5d-3e6a-424e-a7c7-0da2384fd64f`；响应等待期间管理员停用 A。Run 最终为 `failed` / `AUTHORIZATION_REVOKED`，调用审计为 `unknown`，员工页未声称成功；A 随后显式恢复。`all` 模式的 `P2 全部 MCP 验收 Agent`（`agent-mujyrwyb`）rev1、rev2 分别因三项、一项回答误报能力被人工判失败，未绕过门禁；收紧工作规程后 rev3 五案例 `trial-47a66b14-8eb4-4a6d-807a-4fa3b0a03f77` 逐项通过并发布 v0.1.0。`eric` 的真实 Run `run-19fe62f8-0bb3-4ee2-9c55-9b2d691b8823` / Attempt `attempt-1f55da21-60f7-49db-861e-8395940139df` Manifest 同时包含 A/B，实际调用 B 的 `put_receipt`、`get_receipt` 并读回 `receipt-236aeadd-f2b9-4153-a288-3f6931fe1a42`；审计分别记录人类发起人和独立 Agent Principal。`none` 模式的 `P2 无 MCP 验收 Agent`（`agent-mujz980l`）保留可选 `AGENTS.md` 为空，五案例 `trial-6d8e6c29-1767-4d66-99ea-889c9b063ca4` 通过并发布 v0.1.0；`eric` 的真实 Run `run-30ae7454-6234-4b28-9558-8392ee0f15b8` / Attempt `attempt-3ac2d394-1011-4f92-804f-a43d4914a819` 的 MCP Manifest 为空、MCP 审计数为 0，实际使用 `write/read` 生成 `artifact-version-12167c0dce05ceaaa6cf0ac9d3359f1d`，存储 SHA-256 与指定的 28 字节正文一致。

**能力变化证据（同日）：** 本地 MCP B 从 3 个工具变为 4 个，新增只读 `catalog_probe_v2`。管理端重新检查前，`eric` 的 Run `run-0a2267ee-6f64-42f8-a48e-f898a70c6246` / Attempt `attempt-a08f8719-d5da-4c97-8bb5-267690b6ac93` 仍固定旧摘要；调用审计为 `failed`，实际工具返回“能力清单与已审核摘要不一致”，Agent 明确报告未完成。该 Run 的终态是 `succeeded`，仅表示 Agent 完成了失败说明，**不代表工具调用成功**。管理端对 B 执行检查后显示 4 个 Tool 同步生效；新 Run `run-249cd354-b171-462d-96d7-71730a5226cc` / Attempt `attempt-79dac39e-ce9a-4406-a61e-6ee65d039039` 固定了新摘要，调用审计为 `success`，只读工具返回 `{"catalogVersion":2}`。当时未知效果重试风险仍待处理，后续修复证据见下文。

**未知外部效果修复与验证（2026-09-28）：** 上述在途撤权 Attempt 的 MCP 审计为 `unknown`，本地目标已产生回执，原员工页却提供通用重试。现在结果投影同时纳入 MCP 与平台操作的未知效果；员工页显示权威回执核对要求并隐藏该 Run 的重试入口，服务端也拒绝通用重试。MCP Attempt 的审计须在 Worker 结束、会话日志落库后标记完成；缺少该标记时同样拒绝重试，避免迟到审计与重试竞态。旧 Run 页面已在真实 OIDC 员工会话中确认不再显示重试；隔离 PostgreSQL 回归覆盖未知效果拒绝、审计未完成拒绝及完成后可重试。新只读真实 DSH Run `run-a27f8dce-e233-4bfc-a9c8-a9e64dc3b454` / Attempt `attempt-da60d79a-e5d8-4661-a839-d669e76cb7b7` 调用 A 的 `get_receipt` 返回 `not_found`，数据库调用审计为 `success` 且 `mcp_audit_finalized_at` 非空。本轮未重复执行旧外部写入。

**本轮结论（2026-09-28）：AG-CAP-P2 在“仅本地可丢弃 MCP”范围内通过。** 隔离库复核了三个已发布 v0.1.0 版本的 `selected`、`all`、`none` 范围；三次试运行各含五种必需案例，`dsh-work.ai/evaluation/v1` 机器断言及案例 verdict 均通过。`max` 和 `eric` 的发起身份均来自 AI Hub OIDC，真实 Run 将人类发起人和独立 Agent Principal 分开记录；所选、全部和不使用 MCP 的 Attempt 清单、实际调用、回执及文件成果与配置一致。停用、在途撤权、能力清单变化和未知效果重试门禁分别有上述 Run/Attempt、审计、真实页面及隔离库回归证据。此结论只覆盖本轮指定的本地测试 MCP；企业服务、生产部署和 PF-07 全量验收不在本条完成声明内。工作区改动尚未提交或推送。

### AE-02 Agent 独立身份与授权治理

**优先级：** P1 · **角色：** 平台管理员（浏览器）、普通员工（服务端执行请求） · **运行层级：** P1 集成用户旅程<br>
**前置数据：** 专用可丢弃 PostgreSQL；已发布 Agent、可运行的员工；受控授权服务<br>
**spec：** `e2e/agent-principal.integration.spec.ts`

1. 管理员在 Agent 详情中查看独立执行身份、角色和数据范围，停用该身份后员工无法创建新的执行。
2. 管理员恢复身份并撤销业务数据授权，员工执行请求不再取得该范围；默认隔离文件工具可继续运行，授权结果中的数据范围必须为空。管理员收紧工具策略时仍按实际所需范围拒绝未授权执行（后端授权回归覆盖）；旧修订的并发更新返回冲突。
3. PostgreSQL/Runtime 层分别验证默认无授权、固定 Attempt 在领取和工具调用边界收权，以及发起人、执行者和动作批准人归因。
4. 管理员从配置表单创建基础 Agent 时无需填写员工可见角色、业务执行角色或平台数据范围；草稿成功创建独立 Principal，授权为空。发布工作台选择员工可见角色后，基础试运行可执行；选择业务工具时须先在 Agent 详情显式授予所需角色和平台数据范围。
5. Prototype＋PostgreSQL 下角色选项来自 Agent 治理只读接口；角色列表临时失败时仍能查看 Principal 并停用身份，页面显示角色新增暂不可用。

**验收：** 治理负责人身份不代替 Agent 执行身份；新动作与结果提交按发起人披露范围和 Agent 当前授权收敛，已完成结果按当前人类/Workspace ACL 读取。P1 证明受控链路，真实 DSH/OIDC 留待 P2。

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
3. 「历史对话」打开任一会话：同样落在空间内对话视图，并显示该会话的**全部讨论历史**——不只是最近一轮 Run 的消息；该会话超过一页时出现「加载更早消息」并能前置补出更早一页。
4. 从空间外入口（工作台最近对话）打开团队会话 `/conversations/:id`：自动跳转到对应 `/workspaces/:id/conversations/:id`，空间外壳完整。
5. 个人空间会话仍使用 `/conversations/:id` 独立页，不发生跳转，且不额外请求共享线程接口。

**验收：** 空间内发起/打开团队会话始终停留在空间上下文；返回键回到空间页而非工作台；空间外旧链接可解析但归位到空间 URL；个人空间路径行为不变；按 Run（最新一轮或历史某一轮）进入团队对话时历史消息可见且按会话时序排列，同一条消息不重复渲染。组件行为由 `apps/workbench-web/src/views/ConversationView.test.ts` 固化（团队 Run 的历史合并、更早分页、个人 Run 不请求线程、活动标记同时刷新线程与 Run）。

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

## 管理端受控工具与操作计划旅程

### ADMIN-E2E-01 DSH 工具目录遵守审批能力边界

**优先级：** P1
**角色：** 平台管理员
**运行层级：** 专用可丢弃 PostgreSQL、受控 Runtime 工具目录
**前置数据：** 健康的 DSH Runtime 内置工具连接器；Runtime 同时报告安全文件工具、网络工具、`bash`、未知工具、Agent 协作工具与 Runtime 控制工具；数据库另有非 DSH Connector 的工具记录
**spec：** `server/src/infrastructure/postgres/m4-tool-connector-management.integration.test.ts`、`apps/admin-web/src/views/CapabilityManagementView.test.ts`、`apps/admin-web/src/components/AgentDraftDialog.test.ts`、`e2e/mvp-smoke.spec.ts`（P0 页面旅程）

1. 进入 DSH 工具管理并执行“同步 DSH 工具”，一次读取并登记当前 Profile 的全部普通内置工具。
2. 检查受 output 目录约束的 `edit` 自动进入目录、生成 Tool Version 和活动 Binding，并显示为“可授权”。
3. 检查 `read_image`、`str_replace_editor`、`web_search` 自动显示为“可授权”，并验证文件路径、编辑命令和查询数量约束；`web_fetch` 因缺少连接层私网地址防护保持“尚未准入”，即使历史状态可用，再次同步也应停用并撤销 Binding。
4. 检查 DSH Agent 协作工具与 Runtime 控制工具不出现在列表和 Agent 工具选项；历史记录保持停用并撤销 Binding。
5. 检查 `bash` 与未知普通工具同样进入目录，但显示“尚未准入”、保持停用且不生成活动 Binding。
6. 分别使用“运行状态”和“平台准入”筛选工具，确认两个条件可独立使用或组合使用；页面说明“可授权”不等于任何 Agent 已获权。
7. 在 Agent 草稿中确认只能选择已准入工具；尝试通过 API 引用、启用或修改未准入工具权限均被拒绝。
8. 让 Runtime 后续不再报告一个已同步工具，再次同步并确认该工具保留目录记录、转为不可用且撤销活动 Binding。
9. 查询普通工具列表与绑定列表，检查非 DSH 工具未混入；进入 MCP 连接器查看外部 MCP 能力。

**验收：** 管理员不再逐个添加工具；同步后普通业务工具进入平台目录，Agent 协作与 Runtime 控制工具保持隐藏。列表可按运行状态和平台准入组合筛选，并明确准入只是“可授权”；文件和网络工具在平台约束下自动准入，`edit` 自动成为可授权工具并锁定版本；`bash` 与未知工具明确显示平台准入原因且不能被 Agent 选择或执行；客户端输入不能覆盖平台审批策略；被拒或从 DSH 消失的工具不能进入 Agent Runtime 授权闭包；`DSH 工具管理` 仅显示 `connector-dsh-workspace` 下的 DSH 普通业务工具，MCP 外部工具只在 MCP 连接器详情中出现。

### ADMIN-E2E-03 DSH 内置连接与 MCP 管理入口分离

**优先级：** P0
**角色：** 平台管理员
**运行层级：** Prototype 浏览器与管理端组件测试；PostgreSQL 服务测试补充接口边界
**前置数据：** 一个 DSH Runtime、稳定内置连接 `connector-dsh-workspace`、至少一个 MCP Connector
**spec：** `e2e/mvp-smoke.spec.ts`、`apps/admin-web/src/views/RuntimeManagementView.test.ts`、`apps/admin-web/src/views/CapabilityManagementView.test.ts`、`server/src/infrastructure/postgres/m4-tool-connector-management.integration.test.ts`

1. 进入“Agent 治理 → MCP 连接器”，检查列表只包含外部 MCP Connector，不出现 `connector-dsh-workspace` 或其他平台内部连接。
2. 进入“安全与运维 → Runtimes”，打开当前 Runtime 详情。
3. 查看“DSH Runtime 内置工具连接”区域中的连接标识、状态、工具数量、目录摘要、活动 Binding、最近检查及故障信息。
4. 从 Runtime 详情执行内置工具连接检查；该操作不出现 MCP 的新增、Token、整体审核或删除能力。
5. 在系统健康页确认只保留 Runtime/连接依赖的汇总告警，不增加第二套连接配置入口。

**验收：** MCP 页面与接口只返回外部 MCP Connector；DSH 内置连接仍保留 Tool Version、Connector Binding 和审计事实，但只在 Runtime 运维详情中展示与检查。两个入口不重复提供编辑动作，页面位置不改变底层执行与授权模型。

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

## AG 发布治理（服务端持久化，已实现）

Agent 发布主线已由服务端接口持久化（`agent_release_submissions` / `agent_trial_runs` / `agent_version_evidence` / `agent_packages`），前端内存 overlay 已移除。试运行通过真实 **Run/Attempt → Runtime Adapter → DSH** 链路执行：服务端每次只为当前案例建立 admin 会话（`purpose=agent-release-trial`，执行时复核平台管理权限），按封存修订的运行时快照装配 manifest 并断言 Attempt 终态。执行成功后停在 `asserting`，管理端展示这一项的完整输出，审核人确认通过才可派发下一项；五项全部确认通过后试运行才记为 `passed`。发布门禁只接受与当前封存修订一致且经逐项确认的五份证据。旧工具候选治理原型已从管理入口下线；`DSH 工具管理` 只接入 Runtime 已加载且平台允许的 DSH 内置工具，包内自定义 Tool 候选当前保持阻塞，不得伪装为已准入。

### AG-SOUL-01 统一 Soul 创建基础 Agent（AE-01）

**优先级：** P1 · **角色：** 平台管理员 · **运行层级：** 专用可丢弃 PostgreSQL + 受控 Runtime；真实 DSH 试运行另记 P2<br>
**前置数据：** 可登录的管理员、无 Skill/Tool/MCP 依赖的唯一 Agent 标识、发布时可选的员工角色<br>
**spec：** `e2e/admin-agent-soul.integration.spec.ts`（页面预演后固化；服务端包/发布测试先覆盖契约）

1. 在 `/agents` 配置名称、说明、Soul，保持 Skill、MCP 和业务执行授权为空，保存草稿并进入发布工作台；创建结果显示独立执行身份已建立。
2. 在发布工作台选择员工可见角色，平台数据授权范围保持空；发起试运行时确认平台自动检查当前执行身份和空依赖，基础文本 Agent 可产生真实 Run/Attempt。选择需要平台业务授权的工具后，缺少对应角色或范围应在派发前列明，不能用可见角色或创建者权限补足。
3. 修改 Soul 后旧检查与试运行证据失效；已发布版本不被覆盖。

**验收：** 界面配置生成根目录 `SOUL.md` 的单一指令来源，空依赖可受控运行；发布仍需完整五类评测与人工确认。P1 不替代目标 DSH/OIDC 验收。

### AG-REL-01 创建、试运行与发布（AG-01）

**角色：** 平台管理员 · **入口：** `/agents` → 界面配置 Agent → `/agents/:agentId/release/trial` → `/agents/:agentId/release/review`

**P0 页面冒烟：** `e2e/agent-release-review.spec.ts` 使用原型管理员与固定的已通过 v1 试运行响应，确认发布页没有“提交审核”步骤、显示变化项与案例结论、技术标识默认收起、业务确认意见（选填）随单次“确认发布”请求提交并显示完成；并覆盖开始前编辑全部案例、「不通过」必填原因及原因回显。此用例只验证前端交互；页面预演使用 `scripts/testing/agent-release-browser.ts`（一次性 PostgreSQL、真实发布服务与合成试运行 Runtime，不连接模型/DSH/OIDC）：以专用测试库设置 `DSH_WORK_TEST_DATABASE_URL`，执行 `node --env-file-if-exists=.env --experimental-strip-types scripts/testing/agent-release-browser.ts`（端口取 `DSH_WORK_SERVER_PORT`，默认 4492），再在 `apps/admin-web` 以相同 `DSH_WORK_SERVER_PORT` 启动 Vite。合成回答带“非模型输出”标记，输入包含 `#模拟执行失败` 时返回执行失败；预演结果不构成 P1/P2 证据。下列 P1 真实发布门禁由 `pnpm test:agent-release:integration` 在隔离 PostgreSQL 中覆盖，P2 仍需真实 DSH/OIDC 留证。

1. 点击「创建 Agent」进入唯一的界面配置入口；填写名称、说明、`SOUL.md` 及按需选择的 Skill/MCP，无需选择员工可见角色或平台数据授权范围。平台自动创建独立执行身份且不继承创建者授权。保存后原位展示结果，可进入「人工试运行验证」。不提供 ZIP 上传/导入入口，旧导入接口也不能再创建 Agent。
1.1. 发布工作台在首项试运行前配置员工可见角色和可选的平台数据授权范围；MCP 连接范围和上游凭据权限单独展示，不将平台数据范围误写为上游数据过滤。员工可见角色是发布属性：只调整可见角色不使已有试运行证据失效，发布事务复核角色有效性；修改平台数据范围上限使已有试运行证据失效。基础文本 Agent 即使没有业务执行角色/数据范围也能验证；所选平台工具或数据集合需要的授权必须在派发前按 Agent 当前执行身份列出缺口。
1.2. 路径必填、经策略逐次限制在当前隔离 Run 工作区的默认 DSH 文件工具（例如 `read`）可供独立 Agent 身份在无业务角色和平台数据范围时使用；挂载输入仍须通过发起人的文件授权，工具仍须已准入、可用、固定绑定并接受执行期复核。路径可省略的 `glob`/`grep` 不在此例外内。把同一工具改成非默认角色或数据范围策略后，试运行必须在派发前报告缺口，不能借基础资格绕过自定义限制。
1.3. 工具授权预检按稳定角色 ID 与 Agent 执行身份比较；角色显示为“普通员工”或改名均不影响已授予的 `role-employee`。撤销对应角色后仍显示缺口并阻止试运行/发布。由组件回归及 `e2e/agent-release-review.spec.ts` 的 P0 场景覆盖，工具 API 的 ID 与名称分离由隔离数据库验证。
2. 平台创建草稿与发布候选，自动生成成功、无效输入、权限拒绝、提示注入、能力特有失败五类案例。验证页直接展示五个带状态的页签，不显示独立流程条或 Agent 配置摘要卡；当前验证区保留 Agent 名称和编辑配置入口。一次只显示当前案例的输入、人工判定标准和完整回答；审核人填写当前案例后仅运行这一项，查看输出并确认结论，通过后再进入下一页签。Run/Attempt 与机器断言可从当前结果展开查看。检查或执行失败的具体原因只在案例区域显示一次，成功检查不占用页面；取消本轮验证的操作仍可用。未运行的后续案例允许在轮到它时修改，不使已经通过的案例证据失效；服务端规范化输入或判定标准后，页面与保存结果一致，最后一项通过即可进入发布确认。修改已运行案例或 Agent 定义则须重新开始整轮验证。委派策略只允许选择已发布目标的精确版本，边界在编辑配置中查看。
2.1. 点击「运行本项」后，当前页签立即显示本项的真实运行过程：自动检查、封存与调度、DSH 执行、终态断言，进行中按服务端持久状态更新；刷新页面后仍能恢复当前进度。等待响应期间不得再次派发同一案例，未开始的其他案例不显示为失败。执行完成后保留可展开的过程记录，同时显示完整回答或具体失败原因；过程区不展示模型内部推理或未经脱敏的 Runtime 日志。
2.2. 五项全部确认通过且发布条件有效时，页底显示「验证通过，确认发布」。数据库返回的 JSON 字段顺序不影响案例内容一致性判断；重新打开已通过的验证页仍可进入发布确认，实际修改案例输入或人工判定标准仍须重新验证。
2.3. 本轮验证尚未开始（或上一轮已失败/取消）时，五个页签的测试输入和人工判定标准都可直接编辑，并可单独保存全部案例；验证开始后只有下一项待运行案例可编辑，已运行案例只读。每个页签只显示本案例自己的输出与结论，不显示其他案例的结果。
2.4. 审核人对当前案例直接选择「通过」或「不通过」。选择「不通过」时必须填写原因才能提交；原因保存到该案例的确认记录，并在失败提示和该案例结果中显示，便于修改后重新验证。服务端拒绝没有原因的「不通过」结论。最后一项通过后提示可以进入发布确认，而不是“继续下一项”。
3. `/trial` 通过逐项接口发起首项试运行，自动检查定义、配置权限兼容性、Skill/Tool 依赖和绑定修订；检查发现阻塞时明确显示原因且不派发 Run。检查通过后由现有 DSH Run/Attempt 链路只派发当前案例，继续复核当前执行授权，展示输出与自动断言；审核人逐项确认人工结论，任一不符合则不得发布。继续后续案例前，事务内核对当前草稿定义与封存指纹，不允许不同草稿定义的案例证据混入同一轮试运行。页面遇到未支持逐项接口的旧后端时不得回退到整轮派发接口。
4. `/review` 以业务语言展示发布决策所需信息：目标版本与对比基线（创建新版本时为其来源版本，首次发布注明无基线）、Soul/工作规程/能力/MCP 范围/运行限制/发布范围的变化项，以及五类案例的输入、结论与不通过原因。候选修订、封存修订、试运行编号和绑定修订收在可展开的「技术详情」中。全部五类案例按顺序分别经 DSH 执行与人工确认后，管理员一次「确认发布」；服务端重新锁定候选并复核修订、授权、依赖、绑定及五份证据，失败不产生部分发布。候选可撤回；既有 `submitted` 候选保留退回和撤回能力。发布不隐式启用已停用 Agent。
5. 发布成功后版本证据（自动检查、逐案例真实试运行及人工确认）写入 `agent_version_evidence`，在版本历史中按版本展示。只有填写了业务确认意见才登记「业务确认」证据，留空时不代填。
6. 试运行与员工执行使用同一权限策略、工具集和超时；外部效果按试运行隔离：需审批的动作直接拒绝（trial_only），MCP 调用返回 trial_only 而不连接外部系统，委派、数据写入与记忆提案均不产生效果。服务重启后仍处于执行中的试运行显示为“服务重启中断”，可直接重新开始；等待人工判定的保留。
7. 编辑器保存回传打开时的修订，不写发布范围；Agent 已被其他操作修改时提示刷新。新版本沿用上一次发布时已改写的案例，未改写的类型按当前定义重新生成；改写平台生成案例后清除“平台生成”标记。

**验收：** 仅界面配置可以创建 Agent；开始前可一次编辑五项案例；每次只运行一个案例，未确认时不能运行下一项；「不通过」必须附原因且原因可见；发布确认页能看出本次变化与各案例结论；自动检查失败不派发 Run；五类案例可在轮到时调整且必须分别人工验证，页签显示未开始、运行中、待确认、已通过或失败，整轮失败不会将尚未执行的后续案例标为失败；五项通过后单次确认发布，定义或已运行案例变更使旧证据失效；版本证据持续可查。P0 覆盖页面流程，P1 隔离 PostgreSQL 覆盖门禁，真实 DSH/OIDC 仍需 P2 留证。

### AG-DELEGATE-01 受控 Agent 委派（PF-06）

**优先级：** P1 · **角色：** 平台管理员配置、获准员工执行 · **运行层级：** 一次性 PostgreSQL + 受控 Runtime；真实 DSH 属 PF-07 P2

1. 管理员为父 Agent 草稿选择一个精确的已发布目标版本，设置深度、并行和超时；发布前能看到完整目标版本及边界。未发布或不存在的版本保存失败，ZIP 包不能携带该平台权限。
2. 员工运行父 Agent，DSH 仅在该版本已配置目标时看到 `delegate_agent`；同一父 Attempt、相同目标和输入的重放只创建一个无 Session 子 Task/Run。子 Task 与父任务使用同一用户和工作空间，并指向根 Task 累计预算。
3. 在角色、数据 Scope 或团队 Agent 成员被撤销后，子任务创建或继续执行被拒绝；父任务取消、失败、撤权或服务重启发现父 Attempt 已失效时，活动子任务被取消并停止新动作。
4. 超过目标允许列表、最大深度、并行上限、Runtime 嵌套容量或等待超时时 fail-closed；子任务失败/取消返回 `not_achieved`，只有文本回答返回 `unverified`，只有平台登记的完成 Artifact/Operation 回执才返回 `achieved`。

**验收：** 目标、权限和预算均不能因委派扩大；父子链及终态可审计；取消与启动恢复能够收敛；父 Agent 不把 `unverified/not_achieved` 汇总成已验证完成。服务端 `test:pf06:integration`、Runtime/授权单测和管理端组件测试固化 P1 受控证据；PF-07 另记录真实 DSH、OIDC、多 Agent 容量与故障证据。

### AG-PROTO-02 生命周期（AG-01，部分已实现）

**角色：** 平台管理员 · **入口：** `/agents` → 详情抽屉「概览与生命周期」/「版本历史」

已实现的为停用（排空，保留进行中 Attempt，与待发布草稿互不阻挡）、启用（含带草稿重新启用）、回滚（仅切换活动版本指针；停用中的 Agent 回滚后仍停用，进行中的草稿保留，过期或并发回滚被拒绝）与版本证据展示。原型中的紧急撤销、卸载归档与单版本撤销暂无服务端语义，已从界面移除；需要时另行设计真实语义后恢复。

### AG-PROTO-03 工具候选治理（AG-02，管理端）

**角色：** 平台管理员 · **入口：** `/tools` → 「候选」视图与详情抽屉

1. 登记独立候选（名称/标识/执行器/Schema 摘要）与随包候选同一流程。
2. 签发测试准入 → DSH 验证 → 发布；发布后并入已发布列表。
3. 详情抽屉查看绑定修订（端点/执行器/凭据槽位/过滤策略/封存时间）、证据与 Agent 引用方。
4. 已发布工具支持停用/启用与紧急撤销；存在阻塞原因（如首版仅只读）的候选不可签发准入。

### AG-REL-02 配置依赖失效阻塞（AG-01）

**优先级：** P1 · **角色：** 平台管理员 · **运行层级：** 隔离 PostgreSQL + 受控 Runtime · **入口：** `/agents/:agentId/release/trial` · **spec：** `server/src/infrastructure/postgres/agent-release-governance.integration.test.ts`

1. 界面配置只能选已发布 Skill 与已登记 MCP；保存时依赖已解析。随后停用已选能力或收窄授权，在第一项页签点击「运行本项」。
2. 服务端自动重检并显示具体阻塞项；失效的精确依赖不生成试运行与 Runtime Attempt。管理员返回配置页更换能力或恢复授权后重试。
3. 若配置或案例在检查与封存之间变化，旧修订不得继续试运行；重试时重新检查并固定新修订。

### Batch 4 自动任务生命周期（AU-01～AU-05）

| ID | 优先级 | 角色 | 旅程 | 前置 | 操作 | 可观察结果 | spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AU-01 | P1 | employee | 永久归档定时任务 | 已启用任务及历史 | 归档；刷新列表；直接读取任务和历史 | 默认列表隐藏，任务与历史均不可读，且无恢复入口 | `e2e/automation.integration.spec.ts`、`server/src/infrastructure/postgres/automation.integration.test.ts` |
| AU-02 | P1 | employee | 超过 50 条历史分页 | 75 条执行 | 连续加载更多 | 75 条不重不漏且 hasMore 最终 false | `e2e/automation.integration.spec.ts`（计划） |
| AU-03 | P1 | employee | 执行抽屉自动收敛 | running execution | 保持抽屉打开 | 状态变终态，取消按钮消失，轮询停止 | `apps/workbench-web/src/views/AutomationsView.test.ts` |
| AU-04 | P1 | employee | 手工触发响应丢失重试 | 服务端受理后丢弃响应 | 点击重试同一意图 | 只产生一个 execution/Run | `apps/workbench-web/src/stores/automation-intents.test.ts` |
| AU-05 | P1 | employee | 保留历史时暂停并恢复调度 | 已启用且有历史的任务 | 暂停；读取历史；重新启用 | 历史持续可读，暂停期间不调度，重新启用后只安排未来槽位 | `e2e/automation.integration.spec.ts`、`server/src/infrastructure/postgres/automation.integration.test.ts` |

## AG-03 轻量自动任务（首版已实现，P0 冒烟通过；P1/P2 待补）

依据：[AG-03 轻量实施方案](../docs/design/automation-implementation-plan.md)。首版不补跑停机遗漏、不自动重试、不续办准备、不新增独立投递系统；任务试运行可选，当前授权和原子去重仍必需。

当前覆盖状态：AG-AUTO-00 已由 `e2e/automation-smoke.spec.ts` 固化（P0，Prototype）；AC-20~24 的事务去重、扫描游标、撤权跳过、重叠、中断收敛、授权基础设施故障、取消/领取竞态与锁释放由服务端 `server/src/infrastructure/postgres/automation.integration.test.ts`（13 例）及 `automation-calendar.test.ts`（8 例，含 DST）覆盖。`e2e/automation.integration.spec.ts` 的 P1 第一批 5 例已实现并通过；`e2e/automation.acceptance.spec.ts` 仍为 P2 计划路径，不表示真实验收已完成。

P1 每例准备独立任务、Session、测试用户与数据，结束后清理；多角色使用独立 browser context/storageState。使用专用可丢弃 PostgreSQL 和受控 Runtime，禁止连接开发业务库或生产库。时钟、故障和执行阻塞由测试环境受控依赖提供，不增加生产测试开关。事务/重启故障同时由服务端集成测试验证，浏览器验证其用户可见结果。

### AG-AUTO-00 自动任务入口与配置反馈

**优先级：** P1（功能优先级）
**角色：** 员工（冒烟测试身份）
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
**spec：** `e2e/automation.integration.spec.ts`（P1 第一批已实现；事务回滚与 Attempt 入队竞态仍由服务集成覆盖）

1. 并发提交同一个立即运行请求，刷新执行记录；同一键更换输入后再次提交。
2. 在受理事务回滚、事务提交后尚无 Attempt、Attempt 已提交尚未入队三个位置分别模拟中断并重启，每个场景使用独立数据。
3. 服务恢复后查看任务记录、关联会话和 Run 详情，再重放原请求。

**验收：** 同触发只产生一组 Session/Run 关联，同键异输入明确拒绝；事务回滚无部分关联。无 Attempt 的已受理 Run 显示准备中断失败，未自动续办；当前 queued Attempt 由原 Run 恢复，Worker 丢失则失败，不另建 Attempt 或运行。重放不会把旧失败变成新执行。

### AG-AUTO-21 日历、遗漏与明确再次运行（AC-21）

**优先级：** P0（功能优先级）
**角色：** 任务创建者
**运行层级：** P1 集成用户旅程（DST 边界同时由日历单元测试覆盖）
**前置数据：** 固定测试时钟、具有夏令时的 IANA 时区、每日/每周任务及可失败 Runtime
**spec：** `e2e/automation.integration.spec.ts`（P1 第一批已实现失败/遗漏/明确再运行；DST 与游标由日历/服务测试覆盖）

1. 预览跨夏令时的下次运行，再推进受控时间到对应槽位。
2. 模拟跨多个槽位停机后启动，查看遗漏说明和下次运行；另例暂停后重新启用、修改规则后收到旧规则回调。
3. 让一次执行失败，观察没有自动重试；明确点击再次立即运行，并重放该手动请求。

**验收：** 缺失本地时刻跳过，重复时刻只取第一次；预览与调度一致。停机遗漏按区间留痕，旧规则及暂停期间不补跑；恢复安排未来槽位。失败不自动重试，再次运行产生新触发及新 Session/Run，同一手动请求重放不再增建。

### AG-AUTO-22 当前授权与个人/团队空间撤权（AC-22）

**优先级：** P0（功能优先级）
**角色：** 创建者、另一员工、执行收权操作的管理员
**运行层级：** P1 集成用户旅程；真实目录与工具边界另做 P2
**前置数据：** 独立个人/团队空间、角色及数据范围、受控目录同步状态、可阻塞排队和工具调用的 Runtime
**spec：** `e2e/automation.integration.spec.ts`（P1 第一批已实现账号停用与另一员工读取拒绝；团队/文件/能力撤权及故障矩阵待补）

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
**spec：** `e2e/automation.integration.spec.ts`（P1 第一批已实现固定版本与暂停入口；配置拒绝和排队暂停细分待补）

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
**spec：** `e2e/automation.integration.spec.ts`（P1 第一批已实现车道保留、取消后排队恢复及结果投影；持久化故障与全预算边界待补）

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
**角色：** 平台管理员（冒烟测试身份）
**运行层级：** P0 浏览器冒烟
**前置数据：** 管理端 Prototype 会话
**spec：** `e2e/mvp-smoke.spec.ts`

1. 打开管理端任意页面，左侧导航「开发接入」组可见「接入规范」「接口文档」两项。
2. 进入「接入规范」，验证认证流程、API 包络与事件流章节可见，并可下载 Markdown 版规范（`dsh-work-移动端接入规范.md`，源文件 `docs/development/mobile-integration-guide.md`）。
3. 进入「接口文档」，验证移动端 H5 API 契约渲染且非空（`openapi-mobile-h5.json`，仅收录移动端实际调用的 Workbench 子集，含结构化入参/返回字段），并可下载该 OpenAPI JSON。

**验收：** 两个页面无需离开管理平台即可阅读与下载；接口文档内容与仓库移动端 OpenAPI 契约一致（构建期内嵌，同版本发布）；下载产物适合 Agent/其他工程直接消费（Markdown 规范 + OpenAPI JSON）。

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

**可观察结果：** 主导航依次保留「新对话、Skill 广场、AI 同事、团队空间、自动任务」；目录只展示服务端按当前员工授权返回的已发布对象。卡片选择只负责预选已有 Skill/Agent，不赋予员工上传、安装、编辑、发布或调整能力依赖的权限。

**spec：** `e2e/personal-workbench.spec.ts`

- **P0 原型导航**，普通员工，内存合成资料：主导航只显示新对话、Skill 广场、AI 同事、团队空间和自动任务；历史对话与我的文件保留上下文入口及直达路由，不显示为主导航项。个人空间不作为可管理卡片或选择器，旧个人链接继续解析到本人资源入口。对应 `e2e/personal-workbench.spec.ts`。原型不承诺持久化或真实执行。
- **P1 集成工作闭环**，有效员工 A 与 B，独立可丢弃 PostgreSQL + 受控身份、无真实模型：准备 A 的 60+ 轮旧会话、空会话、个人材料、会话附件、生成成果及一个已撤权团队。通过页面搜索并恢复旧对话；上传和引用文件；下载并逻辑移除；对话移除后成果保留、来源标记已移除。B 和失权团队数据不得返回。对应 `e2e/personal-integration/closure.spec.ts` 与服务器 `review-b3/b4/b5` 集成套件；页面的 API 模拟测试只证明交互，不代替这些真实 PostgreSQL 测试。
- **P1 归属与竞态**：团队页面发起明确团队任务；随后全局新对话仍属个人，默认个人解析失败不得回退团队；切换用户/筛选后迟到响应不得恢复旧内容。对话/资源恢复不改变 Workspace 归属。
- **P2 真实验收**：上述闭环追加真实 OIDC、DSH 与企业扫描及成果质量检查，单独留证，本轮未运行不得标记业务验收通过。

**本批实际执行记录：** P1 使用专用 PostgreSQL、受控 HTTP 与合成 Runtime，不使用页面 API 拦截。浏览器预演和首条 Playwright 均因容器 Chromium URL 管理策略报 `ERR_BLOCKED_BY_ADMINISTRATOR`；其他浏览器用例未运行，未宣称浏览器通过。组件/Store 和真实数据库 HTTP 回归已单独通过；详见 `docs/development/review-d12-evidence.md`。

## 批次 4 管理操作（C6/C7）

- C6 / P1 / 有写权限管理员：隔离 PostgreSQL、合成 DSH 工具结果中有一个现存草稿；在管理助手描述改标题，看到精确差异与“一次确认”标识，确认前草稿不变，确认一次后只改草稿文案；已有 AGENTS 工作规程与 `none`/`selected` MCP 范围不因文案更新变成默认 `all`，试图在一次确认请求中更改这些字段须拒绝；权限/发布/Runtime 任务仍显示委派确认和最终计划确认。只读管理员不出现确认按钮。对应 `e2e/admin-review.spec.ts`（浏览器可运行环境预演后固化；真实 DSH 属 P2）。

### C7 链接导入待浏览器预演

- C7 / P1 / 有写权限管理员：进入新增 Skill 的链接入口，提供受支持 HTTPS 地址，解析后查看来源/摘要/依赖/阻断原因，确认保存草稿。DSH 不可用时仍能存可解析草稿，界面显示不可发布而不声称测试通过。对应 `e2e/admin-review.spec.ts`（受控下载、不访问真实企业资源；真实外网与 DSH 验收另行记录）。

前置数据：隔离一次性 PostgreSQL、合成管理员及受控公共下载制品；按“来源 → 固定摘要 → 显式保存草稿 → 试运行未通过或 DSH 不可用时发布拒绝”验收。禁止连接真实企业库。当前 Chromium 首次导航被 ERR_BLOCKED_BY_ADMINISTRATOR 拒绝，未通过浏览器 Verify，不创建伪通过 spec；上述文件名为待实现旅程目标。现阶段 HTTP/组件测试已进入 CI，不能代替该旅程。

## PF-03 MCP Connector 治理

### PF-MCP-01 Connector 自动生效与全 Agent 可用

**优先级：** P0（治理边界）

**角色：** 平台管理员

**运行层级：** P1 集成用户旅程

**前置数据：** 隔离一次性 PostgreSQL、受控管理员、可改变 Tool 清单的合成 MCP 发现 Runtime、一个已发布 Agent；不得连接开发业务库或生产服务

**spec：** `e2e/admin-mcp-connector.integration.spec.ts`、`server/src/infrastructure/postgres/mcp-connector-governance.integration.test.ts`、`server/src/infrastructure/postgres/mcp-auto-activation-upgrade.integration.test.ts`

1. 在“MCP 连接器”页面填写名称与 Streamable HTTP 地址，登记“上游权限说明”（说明凭据和上游服务的访问边界，不执行数据过滤）；受保护端点选择“无认证”时，“测试连接”显示该服务要求 Bearer Token，不将上游 401/403 折叠为通用 `Internal error`。填写 Bearer Token 后，“添加 MCP”保持禁用，直到执行不落库的“测试连接”并成功发现 Tool；修改名称、地址、认证方式或 Token 会使测试结果失效。添加接口再次通过 DSH 复核，复核失败不写入 Connector 或凭据；成功后平台生成 Connector 标识与 MCP 命名空间，Token 加密入库且不回显，连接器与当前 Tool 清单立即生效。
2. 列表保持与 Skill 管理一致的工具栏、表格和分页结构，不增加统计卡片；列按“名称、Endpoint、认证方式、工具数量、状态、更新时间、添加时间、添加人员、操作”排列。“工具数量”可打开 Tool 名称、描述和输入 Schema 清单；操作列直接提供查看、检查，其余凭据轮换、停用或启用、删除收进“更多”；页面不出现 Agent 权限或整体审核入口。
3. 登记成功后无需授权操作，已发布 Agent 的新 Attempt 自动解析该 Connector；确认数据库没有 Agent→Connector Grant 表，也没有在平台 Tool 列表生成 MCP Tool。详情明确显示“适用 Agent：全部 Agent”。
4. 合成发现 Runtime 新增一个 Tool 后重新检查；确认新清单与摘要自动生效，连接器保持健康，全部 Agent 的新 Attempt 使用最新摘要，详情显示每个 Tool 的名称、描述和输入 Schema。
5. 从列表轮换 Bearer Token，确认旧值不回显；新 Token 检查成功后自动恢复生效，检查失败时保持异常且不进入任何 Agent 的新 Attempt。人工停用状态不会被检查自动解除。
6. 人工停用 Connector 后再次执行检查，状态保持“已停用”；清单可以同步，但所有 Agent 的新运行和在途调用均被拒绝。只有显式启用操作才能恢复健康状态和默认可用性。
7. 从列表删除 Connector 并二次确认；列表立即移除该项，所有 Agent 后续运行不再解析该连接，独占 Bearer 凭据销毁；Connector 行、能力快照、健康检查和调用审计继续保留用于追溯。
8. 从旧版“等待审核/需要重新审核”状态升级时，分别构造“当前 Bearer 凭据晚于最近检查”和“当前凭据已有后续检查”两种记录；前者保持 `degraded` 且对所有 Agent 不可用，后者才允许自动生效。对已经被旧迁移错误恢复的记录，纠正迁移应重新要求检查且不得伪造健康检查证据。
9. 将租户健康 MCP Connector 填充至 19 个后并发登记两个连接器；仅一个成功。达到 20 个后，新增、重新启用和离线连接器检查恢复均返回容量冲突，原状态不变，任一 Agent 新 Attempt 仍最多得到 20 个连接器。

**验收：** MCP 复用现有 Connector 管理。管理员无需填写内部标识、命名空间或所属系统；Bearer Token 只在新增或轮换时输入，查询与详情不回显。连通测试不持久化 Connector 或 Token，测试成功后才能添加，添加时仍由服务端重新测试，不能只依赖页面状态。成功发现的 Tool 名称、描述、输入 Schema 与摘要自动成为当前生效快照，并默认对全部 Agent 可用；系统不提供 Agent 或逐 Tool 权限管理。健康检查和凭据轮换不能覆盖人工停用；只有健康且能力快照已同步的 Connector 才会进入 Agent Attempt。升级迁移只能使用晚于当前凭据的检查证据，无法确定检查与凭据版本顺序时保持 `degraded`。停用和删除会移除运行可用性，删除同时销毁独占密钥但保留治理证据。P1 浏览器证明真实 PostgreSQL 管理状态和页面边界；加密密文、运行时解密、DSH 调用与逐调用审计由 Runtime/服务集成测试覆盖，真实外部服务证据留 PF-MCP-P2。

### PF-MCP-P2 真实 MCP 与 DSH 发布前验收

**优先级：** P0（发布门禁）

**角色：** 连接器管理员、Agent 管理员、真实员工

**运行层级：** P2 真实验收

**前置数据：** 目标 DSH Lock/Adapter、真实 OIDC、批准的 Streamable HTTP MCP 服务和受管凭据

**spec：** 受控发布环境验收记录（不纳入普通 CI）

1. 留存服务身份和发现清单摘要，使用至少两个不同 Agent 的真实员工任务分别触发一次成功 MCP Tool 调用，并核对业务只读结果和审计。
2. 分别演练错误凭据、MCP 超时/取消、服务新增 Tool、Connector 停用和删除；核对 Run/Attempt 终态及后续调用是否停止。
3. 检查 DSH Worker Patch 和环境边界，确认密钥正文未进入 PostgreSQL、Manifest、前端响应、Patch 文件或普通日志。

**验收：** 真实 DSH 为所有 Agent 只加载健康且能力快照已同步的 Connector；调用、失败、停用和删除均可追溯。P1 合成 Runtime、一次性 PostgreSQL和管理页面绿灯不能替代本层证据。

## PF-04 持久化等待与动作审批

### PF-WAIT-01 动作绑定审批与新 Attempt 恢复

**优先级：** P0（执行安全边界）

**角色：** 普通员工、平台管理员

**运行层级：** P1 服务集成与管理端组件旅程

**前置数据：** 隔离一次性 PostgreSQL、受控员工与平台管理员、合成 ACP Worker；一个要求逐次审批的工具动作；不得连接开发业务库或真实外部写系统

**spec：** `server/src/infrastructure/postgres/pf04-persistent-wait.integration.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`apps/admin-web/src/views/ApprovalManagementView.test.ts`、`e2e/mvp-smoke.spec.ts`（P0 页面交互）

1. Agent 请求受控动作后，平台从可信策略日志取得并校验参数；审批固定动作、参数摘要、资源、执行身份、数据版本和有效期。审批在内部准备阶段不可查看或处理，只有来源 Attempt、Run 与审批记录原子进入 `waiting` 后才对管理员可见，Worker 随后保持释放。
2. 重启服务，确认等待 Run 不被活动 Attempt 恢复逻辑判失败，也不在审批前重新排队。
3. 管理员在“动作审批”查看绑定事实并批准；平台重新检查当前输入、身份、Agent/工具/MCP 绑定、批准有效期和检查点内容，从检查点创建一个新 Attempt。恢复 Manifest 明确引用来源 Attempt、审批、检查点摘要、精确待执行参数、此前工具结果、输出工作文件和未提交部分回答。
4. 重放相同决定，确认返回同一恢复 Attempt；提交相反决定返回冲突。恢复 Attempt 第一次请求完全相同动作可使用批准，第二次调用或参数、资源、数据版本变化必须重新申请；`output/库存报告.md` 等安全 Unicode 工作文件可恢复，路径遍历被拒绝。
5. 分别拒绝、到期、员工取消和系统撤权，确认审批和检查点进入终态、写入员工端可见终态事件、Run 结束且不创建恢复 Attempt；批准后排队超过有效期也不得消费动作。
6. 在审批准备阶段终止来源 Attempt 并发起重试，确认旧审批和检查点被取消、不会阻塞新审批；令旧审批随后到期，确认它不能结束当前重试 Attempt。
7. 并发提交批准和拒绝，确认只有先提交的决定生效；相反决定返回冲突，页面不得提示未生效的决定成功。
8. 对 `approval_mode=never` 的工具先生成超过持久化检查点上限但仍在 Run 输出预算内的部分回答，再请求权限，确认调用直接按策略继续且不创建检查点。
9. 在来源 Attempt 留下 PF-01 `unknown` 外部操作，批准时必须阻断；先查询权威系统并收敛操作回执后才允许重新决定。
10. 连续发送恢复 Attempt 的排队、输出与开始事件，确认只发起一次权威刷新并按事件顺序应用；再发送迟到的来源 Attempt 完成事件，确认不能修改当前 Run 或恢复 Attempt。

**验收：** 一次批准最多授权一个未过期且完全相符的动作调用并最多创建一个恢复 Attempt；新 Attempt 恢复输出工作文件并使用已校验上下文，员工端合并一次 current Attempt 刷新后按序接收事件；等待不占 Worker；准备中的审批不可提前处理，来源终止后无遗留活动检查点，旧审批不能影响当前重试；并发相反决定明确冲突；无需审批不捕获检查点；重启、重复决定、并发刷新和迟到事件不重复业务动作或回退界面；效果未知不会自动重发。当前 DSH 使用“平台检查点 + 新 Attempt 重建上下文”，不声称恢复原 ACP Session。

### PF-WAIT-P2 真实 DSH 与撤权验收

**优先级：** P0（发布门禁）

**角色：** 真实员工、平台管理员、安全管理员

**运行层级：** P2 真实验收

**前置数据：** 目标 DSH Lock/Adapter、真实 OIDC、批准的测试写动作与可查询权威回执、目标环境重启权限

**spec：** 受控发布环境验收记录（不纳入普通 CI）

1. 使用真实 DSH 触发动作审批，证明等待期间 Worker 已释放，批准后新 Attempt 只执行批准快照。
2. 在等待期间分别撤销员工、空间、Agent、工具和 MCP 权限；批准时确认无法恢复，授权服务故障与已确认撤权分别记录。
3. 在审批前后重启服务并重放决定/事件；对真实外部动作制造超时未知，核对权威状态后再继续。

**验收：** 留存身份、Run/Attempt、检查点、审批、外部回执、重启和撤权证据。一次性 PostgreSQL、合成 ACP Worker和组件测试通过不能替代本层。

## EXPERIENCE-ITERATION Agent 经验迭代

> 员工端受控记忆功能已经移除。当前管理模块改为按稳定 Agent 管理经验迭代申请；后续原 PF-05/AE-04 流程只保留为历史实现说明。

### EXPERIENCE-ITERATION-01 按 Agent 查看并审核经验申请

**优先级：** P0 · **角色：** 平台管理员 · **运行层级：** 管理端组件、API 契约与 P0 浏览器冒烟<br>
**前置数据：** 至少两个 Agent，其中一个 Agent 的成功 Run/Attempt 通过受控工具提出经验申请，另一个 Agent 无申请<br>
**spec：** `apps/admin-web/src/views/ExperienceIterationView.test.ts`、`server/src/http/api-contract.test.ts`、`e2e/mvp-smoke.spec.ts`

1. 管理端主导航显示“经验迭代”，不再显示“受控记忆”；页面直接以单一表格展示所有经验申请，不设置左侧独立 Agent 列表。
2. 每行显示所属 Agent，并固定来源 Agent Version、Run、Attempt、Agent Principal、摘要和创建时间；顶部可按 Agent 或状态筛选。
3. 只有成功 Attempt 产生的未过期经验提案进入待审核列表；员工端没有提交、授权或撤回入口。
4. 平台管理员批准后创建不可变经验版本，拒绝则不发布；两种决定都保留审核人、审核时间和说明。批准经验仅属于同一稳定 Agent，不跨 Agent 使用。
5. 经验是非权威参考，不能自动修改 Soul、Skill、Tool、权限或权威业务事实；这些变化仍必须创建新 Agent Version 并重新评测发布。

**验收：** 管理员进入页面即可查看跨 Agent 的申请列表，可按 Agent 筛选并核对 Run/Attempt 证据后批准或拒绝；列表、审核 API 与页面均使用经验迭代契约，不再暴露管理端受控记忆端点。

### MEMORY-EMPLOYEE-REMOVAL 员工端记忆功能已移除

**优先级：** P0（产品边界） · **角色：** 普通员工 · **运行层级：** 组件、契约与 P0 浏览器冒烟<br>
**spec：** `apps/workbench-web/src/views/ConversationView.test.ts`、`apps/workbench-web/src/views/SettingsView.test.ts`、`server/src/http/api-contract.test.ts`、`e2e/mvp-smoke.spec.ts`

1. 成功 Run 的回答区不显示“提交受控记忆候选”，员工用户中心不显示受控记忆授权或撤回入口。
2. Workbench API 不注册提案读取、候选提交、授权查询和授权撤回端点；前端客户端和 DTO 不保留对应方法与类型。
3. 平台不得把回答、Session 历史、业务记录、文档原文或员工偏好自动转成记忆。
4. 管理端经验迭代只处理 Agent 主动提出的申请；不允许据此宣称 Agent 会自动学习、自主发布经验或自我修改。

**验收：** 员工无法通过界面或 Workbench API 创建、查看或撤回记忆候选与授权；经验申请由 Agent 在统一 Run/Attempt → Runtime Adapter → DSH 链路中提出，并进入独立管理端审核。

### 历史流程（已退役）

### PF-MEMORY-01 明确授权、审核发布与固定引用

**优先级：** P0（隐私与上下文边界）

**角色：** 普通员工、平台管理员

**运行层级：** P1 服务集成与前端组件旅程

**前置数据：** 隔离一次性 PostgreSQL、受控员工与平台管理员、一个成功 Attempt、已发布 Agent Version；不得连接开发业务库或生产服务

**spec：** 历史实现已退役，不作为当前发布验收入口；现行入口见 `EXPERIENCE-ITERATION-01` 与 `MEMORY-EMPLOYEE-REMOVAL`

1. 员工从本人成功 Attempt 打开“提交受控记忆候选”，主动填写稳定偏好或可复用经验，明确选择仅本人、当前工作空间或组织范围，并选择保留期限。团队成员查看他人发起的共享 Run 时不显示且不能打开该入口。平台不得自动复制回答、Session 历史、业务记录或文档原文。
2. 串行或并发提交相同幂等键都只产生一个候选和一条来源授权；修改内容、来源或保留期后复用该键返回冲突。候选审核前不能进入 Runtime 检索。
3. 管理员在“受控记忆”查看来源、范围、保留期、内容和摘要，批准后创建独立不可变版本；拒绝或来源已撤回、过期时不发布。相同审核决定与相同键可重放，相反决定明确冲突；撤回或过期后的审核重放只能返回脱敏正文。
4. 使用匹配查询创建新 Attempt，确认只解析与当前用户、工作空间、角色和稳定 Agent 身份同时匹配的当前版本；同一 Agent 的新定义版本可继承，其他 Agent 不可继承。Manifest 固定记忆版本和摘要，运行输出列出非权威记忆引用。
5. 令用户退出空间、撤销 Manifest 固定角色、增加新角色、切换到其他 Agent 或升级记忆，确认角色 ACL 始终取当前角色与 Manifest 快照角色的交集，旧引用不能在领取或等待恢复时继续使用。新角色不能扩大旧 Attempt，新版本只影响新的 Attempt，不原地改写历史 Manifest。
6. 员工在用户中心撤回来源授权；确认新的检索返回空、已固定但尚未执行或等待恢复的 Attempt 被阻断，已完成运行的来源引用和审核审计仍可追溯。
7. 验证记忆提示明确标为非权威参考，不能覆盖系统指令、当前权限、工具结果或权威业务记录。

**验收：** 未经用户明确授权和管理员审核的内容不进入 Agent 上下文；检索与恢复均执行当前 ACL、来源、保留期和固定记忆版本检查；撤回立即阻止未来使用但保留必要审计；记忆版本不可变，冲突通过新版本收敛；平台不建立第二套 Agent Loop，也不把知识库、业务台账、聊天历史或检查点伪装成记忆。

### PF-MEMORY-P2 真实 DSH 与身份变化验收

**优先级：** P0（发布门禁）

**角色：** 真实员工、平台管理员、安全管理员

**运行层级：** P2 真实验收

**前置数据：** 目标 DSH Lock/Adapter、真实 OIDC、批准用于验收的非敏感偏好或经验、可执行身份/空间/角色变化

**spec：** 受控发布环境验收记录（不纳入普通 CI）

1. 使用真实 DSH 与显式声明 `propose_memory@1.0.0` 的 Agent 完成提案、来源 Attempt、员工同意、管理员审核和匹配查询，留存工具调用、Manifest 固定版本、`memory.md` 投影、运行输出引用与审计证据；发布试运行只返回 `trial_only`。
2. 分别变化员工身份、团队成员关系、角色、同一 Agent 定义版本和目标 Agent 身份，确认跨用户、跨空间、跨角色及跨 Agent 被阻断，同一 Agent 的新定义版本只有通过当前 ACL 复核才能使用旧记忆。
3. 在运行领取前和持久化等待期间撤回授权，确认 Runtime 不继续执行；已完成结果仍显示当时实际引用的版本。

**验收：** 真实身份、DSH Prompt、Run/Attempt 固定引用、撤回和审计证据形成闭环。一次性 PostgreSQL、组件测试与合成 Runtime 绿灯不能替代本层。

## AE-04 Agent 主动记忆提案

### AE-MEMORY-01 提案、人工确认和只读投影

**优先级：** P0/P1 · **角色：** Agent 执行身份、发起员工、平台管理员 · **运行层级：** 原型浏览器冒烟、一次性 PostgreSQL、受控 ACP Runtime 和前端组件<br>
**前置数据：** 已发布且显式引用 `propose_memory@1.0.0` 的 Agent；本人可访问的成功 Attempt 与隔离管理员<br>
**spec：** `e2e/mvp-smoke.spec.ts`、`server/src/infrastructure/postgres/pf05-controlled-memory.integration.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`apps/workbench-web/src/views/ConversationView.test.ts`

1. Agent 在真实 Run 的 DSH 工具桥提出偏好或经验；平台只保存与来源 Run/Attempt、Agent Version/Principal、发起人和空间绑定的 7 天提案。同一内容重放不复制；未声明工具、失效 Attempt 和停用身份不能提案。发布试运行仅返回 `trial_only`，不生成真实提案。
2. 员工仅在本人成功 Attempt 查看未过期提案；可以改为自行填写，或核对 Agent 提案全文并自行选择使用范围与期限。他人、未成功 Attempt 和已提交提案不显示正文；篡改提案正文或重复提交返回冲突。
3. 管理员审核之前任何提案和已同意候选都不能进入后续 Agent 上下文；审核后同一 Agent 的新定义版本可按当前 ACL 使用，其他 Agent、其他用户及团队空间不能继承私人内容。撤回和到期立即阻止新使用，未同意到期提案由清理任务删除。
4. 新 Attempt 仅将本次固定且获准的少量记忆写入 `workspace/memory.md`，文件权限为只读；Manifest/Prompt 标记其为非权威参考。领取、运行和等待恢复时继续复核当前来源、范围、身份、摘要与撤回状态。

**验收：** 提案、同意、审核及执行引用是四个独立状态；`propose_memory` 的成功回执仅表示暂存，不表示已批准或业务目标完成。P0 浏览器冒烟证明员工必须明确选择范围和期限；P1 自动化证明平台边界；真实 DSH、OIDC 与跨账号收权仍按 PF-MEMORY-P2 单独留证。
# AE-05 · Agent 主动任务（P1 集成旅程）

- **优先级／角色／层级：** P1；平台管理员和结果接收员工；一次性 PostgreSQL、受控 Runtime、独立浏览器会话。
- **前置数据：** 已发布 Agent Version、已启用的 Agent Principal、授权团队空间及明确的接收员工；专用可丢弃数据。
- **操作：** 管理员在 Agent 详情确认角色与数据范围上限并启用规则，手动触发、查看执行记录，再暂停；服务集成测试创建手动、定时和事件规则并重复触发相同事件，检查错过槽位及接收人读权限。
- **可观察结果：** 浏览器中批准、触发和暂停状态与执行记录一致；服务集成中仅一次受理，重叠和遗漏有原因，Task 发起与执行身份均为 Agent Principal，Run 无员工 Session；停用或收权阻断后续动作，仅指定接收人且有当前 Workspace 授权者能看到结果。
- **Spec：** `e2e/agent-routines.integration.spec.ts`（独立 P1 管理端配置）；`server/src/infrastructure/postgres/agent-routines.integration.test.ts`（服务、身份、接收结果）。员工浏览器和真实 DSH/OIDC 另列 P2 验收。

## EX-02 跨轮成果延续

### EX-TOOL-01 工具调用结果在执行步骤中可见

**优先级：** P1 · **角色：** 员工 · **运行层级：** 一次性 PostgreSQL、Mock ACP Worker、平台工具桥<br>
**前置数据：** 一次 Run 中有成功、失败和未返回结果的工具调用<br>
**spec：** `server/src/modules/runtime/tool-call-summary.test.ts`、`server/src/modules/runtime/platform-tool-bridge.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`

1. Attempt 成功结束时，每次工具调用按顺序产生一条 `tool.completed` 事件，均在 `run.completed` 之前；`run.completed` 带工具调用总数和失败数。
2. Attempt 失败时，已发生的工具调用仍在 `run.failed` 之前登记。
3. 平台工具失败显示与错误码对应的固定原因（如“调用参数不符合工具要求”“已达到本次执行的工具调用次数上限”）；未知错误码和内置工具失败显示“工具返回失败”；无结果记录显示“未收到调用结果”。
4. 事件不含工具参数和输出内容。
5. 工作台执行步骤逐条显示工具名与结果，失败步骤为失败状态；结果核验显示“工具调用 N（失败 M，原因见执行步骤）”。

**验收：** 上述测试通过；P2 另需在目标环境用真实 DSH 让 Agent 读取一个不存在的文件，确认执行步骤出现失败的工具调用、任务本身仍可完成，并留证 Run/Attempt 与 DSH 版本。

### EX-ARTIFACT-01 引用上一轮成果并产生新版本

**优先级：** P1 · **角色：** 员工（成果发起人）、同空间外的另一员工 · **运行层级：** 一次性 PostgreSQL、受控 Runtime、Manifest 编译器与前端组件<br>
**前置数据：** 个人或团队会话中一次成功 Run 已登记的 Markdown、文本、CSV 或 HTML 成果<br>
**spec：** `server/src/infrastructure/postgres/m3-orchestration.integration.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/modules/runtime/runtime-manifest-schema.test.ts`、`apps/workbench-web/src/views/ConversationView.test.ts`

1. 成果发布时保存原文文本作为解析结果；回答下方的成果卡片对可引用成果显示“继续修改”，点击后成果以“名称 · V版本”标签出现在输入框上方，可移除；不可引用（非 UTF-8、空文件或超长）的成果不显示该入口。
2. 发送下一条消息时，成果按既有附件权限重新校验后只读挂载；Manifest 的挂载项带 `artifact_revision`，Runtime 说明提示“修改时写回同名文件，登记为下一版”。
3. 本轮挂载了同会话成果且输出同名文件时，登记为该成果的下一版本；未引用或同名指向多个成果时作为新成果。旧版本保持可下载。
4. 另一员工不能把他人成果挂进自己的会话；团队会话中未 @Agent 的讨论消息不能携带引用成果。

**验收：** 两轮后同一成果有 V1、V2，两版下载内容分别为原文与修改后内容；附带的新文件是独立成果；跨用户引用被拒绝。P2 另需在目标环境用真实 DSH 完成“第一轮生成 Markdown/CSV、第二轮修改指定部分”，下载两版核对差异，并留证 Run/Attempt 与 DSH 版本。

## B5 不可变版本选择与 Session 导出（VE）

| ID | 优先级 | 角色 | 前置 | 操作 | 验收 |
| --- | --- | --- | --- | --- | --- |
| VE-01 | P1 | employee | Agent 选择后发布新版本；广场显示 v1 | 选择 v1；管理员发布 v2；提交 | Session 仍绑定 v1 |
| VE-02 | P1 | employee | Skill 选择后发布新版本；广场显示 Skill v1 | 选择 v1；发布 v2；提交 | Session 仍绑定 Skill v1 |
| VE-03 | P1 | employee | 所选版本失效 | 选择后版本被停用；提交新对话 | 返回明确冲突并要求重新选择，不静默换版 |
| VE-04 | P1 | team member | 导出完整团队 Session；纯讨论 + 两个 Run | 选择导出完整会话 | 文件包含三段内容和 scope=session 元数据 |
| VE-05 | P1 | employee | 导出单 Run；多轮 Session | 选择导出本次 Run | 只包含该 Run，文件名/元数据明确 scope=run |

**spec（计划）：** `e2e/version-selection-export.integration.spec.ts`（P1，待 Green gate 固化）
