# 管理端模块权限方案

**状态：** 决策已确认（AP1～AP10，2026-11-13；AP11～AP17，2026-11-14，其中 AP11、AP12 取代 AP4、AP6；AP18、AP19，2026-11-15，#127 评审后补充）。AMP-S1（服务端）已合入（#126）；AMP-S2 实施中（员工与权限、钉钉集成改为模块，管理端前端按模块控制），P0/P2 未验收。其余能力在实施并通过第 9 节验收前均不可用，现行规则仍以[功能规则](../development/feature-rules.md)和代码为准。<br>
**更新日期：** 2026-11-14（AMP-S2 原型确认：员工与权限、钉钉集成改为可按模块授权并补防提权规则 AP11～AP13；角色编码系统生成 AP14；菜单与落地页 AP15；数据范围不改 AP16）；2026-11-13（初稿）；2026-11-13（按 PR 评审修订：补“授出不超过自身”原则，堵住组织架构与 Agent 岗位权限两条提权路径；定义三类管理员；钉钉与独立账号保持只限平台管理员；补管理助手读取范围与 Run 内校验；更正现状描述）；2026-11-13（AP1～AP10 按建议确认：模块不合并，Session 摘要归运营查看）<br>
**依据：** 当前身份与授权实现（`server/src/modules/identity`、`server/src/modules/authorization`、`server/src/http/router.ts`）、[管理端 OpenAPI](../development/openapi-admin.json)、[数据模型第 1 节](data-model.md#1-租户身份与授权)。<br>
**关联：** [架构总览第 9 节](../development/overview.md#9-身份安全与数据边界)、[功能规则第 8 节 Agent 岗位权限](../development/feature-rules.md#8-agent-岗位权限)、[企业组织架构方案](org-structure-plan.md)（部门授权）、[发往模型的数据防护方案](model-data-protection-plan.md)（`data-protection:terms`）。

## 1. 背景与目标

管理端主要按两级授权：`admin:read` 可查看管理页面，`admin:write` 可修改管理配置。在此之上已有若干更严格的例外：

| 范围 | 现状 |
| --- | --- |
| 员工与权限的写操作 | 路由层只限 `admin:*` |
| 独立账号管理 | 服务层只限本地授予的 `admin:*`（`local-auth-service.ts` 的 `assertPlatformAdmin`） |
| 钉钉集成全部接口（含只读） | 服务层只限本地授予的 `admin:*`（`dingtalk-admin-service.ts` 的 `assertPlatformAdmin`）；路由层允许 `admin:read` 进入，但服务层拒绝 |
| 审计与运行治理 | 路由层只看 `audit:read` 或 `admin:*` |
| 保密词表与白名单 | 路由层先要求 `admin:read` 或 `admin:write`，路由内再要求 `data-protection:terms`（或 `admin:*`），两者同时满足 |
| 经验审核、持久化审批处置、Skill 审核与安装等服务层写操作 | `requirePlatformAdmin` / `requirePlatformAdminActor`：本地授予的 `admin:*` 或 `admin:write` |

问题：

- 想让一个人只维护企业知识库或只管模型，只能给 `admin:write`，他同时可以改 Agent、Skill、MCP 凭据等全部配置；
- 管理权限判定散落在路由入口、会话层、约 120 处服务层调用和多段 SQL 中（第 6 节），“平台管理员”一词在不同位置含义不同，单改路由入口无法真正收窄。

目标：

- 管理端按模块授予查看或修改权限，模块管理员只能看到并操作自己的模块；
- 现有角色不迁移、含义不变；
- 不引入新的提权路径：任何非平台管理员都不能授出自己没有的权限，不能经部门、Agent 或管理助手绕过。

## 2. 边界

- **只调整管理端（Admin Audience）。** 员工端权限（`workbench:*`、`knowledge:view|docs|bases`）和项目空间角色不变。
- **不做对象级授权。** 本期按模块授权，不做“只管某几个 Agent / 某几个知识库”；对象级授权另行立项。
- **不改授权机制。** 仍是 `roles.permissions` + `user_roles`，请求时从 PostgreSQL 重新计算，授权变更递增授权版本；不新增权限表。
- **平台管理员专属范围（AMP-S2 起）。** 只剩“平台管理员”角色本身与 `admin:*` 的授出、钉钉应用配置的保存与清除；员工与权限、独立账号、钉钉集成的其余操作按模块授权并执行 AP13（原 AP4、AP6 已被 AP11、AP12 取代）。
- **不改 Agent 执行链路。** 管理助手仍经 DSH 执行，本方案只调整平台侧的读取范围与确认、执行前校验。

## 3. 术语

| 术语 | 定义 | 现有对应 |
| --- | --- | --- |
| 平台管理员 | 持有**本地授予**（`source_key = 'local'`）、有效期内、启用状态角色中的 `admin:*` | `requirePlatformAdminOnly`：钉钉应用配置；`isPlatformAdminActor`：“授出不超过自身”与对象约束的豁免 |
| 全模块管理员 | 持有本地授予的 `admin:write`（全模块修改）或 `admin:read`（全模块查看） | 服务层 `requirePlatformAdminActor` 现接受 `admin:write`，本方案起该函数改名并按模块判定（6 节） |
| 模块管理员 | 持有本地授予的 `admin:<模块>:read` / `write` | 新增 |

文中“非平台管理员”包括全模块管理员与模块管理员。所有管理判定都只认本地授予的角色：会话层计算出的权限还包含部门授予（`department:%`）和外部目录同步的角色，服务层判定必须保留 `source_key = 'local'` 条件。

## 4. 已确认决策（2026-11-13）

| 编号 | 建议 |
| --- | --- |
| AP1 | 权限码命名为 `admin:<模块>:read` / `admin:<模块>:write`，`write` 包含 `read`。`admin:read`、`admin:write` 保留，含义为“全部模块”的查看 / 修改；`admin:*` 不变。前缀统一为 `admin:`，与员工端的 `knowledge:view|docs|bases` 区分 |
| AP2 | 模块按第 5.1 节划分：Agent、Skill、工具与连接、模型、数据防护、企业知识库、组织架构、运营；审计沿用 `audit:read`。“模型”与“数据防护”、“工具与连接”与 Skill 均不合并，组合需求用预置角色满足 |
| AP3 | 跨模块引用：持有某模块写权限时，可读取该模块表单需要的其他模块**选择器精简列表**（ID、名称、状态、版本、所需角色），不需另授对方模块的查看权限 |
| AP4 | **已被 AP11 取代（2026-11-14）。** 原决定：员工、角色与角色权限、用户数据范围、目录同步、独立账号管理仍只限平台管理员，不拆“员工管理员” |
| AP5 | **授出不超过自身**：非平台管理员的任何授权动作（部门角色授权、部门成员变更、Agent 岗位角色与数据范围、Agent 可见角色、主动任务接收人），授出的权限码与数据范围必须是操作人自身有效权限的子集；不能作用于自己的部门归属。具体规则见 5.3 |
| AP6 | **已被 AP12 取代（2026-11-14）。** 原决定：钉钉集成保持只限平台管理员（与现状一致：服务层只认 `admin:*`，钉钉设置含应用密钥），不设 `admin:dingtalk` 模块；路由层同步收紧，不再让 `admin:read` 进入后被服务层拒绝 |
| AP7 | 运营查看 `admin:ops:read` 覆盖运营概览、Session 摘要、工作空间、Task 汇总、用量与健康状态。Session 摘要含对话标题（员工首条输入的前 40 字），仍归运营查看：只有摘要、没有消息浏览，与现状 `admin:read` 可见一致 |
| AP8 | 持久化审批（`/approvals`）先归 Agent 模块；接入更多需审批工具后再评估按工具所属模块授权 |
| AP9 | 管理助手：读取工具只返回操作人有查看权限的模块；专用 Run 的执行前校验与确认入口使用同一模块判定；取消自己的任务提案与操作计划只需能使用管理助手（现状需要 `admin:write`，属放宽，理由是取消只会减少操作）。规则见 5.5 |
| AP10 | 分两期：AMP-S1 服务端（判定函数与模块清单、路由对照表、会话层、服务层调用盘点与收敛、AP5 授权上限、管理助手、测试）；AMP-S2 管理端前端（菜单与按钮控制、预置角色、E2E）。AMP-S2 开发前先给可点击原型 |

### 4.1 AMP-S2 新增决策（2026-11-14，原型确认后）

| 编号 | 决定 |
| --- | --- |
| AP11 | **员工与权限成为模块**（`admin:identity:read` / `write`），取代 AP4。查看员工与角色需要“查看员工与权限”，不再对任一管理员开放；修改员工、角色、数据范围、独立账号与目录同步需要“修改员工与权限”，并受 AP13 约束 |
| AP12 | **钉钉集成成为模块**（`admin:dingtalk:read` / `write`），取代 AP6。概览、未绑定名单、员工的钉钉绑定查看为查看级；连接检查、提醒、离职检查确认、代绑 / 解绑 / 解锁为修改级。**钉钉应用配置（CorpId、AppKey、AppSecret）的保存与清除仍只限平台管理员**：换成他人控制的钉钉应用可以冒充已绑定员工登录。拥有管理类权限的账号仍只能本人在钉钉内绑定 |
| AP13 | 员工与权限、钉钉的防提权规则（非平台管理员）：① 给员工分配角色、新建或修改角色的权限、设置员工数据范围，授出的权限与数据范围不超过本人；`admin:*` 只有平台管理员能授出；② 含操作人没有的权限的角色对其只读，“平台管理员”角色只有平台管理员能改；③ 不能操作自己的账号（角色、数据范围、停用、重置密码、撤销会话、钉钉绑定）；④ 不能操作权限比自己高的账号，包括平台管理员 |
| AP14 | **角色编码由系统生成**（`role_` + 8 位随机字符），创建后不变；新建角色只填名称、说明、状态、功能权限与数据范围 |
| AP15 | **菜单与落地页**：没有查看权限的菜单直接不显示，整组无权时分组标题也隐藏；管理助手、接入规范、接口文档对所有管理员显示。不新增首页：有运营查看时落地到运营概览，否则落地到第一个能看的模块页面；打开无权页面的链接显示“无权访问”。只读模块的修改操作不可用，页面顶部说明原因 |
| AP16 | 角色数据范围保持现状（自由填写多选），本期不改 |
| AP17 | 已有 `admin:read` / `admin:write` 的角色**自动覆盖**员工与权限、钉钉集成两个新模块（这两个权限码的含义就是“全部模块”），受 AP13 约束（2026-11-14 确认） |
| AP18 | **减权视同操作持有人**（补充 AP13 ④，2026-11-15 按 #127 评审确认）：非平台管理员减少角色的权限或数据范围、停用角色时，角色的持有人中不能有本人、平台管理员或权限比本人高的员工；增加权限、改名称与说明不受此限（仍受 AP13 ①）。不采用“这类角色整体只读”，以免模块管理员无法扩充“普通员工”等公共角色 |
| AP19 | **钉钉绑定在钉钉集成页内处理**（2026-11-15 按 #127 评审确认）：钉钉集成页增加“已绑定”名单，未绑定与已绑定名单都在页内抽屉中代绑、解绑、解锁，只有钉钉集成权限的管理员不需要员工与权限的查看权限。代绑保持 AP12 的修改级授权，**已知风险接受**：有钉钉修改权限的人可以把自己控制的钉钉账号代绑到权限不高于自己的员工并以其身份在钉钉内登录；缓解为代绑通知员工本人与审计记录操作人 |

**AMP-S2 范围：** AP11～AP15 的服务端改动与集成测试；管理端：会话返回模块权限摘要、侧栏与路由按模块控制、首页数据按权限加载、落地页与无权访问页、只读提示、各页面写操作改为按模块判定、角色弹窗“功能权限”按模块分区、角色列表按模块显示功能权限、角色编码系统生成；P0 冒烟增加模块管理员测试身份；E2E 分册 `e2e/catalog/admin-permissions.md`。不含：Agent 岗位权限的前端预先标注、管理助手前端提示（服务端已限制）。

## 5. 设计

### 5.1 模块与权限码

模块依据管理端 OpenAPI 的路径前缀与管理端菜单划分；OpenAPI 现有 32 个一级前缀全部归属下表。

| 模块 | 权限码 | 路径前缀（`/api/admin/v1/`） | 管理端页面 |
| --- | --- | --- | --- |
| Agent | `admin:agent:read` / `write` | `agents`（含 access、routines、validations、versions、runs、workspaces）、`agent-versions`、`experience-iterations`、`approvals` | Agent 管理、Agent 详情与草稿、经验、审批 |
| Skill | `admin:skill:read` / `write` | `skills`、`skill-versions`、`skill-release-records`、`skill-submissions`、`skill-installations` | Skill 管理、待审核、新增 Skill |
| 工具与连接 | `admin:connector:read` / `write` | `connectors`（含 MCP 凭据、能力审批、调用对账）、`runtimes`、`grant-sources`、`task-executions` | MCP 连接器、调用对账、Runtimes |
| 模型 | `admin:model:read` / `write` | `model-providers`、`provider-models`、`model-routes`、`model-usage` | 模型治理、模型用量 |
| 数据防护 | `admin:dlp:read` / `write` | `data-protection` 中除词表、白名单外的接口（概览、命中记录、检测试用） | 数据防护 |
| 企业知识库 | `admin:knowledge:read` / `write` | `knowledge` | 企业知识库 |
| 组织架构 | `admin:org:read` / `write` | `organization` | 组织架构 |
| 运营 | `admin:ops:read` | `sessions`、`workspaces`、`tasks`、`usage`、`health`、`platform-status` | 运营概览、Session 列表、工作空间、健康 |
| 审计（不变） | `audit:read` | `audit-events`、`operations` | 审计、运行治理 |
| 员工与权限（AP11） | `admin:identity:read` / `write`；写操作执行 AP13 | `identity`（钉钉绑定除外） | 员工与权限 |
| 钉钉集成（AP12） | `admin:dingtalk:read` / `write`；`PUT` / `DELETE dingtalk/settings` 只限平台管理员；操作员工绑定时执行 AP13 | `dingtalk`、`identity/users/:id/dingtalk-binding` | 钉钉集成 |
| 保密词表（不变） | `admin:dlp:read`（或全模块查看）**且** `data-protection:terms`；写同理需 `admin:dlp:write` 且 `data-protection:terms` | `data-protection/terms`、`data-protection/allowlist` | 数据防护中的词表、白名单 |
| 管理助手 | 见 5.5 | `assistant` | 管理助手 |
| 当前会话 | 已登录管理端即可 | `session` | — |

`task-executions` 的人工处置（`/task-executions/:taskId/operations/:operationId/resolve`）是外部写操作的对账，与 MCP 调用对账同属“工具与连接”。员工端 `task-execution-routes.ts` 中同一处置的平台管理员校验一并改为 `admin:connector:write`。

**判定规则：** 请求 `admin:<m>:read` 时，持有 `admin:*`、`admin:read`、`admin:write`、`admin:<m>:read`、`admin:<m>:write` 任一即通过；请求 `admin:<m>:write` 时，持有 `admin:*`、`admin:write`、`admin:<m>:write` 任一即通过。“平台管理员专属”的范围只认 `admin:*`。

判定集中在两个文件：纯函数与路由对照表在 `server/src/domain/admin-permissions.ts`，服务层数据库复核在 `server/src/modules/authorization/admin-actor.ts`：

- `hasAdminModuleAccess(permissions, module, level)`：基于请求身份的纯函数，供路由与前端摘要使用；
- `requireAdminModuleActor(sql, userId, module, level)`：服务层在事务内复核，只认本地授予、有效期内的启用角色，替代现有 `requirePlatformAdminActor`、`requirePlatformAdmin`、`requireAdminReader` 的模块类用途；
- `requirePlatformAdminOnly(sql, userId)`：平台管理员专属范围（员工与权限、独立账号、钉钉），收敛现有两份 `assertPlatformAdmin`。

路由、会话层、服务层与前端共用同一份模块清单。

**兼容：** 现有角色不迁移。`role-platform-admin`、带 `admin:read` 的审计员角色等含义不变；新增权限码只用于新建或调整的细分角色。

**预置角色（AMP-S2）：** Agent 管理员（agent + skill 写，connector 读）、知识库管理员（knowledge 写）、模型与数据防护管理员（model + dlp 写）。仅为方便选用，平台管理员可在“员工与权限”中自行组合。

### 5.2 跨模块引用（AP3）

管理页面存在跨模块的选择器：Agent 草稿的能力步骤列出 Skill、内置工具、MCP 连接器与工具，角色与权限步骤列出角色和数据范围，模型路由选择列出路由。

- 持有 `admin:agent:write` 时，可读取上述候选列表的精简字段，不返回凭据、配置正文、调用记录；
- 精简列表复用现有列表接口，通过查询参数（如 `view=selector`）或独立接口返回，服务端按调用者权限决定返回完整还是精简字段；
- 其他模块之间存在同类引用时，按同一规则在实施时逐个登记。

### 5.3 防提权：授出不超过自身（AP5）

核心原则：**非平台管理员不能授出自己没有的权限，也不能通过改变自己的归属获得权限。** “自身有效权限”指操作人当前全部有效角色（含部门授予）的权限码并集与数据范围；子集判定在服务层事务内计算。

| 授权路径 | 风险 | 规则 |
| --- | --- | --- |
| 员工、角色、角色权限、用户数据范围 | 直接给自己加权限 | 只限平台管理员（AP4，与现状一致） |
| 部门角色授权（`grantRole`、撤销） | 给自己所在部门授任意非管理角色，间接给自己加权限 | 授权时即判定：授予的角色的全部权限码与该角色附带的数据范围须是操作人自身的子集（部门当前为空也一样，否则之后加入的成员会拿到超出授予人的角色）；管理类前缀（`admin:`、`audit:`、`data-protection:`）一律不可经部门授予（现有 `DEPARTMENT_FORBIDDEN_PERMISSIONS` 改为前缀规则） |
| 部门成员变更（`addMembers`、移除、设主部门） | 把自己加入已有高权限授权的部门 | 不能变更自己的部门归属；把他人加入部门时，该部门（含 `includeDescendants` 继承）当前有效授权展开后的权限须是操作人自身的子集 |
| 部门移动 | 把部门挪到带继承授权的上级之下，成员获得新权限 | 移动后成员新增的继承授权同样须是操作人自身的子集 |
| Agent 岗位角色与数据范围 | 给 Agent 绑定自己没有的角色或范围，再经 Agent 间接访问 | 岗位角色的全部权限码与数据范围须是操作人自身的子集；管理类前缀角色只有平台管理员可授（`agent-access-service.ts` 现已按 `admin:%`、`audit:%` 识别，补 `data-protection:%`） |
| Agent 可见角色、主动任务接收人 | 把能力超出自己的 Agent 开放给自己 | 由于岗位权限已受子集约束，Agent 能力不超过授权它的人；此外，非平台管理员不能把可见角色设为、或把接收人设为能力超出自身的 Agent 的使用范围——即新增可见角色、修改接收人或主动任务的工作空间、启用 / 立即执行 / 事件触发主动任务，以及发布或重新启用 Agent 时，Agent 当前岗位权限与数据范围须是操作人自身的子集；只移除可见角色不受限制 |

平台管理员不受子集约束，保持现有风险提示。子集校验失败时拒绝并说明缺少的权限码，不做部分保存。

**存量：** 本规则只约束新的授权动作，不回收已有授权；上线时输出一次“由非平台管理员授出且超出其自身权限”的存量清单供平台管理员复核（来源取审计事件）。

**默认拒绝：** 管理端路径未在模块对照表登记时一律拒绝，防止新增接口落入无权限检查的状态。

### 5.4 Agent 岗位权限与 Agent 管理员

功能规则第 8 节的岗位权限页面不变，增加：

- 非平台管理员看到的可选角色只列出满足子集规则的角色；“补齐所需授权”只补满足子集规则的部分，补不齐时提示需要平台管理员处理；
- 发布复核沿用现有逻辑；子集约束只作用于修改动作，不作废已有验证证据。

### 5.5 管理助手（AP9）

管理助手经 DSH `admin-assistant` Run 处理问答和意图提案，确认后调度专用 Run（`admin-skill-install`、`admin-agent-manage`、`admin-platform-operations`），专用 Run 生成精确操作计划，二次确认后复用领域服务写入。

现状：`admin-assistant-service.ts` 中，`admin-assistant` 相关入口要求 `requireAdminReader`，专用 Run 的创建、Manifest 授权复核（`requireManifestAuthorization`）、`prepare_admin_action` 与执行入口要求 `requirePlatformAdmin`（本地 `admin:*` 或 `admin:write`）；读取工具 `inspect_admin_state` 只要求 `requireAdminReader`，返回 Agent、Runtime、Task 等跨模块状态。

调整：

- **使用助手：** 持有任一管理权限即可进入、发消息、取消与重试自己的 `admin-assistant` Run（与现状一致）；
- **读取范围：** `inspect_admin_state` 等读取工具按操作人可查看的模块过滤返回内容，无权模块的分区不返回，并在结果中注明“无权查看”，避免模型据此误判状态；
- **确认任务提案：** 按提案类型检查目标模块写权限，`admin-skill-install` 需 `admin:skill:write`，`admin-agent-manage` 需 `admin:agent:write`，`admin-platform-operations` 按提案涉及的操作所属模块检查；
- **专用 Run 内复核：** 专用 Run 的创建、`requireManifestAuthorization`、`prepare_admin_action` 与执行入口改为同一模块判定（按 Run 的 purpose 与计划中的操作），不再要求全模块写权限；否则模块管理员确认后会在 Run 内被拒；
- **确认操作计划：** 写入前按计划中每个操作的目标模块再次检查，任一不满足则整份计划拒绝；涉及授权的操作同样执行 5.3 子集规则；
- **取消提案与计划：** 发起人本人持有任一管理权限即可取消自己的任务提案与操作计划；
- 权限检查只在平台侧执行，不依赖 DSH 只提出有权限的操作；向助手提供的上下文可以说明当前管理员的模块范围，以减少无效提案，但不作为授权依据。

### 5.6 前端（AMP-S2）

- 路由 `meta.requiredPermission` 由统一的 `adminRead` 改为模块声明（如 `{ module: 'agent', level: 'read' }`），无权限时进入“无权访问”页；
- 侧栏只显示有查看权限的模块；没有写权限时隐藏或禁用写按钮，并以文字说明原因；
- 当前会话接口返回调用者的模块权限摘要，前端只用于展示，服务端仍逐请求校验；
- “员工与权限”中的权限选择按模块分组展示新增权限码。

## 6. 需要修改的检查点

单改路由入口不能收窄权限。AMP-S1 先以 `grep` 盘点全部管理判定调用（当前 `requirePlatformAdmin`、`requireAdminReader`、`requirePlatformAdminActor`、`assertPlatformAdmin` 合计约 120 处，另有内联 SQL），逐处登记到“调用点 → 模块 + 级别 / 平台管理员专属”清单并随 PR 评审；收敛完成后由 `check:architecture` 禁止在判定模块之外直接写 `r.permissions ? 'admin:` 或调用旧函数。

| 位置 | 现状 | 调整 |
| --- | --- | --- |
| [router.ts](../../server/src/http/router.ts) `assertApiRouteAccess` | 按 GET/非 GET 区分 `admin:read` / `admin:write`；`/identity/` 写操作限 `admin:*`；审计路径限 `audit:read`；助手发消息与 Run 取消、重试对 `admin:read` 放行 | 改为“路径前缀 → 模块 + 读写级别”对照表，未登记路径拒绝；保留 identity、审计特例；钉钉改为平台管理员专属；助手按 5.5 |
| [request-security.ts](../../server/src/modules/identity/request-security.ts)（原 `auth-service.ts`） `hasAdminAccess`、`assertAudienceAccess` | 准入接受 `admin:*`、`admin:read`、`admin:write`、`audit:read`（不含 `data-protection:terms`）；写请求要求 `admin:*` 或 `admin:write` | 准入改为持有任一管理权限码（含模块码）；写请求的模块级判定交给路由对照表，会话层不再按全局写权限拒绝；只持 `data-protection:terms` 不构成准入 |
| [admin-actor.ts](../../server/src/modules/authorization/admin-actor.ts)（原 `platform-admin-actor.ts`）`requirePlatformAdminActor`、`findPlatformAdminActor` | 本地授予的 `admin:*` 或 `admin:write`；Agent、组织、知识库、MCP、授权等服务复用 | 请求类用途改为 `requireAdminModuleActor`；后台以管理员身份执行的场景（如预置 Skill 创建专家的 `findPlatformAdminActor`）不属于请求授权，保留全模块写口径 |
| `postgres-authorization-service.ts` `requirePlatformAdmin`、`requireAdminReader`（约 812 行） | 前者本地 `admin:*` 或 `admin:write`；后者本地 `admin:*`、`admin:write` 或 `admin:read` | 两者被经验、审批、Skill 安装、管理助手、员工端 task-execution 等路由与服务调用，逐处改为模块判定 |
| `postgres-skill-service.ts`、`admin-skill-installation-service.ts`、`postgres-operations-service.ts`、`postgres-grant-reconciliation-service.ts` 中的 SQL | 各自写了 `r.permissions ? 'admin:*' or ... 'admin:write'` | 改为调用共用判定：Skill 两处归 Skill 模块，运行治理归审计或对应模块，授权对账归工具与连接 |
| `skill-submission-review-service.ts` | `requirePlatformAdmin` | `admin:skill:write` |
| `admin-assistant-service.ts` | 见 5.5 | 见 5.5 |
| `dingtalk-admin-service.ts`、`local-auth-service.ts` 的 `assertPlatformAdmin` | 两份相同的本地 `admin:*` 查询；钉钉的 `administrativePermissions` 是固定清单 | 收敛为 `requirePlatformAdminOnly`；`administrativePermissions` 改用共用前缀判定 |
| `postgres-organization-service.ts` | `DEPARTMENT_FORBIDDEN_PERMISSIONS` 固定清单；`grantRole`、`addMembers` 不限角色与操作人 | 前缀规则；按 5.3 增加子集校验与“不能变更自己的部门归属” |
| `agent-access-service.ts` | 管理类角色已按 `admin:%`、`audit:%` 前缀识别 | 补 `data-protection:%`；非平台管理员执行 5.3 子集规则（岗位角色、数据范围、可见角色、接收人） |
| `session-repository.ts` `primaryRole`、`administration-service.ts` `permissionCatalog` | 主角色显示与权限目录 | 增加“模块管理员”显示与新增权限码 |
| `server/src/testing/test-identity.ts`、P0 冒烟数据 | 只有全权管理员身份 | 增加模块管理员测试身份 |
| `openapi-coverage.test.ts` | 校验 OpenAPI 覆盖 | 增加断言：`openapi-admin.json` 每条路径都在模块对照表中 |
| admin-web 路由与布局 | 全部 `requiredPermission: 'adminRead'` | 5.6 |

## 7. 文档同步

- [功能规则](../development/feature-rules.md)：新增“管理端模块权限”一节，写入权限矩阵、三类管理员定义、授出不超过自身规则与管理助手口径；第 8 节 Agent 岗位权限与第 10 节组织架构补子集约束；
- [架构总览第 9 节](../development/overview.md#9-身份安全与数据边界)：补充管理端按模块校验；
- [数据模型第 1 节](data-model.md#1-租户身份与授权)：`roles.permissions` 可含模块权限码、部门授权按前缀禁止管理权限；
- [文档索引](../index/README.md)：登记本方案状态；
- E2E：新建 `e2e/catalog/admin-permissions.md` 分册并登记到 `e2e/TEST-CATALOG.md`。

## 8. 实施切片

| 切片 | 内容 | 完成标准 |
| --- | --- | --- |
| AMP-S1 | 判定模块与模块清单；调用点盘点清单与收敛；路由对照表与默认拒绝；会话层准入；5.3 子集规则（组织架构、Agent 创建 / 岗位权限 / 发布 / 启用、主动任务接收人与工作空间）；管理助手读取过滤、确认与 Run 内复核；选择器精简读取；存量清单；架构检查；集成测试 | 模块管理员越权读写返回 403；子集规则覆盖 5.3 全部路径；平台管理员与审计员的读取行为不变；**有意的行为变化**：全模块管理员（`admin:write`）同样受“授出不超过自身”与“不能变更自己的部门归属”约束；持有 `admin:read` 的管理员（含安全审计员）可以使用管理助手（此前会话层拦截所有无 `admin:write` 的写请求；2026-11-13 确认保留）；取消自己的提案与计划放宽为任一管理权限；钉钉只读接口在路由层即拒绝非平台管理员；OpenAPI 覆盖测试与架构检查通过 |
| AMP-S2 | 原型确认（AP11～AP16）→ 员工与权限、钉钉集成成为模块并执行 AP13；角色编码系统生成；会话返回模块级别；侧栏与路由按模块控制、首页按权限加载、落地页与无权访问页、只读提示、各页面写操作按模块判定、角色弹窗按模块分区；P0 冒烟模块管理员测试身份；E2E 分册与 spec | 模块管理员只看到自己的模块、首屏无 403；AMP-01 的 P1 用例通过；AMP-P0-01～03、AMP-P1-02 与 AMP-P1-03 浏览器用例通过 |

## 9. 验收

- **P0：** 冒烟服务提供“知识库管理员”测试身份，登录管理端只看到企业知识库与可读页面，写其他模块被拒；
- **P1：** 一次性 PostgreSQL 上覆盖：模块读写 403/200 矩阵；钉钉与独立账号对全模块管理员仍被拒；组织架构管理员给自己所在部门授角色、把自己加入部门、给他人授超出自身的角色均被拒；Agent 管理员授予超出自身的岗位角色或数据范围、对超出自身的 Agent 修改可见角色或接收人被拒；管理助手读取结果按模块过滤、确认跨模块计划被拒、模块管理员确认本模块计划后专用 Run 正常执行；授权变更后下一次请求立即生效；
- **P2：** 本机真实 DSH 走查“Agent 管理员新建 Agent → 选择 Skill 与工具 → 验证 → 发布”与“管理助手安装 Skill（无 Skill 写权限时确认被拒，有权限时安装成功）”。

## 10. 风险与未决

- **Session 摘要中的对话标题**属于员工输入片段，AP7 确认仍归运营查看；若后续摘要扩展到消息正文，须改归 `audit:read` 并重新评审；
- **子集判定的粒度：** 以权限码与数据范围值逐项比较；`admin:write` 覆盖全部模块码、`knowledge:bases` 覆盖 `knowledge:docs` 等包含关系需在判定函数中统一展开，否则会误拒；
- **Agent 间接访问的实际范围：** Agent 岗位角色在员工对话中的作用已按功能规则第 8 节与员工数据范围求交，子集规则是额外的保守约束；评审中提出的“借 Agent 越权”的实际影响尚未逐条验证，实施 AMP-S1 时在集成测试中确认；
- **选择器精简列表**需要逐个梳理跨模块引用，遗漏会导致页面空白而非越权，实施时以页面走查兜底；
- **对象级授权**（只管部分 Agent / 知识库）不在本期，若后续需要，可在模块权限之上叠加对象授权，不推翻本方案。
