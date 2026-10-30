# 管理端与平台

冒烟环境、登录与身份、管理端、内置工具与操作计划、开发接入文档、MCP、持久化等待与审批、平台内置 Skill。证据层级与写法见[验收目录索引](../TEST-CATALOG.md)。

### E2E-ENV-01 默认冒烟环境隔离

**优先级：** P0 · **角色：** 本地开发者 / CI · **运行层级：** P0 冒烟服务、内存数据
**前置数据：** 仓库可以保留配置开发数据库和正式登录的 `.env`；无需启动 PostgreSQL、AI Hub 或 DSH。
**验证：** `scripts/testing/playwright-p0-config.test.mjs` 与默认 `pnpm test:e2e` 全套冒烟。

1. 直接执行 `pnpm test:e2e`，自动在独立端口启动员工端、管理端和测试专用冒烟服务（`scripts/testing/p0-smoke-server.ts`），不启动应用服务端。
2. 冒烟服务不读取数据库与身份配置，测试子进程覆盖前端 API 地址，不继承开发环境的数据源；浏览器地址与服务端口一致。
3. 如果测试端口已被占用，明确报错，不复用已有服务；可显式指定另一组端口重跑。

**验收：** 默认命令不连接或迁移开发数据库，不启动真实身份/模型链路；P1 专用配置保持独立。

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

## 管理端受控工具与操作计划旅程

### ADMIN-E2E-01 内置工具随代码发布，按 Agent 开关装配并可紧急停用

**优先级：** P1
**角色：** 平台管理员
**运行层级：** 专用可丢弃 PostgreSQL、受控 Runtime（验证运行使用测试替身）
**前置数据：** 已发布 Skill `skill-document`（依赖 `read`）；一个声明 `web_search` 的已发布 Skill；默认 Runtime `runtime-local-01`
**spec：** `server/src/infrastructure/postgres/builtin-tools.integration.test.ts`、`server/src/infrastructure/postgres/agent-release-governance.integration.test.ts`、`server/src/modules/run/current-execution-authorization.test.ts`、`server/src/modules/skill/skill-package.test.ts`

1. 新建 Agent，不开启联网搜索：运行快照装配 `read`、`glob`、`grep`、`read_image`、`write`、`edit`、`str_replace_editor`、`todo_write`，不含 `web_search` 与 `bash`；运行审批模式为无需审批。
   - 员工对话的 Manifest 另含 `bash`（执行隔离 2a；执行容器为必需，4.9），只有 Runtime 紧急停用能去掉；执行容器不可用时运行在创建前被拒绝。
2. 在 Agent 能力中开启“允许联网搜索”，验证运行的 Manifest 含 `web_search`；编辑时不改开关则保留原设置。
3. 选择声明 `web_search` 的 Skill 而 Agent 未开启联网搜索，保存与验证被拒绝并提示“未开启联网搜索”；Skill 依赖平台不提供或不能由 Skill 声明的工具（如 `bash`）时说明“平台不提供该工具”。
4. SKILL.md 的 `allowed-tools` 按名称匹配内置工具（`Read`、`WebSearch`、`str_replace_editor`），未知工具标为不支持。
5. 在 Runtime 配置中紧急停用 `web_search`（`bash` 同样可停用）：只接受 DSH 内置工具，平台工具（如 `python_execute`、`activate_skill`）与注册表以外的工具（如 `web_fetch`）被拒绝；新 Attempt 不再装配被停用工具，模型看不到它；执行中的 Attempt 再调用该工具时只拒绝这一次调用并告知模型“已被管理员临时停用”，运行继续并给出基于已有结果的回答；清空停用清单后恢复。

**验收：** 管理员不能新增、同步或逐个授权内置工具；工具集由平台代码决定，Agent 只决定是否允许联网搜索；工作空间授权只包含 Agent 与 Skill；停用清单是运维止损开关，不是授权：派发时不装配，执行中只拒绝被停用工具的调用，不让运行整体失败。

### ADMIN-E2E-05 Runtime 详情只读展示内置工具，MCP 管理入口独立

**优先级：** P0
**角色：** 平台管理员
**运行层级：** Prototype 浏览器与管理端组件测试；接口契约测试补充边界
**前置数据：** 一个 DSH Runtime、至少一个 MCP Connector
**spec：** `e2e/mvp-smoke.spec.ts`、`apps/admin-web/src/views/RuntimeManagementView.test.ts`、`apps/admin-web/src/views/CapabilityManagementView.test.ts`、`server/src/http/api-contract.test.ts`

1. 管理端导航中不再出现“DSH 工具管理”与“工具权限”；旧地址 `/tools`、`/permissions` 跳转到 Runtimes。
2. 进入“Agent 治理 → MCP 连接器”，列表只包含外部 MCP Connector。
3. 进入“安全与运维 → Runtimes”，打开当前 Runtime 详情，“内置工具”区域列出全部内置工具的名称、来源（DSH/平台）、装配方式与停用状态，并显示服务启动时与 DSH 工具目录的核对结果，以及执行容器状态：已启用时说明装配 `bash`，未开启或启动检查未通过时说明不装配 `bash`（不可用的原因只在服务日志）。
4. 在“配置 Runtime”中选择要紧急停用的 DSH 工具，保存前确认影响；平台工具不出现在可选项中。

**验收：** 内置工具只读展示，唯一可操作的是 Runtime 级紧急停用；`/api/admin/v1/tools` 等工具治理接口不存在；MCP 页面与接口只返回外部 MCP Connector。

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

## 批次 4 管理操作（C6/C7）

- C6 / P1 / 有写权限管理员：隔离 PostgreSQL、合成 DSH 工具结果中有一个现存草稿；在管理助手描述改标题，看到精确差异与“一次确认”标识，确认前草稿不变，确认一次后只改草稿文案；已有 AGENTS 工作规程与 `none`/`selected` MCP 范围不因文案更新变成默认 `all`，试图在一次确认请求中更改这些字段须拒绝；权限/发布/Runtime 任务仍显示委派确认和最终计划确认。只读管理员不出现确认按钮。对应 `e2e/admin-review.spec.ts`（浏览器可运行环境预演后固化；真实 DSH 属 P2）。

### C7 链接导入待浏览器预演

- C7 / P1 / 有写权限管理员：进入新增 Skill 的链接入口，提供受支持 HTTPS 地址，解析后查看来源/摘要/依赖/阻断原因，确认保存草稿。DSH 不可用时仍能存可解析草稿，界面显示不可发布而不声称测试通过。对应 `e2e/admin-review.spec.ts`（受控下载、不访问真实企业资源；真实外网与 DSH 验收另行记录）。

前置数据：隔离一次性 PostgreSQL、合成管理员及受控公共下载制品；按“来源 → 固定摘要 → 显式保存草稿 → 试运行未通过或 DSH 不可用时发布拒绝”验收。禁止连接真实企业库。当前 Chromium 首次导航被 ERR_BLOCKED_BY_ADMINISTRATOR 拒绝，未通过浏览器 Verify，不创建伪通过 spec；上述文件名为待实现旅程目标。现阶段 HTTP/组件测试已进入 CI，不能代替该旅程。

## PF-03 MCP Connector 治理

### PF-MCP-01 Connector 登记生效、能力变更确认与按 Agent 选择

**优先级：** P0（治理边界）

**角色：** 平台管理员

**运行层级：** P1 集成用户旅程

**前置数据：** 隔离一次性 PostgreSQL、受控管理员、可改变 Tool 清单的合成 MCP 发现 Runtime、一个已发布 Agent；不得连接开发业务库或生产服务

**spec：** `e2e/admin-mcp-connector.integration.spec.ts`、`e2e/agent-capabilities.integration.spec.ts`、`server/src/infrastructure/postgres/mcp-connector-governance.integration.test.ts`、`server/src/infrastructure/postgres/mcp-auto-activation-upgrade.integration.test.ts`

1. 在“MCP 连接器”页面填写名称与 Streamable HTTP 地址，登记“上游权限说明”（说明凭据和上游服务的访问边界，不执行数据过滤）；受保护端点选择“无认证”时，“测试连接”显示该服务要求 Bearer Token，不将上游 401/403 折叠为通用 `Internal error`。填写 Bearer Token 后，“添加 MCP”保持禁用，直到执行不落库的“测试连接”并成功发现 Tool；修改名称、地址、认证方式或 Token 会使测试结果失效。添加接口再次通过 DSH 复核，复核失败不写入 Connector 或凭据；成功后平台生成 Connector 标识与 MCP 命名空间，Token 加密入库且不回显，登记时发现的 Tool 清单立即生效。
2. 列表保持与 Skill 管理一致的工具栏、表格和分页结构，不增加统计卡片；列按“名称、Endpoint、认证方式、工具数量、状态、更新时间、添加时间、添加人员、操作”排列。“工具数量”显示生效 Tool 数，有待确认项时附“N 待确认”标记，并可打开 Tool 名称、描述和输入 Schema 清单；操作列直接提供查看、检查，其余凭据轮换、停用或启用、删除收进“更多”；页面不出现 Agent 权限入口。
3. 登记成功后连接器不会自动进入任何 Agent；只有在 Agent 能力配置中选定该连接器的版本，其新 Attempt 才解析到它。确认数据库没有 Agent→Connector Grant 表，也没有在平台 Tool 列表生成 MCP Tool。详情显示“适用 Agent：在 Agent 能力配置中选择”。
4. 合成发现 Runtime 新增一个 Tool 后重新检查；提示“N 个 Tool 生效，M 个新增或变更的 Tool 待确认”，新 Tool 不生效，已固定的 Attempt 不受影响。在工具清单中“确认生效”并二次确认后，新 Tool 进入生效清单，已固定原清单的 Attempt 停止，新 Attempt 使用新清单。远端删除的 Tool 在检查后立即下线；只改描述自动生效；输入 Schema 变化的 Tool 在确认前暂停。确认时清单已再次变化则返回冲突并要求刷新。
5. 从列表轮换 Bearer Token，确认旧值不回显；新 Token 检查成功后自动恢复生效，检查失败时保持异常且不进入任何 Agent 的新 Attempt。人工停用状态不会被检查自动解除。
6. 人工停用 Connector 后再次执行检查，状态保持“已停用”；清单可以同步，但选定该连接器的 Agent 的新运行和在途调用均被拒绝。只有显式启用操作才能恢复。
7. 从列表删除 Connector 并二次确认；列表立即移除该项，选定该连接器的 Agent 后续运行被拒绝，独占 Bearer 凭据销毁；Connector 行、能力快照、健康检查和调用审计继续保留用于追溯。
8. 从旧版“等待审核/需要重新审核”状态升级时，分别构造“当前 Bearer 凭据晚于最近检查”和“当前凭据已有后续检查”两种记录；前者保持 `degraded`，后者才允许恢复。对已经被旧迁移错误恢复的记录，纠正迁移应重新要求检查且不得伪造健康检查证据。
9. 将租户健康 MCP Connector 填充至 19 个后并发登记两个连接器；仅一个成功。达到 20 个后，新增、重新启用和离线连接器检查恢复均返回容量冲突，原状态不变；单个 Agent Version 同样不能选择超过 20 个连接器。

**验收：** MCP 复用现有 Connector 管理。管理员无需填写内部标识、命名空间或所属系统；Bearer Token 只在新增或轮换时输入，查询与详情不回显。连通测试不持久化 Connector 或 Token，测试成功后才能添加，添加时仍由服务端重新测试，不能只依赖页面状态。登记时的清单即生效；之后新增或输入 Schema 变化的 Tool 须管理员确认，远端删除的 Tool 立即下线；运行时策略逐 Tool 核对生效清单与当前加载的输入 Schema。Agent Version 按整个 Connector 选择，不提供逐 Tool 权限管理。健康检查和凭据轮换不能覆盖人工停用；只有被选定、健康且生效清单非空的 Connector 才会进入 Agent Attempt。停用和删除会移除运行可用性，删除同时销毁独占密钥但保留治理证据。P1 浏览器证明真实 PostgreSQL 管理状态和页面边界；加密密文、运行时解密、DSH 调用与逐调用审计由 Runtime/服务集成测试覆盖，真实外部服务证据留 PF-MCP-P2。

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

## 平台内置 Skill

设计见[平台内置 Skill 方案](../../docs/design/builtin-skills-plan.md)，规则见[功能规则 5.5](../../docs/development/feature-rules.md#55-平台内置-skill)。

### BSK-01 管理端查看内置 Skill、设置覆盖场景与紧急停用

**优先级：** P0
**角色：** 平台管理员
**运行层级：** P0 冒烟服务与管理端组件测试；接口契约测试补充边界
**前置数据：** 代码中的三个内置 Skill；一个已发布的已安装 Skill；默认 Runtime
**spec：** `e2e/mvp-smoke.spec.ts`、`apps/admin-web/src/views/CapabilityManagementView.test.ts`、`apps/admin-web/src/views/RuntimeManagementView.test.ts`、`server/src/http/api-contract.test.ts`

1. 进入“Skill 管理”，看到“平台内置”区域列出文件分析、HTML 页面、Office 文档三个内置 Skill，各自显示版本与场景；打开详情只能查看说明与正文，没有编辑、发布、回滚、停用或删除入口。
2. 打开一个已安装 Skill 的详情，在“覆盖内置场景”中勾选“HTML 页面”并保存；再次打开时准确回显，审计日志出现对应记录。
3. 进入“安全与运维 → Runtimes”，Runtime 详情列出内置 Skill 及版本；在“配置 Runtime”中选择紧急停用“HTML 页面”内置 Skill，保存后详情显示已停用；清空后恢复。

**验收：** 内置 Skill 只读展示；唯一可改的是已安装 Skill 的覆盖场景与 Runtime 级紧急停用；覆盖场景只接受三个固定场景，内置 Skill 不能设置覆盖。

### BSK-02 员工侧运行装配内置 Skill，按覆盖与停用让位

**优先级：** P1
**角色：** 员工、平台管理员
**运行层级：** 专用可丢弃 PostgreSQL、受控测试身份与 Mock ACP Worker
**前置数据：** 未固定任何 Skill 的已发布 Agent；一个已发布并标记覆盖 `html-page` 的 Skill；一个团队空间（只授权该 Agent，不授权额外 Skill）
**spec：** `server/src/infrastructure/postgres/builtin-skills.integration.test.ts`、`server/src/modules/skill/builtin-skills.test.ts`、`server/src/modules/run/current-execution-authorization.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`

1. 员工在个人空间与该 Agent 对话：Manifest 含三个内置 Skill（内联正文、`id@version`），装配 `activate_skill`；目录中内置 Skill 排在最后。
2. 在团队空间与该 Agent 对话并让运行排队后再执行：派发授权与执行前复核都不因内置 Skill 报“工作空间未授权 Skill”。
3. 为 Agent 固定标记覆盖 `html-page` 的 Skill 并发布，再对话：Manifest 中没有 HTML 页面内置 Skill，并记录被覆盖的内置 Skill 与覆盖者；另两个内置 Skill 仍在。员工从 Skill 广场选择该 Skill 时同样生效。
4. 管理员在 Runtime 中紧急停用“文件分析”内置 Skill：新运行不再装配，Manifest 记录停用；执行中的运行再激活它时只拒绝这一次并告知模型，运行继续。
5. 管理助手、Skill 安装与试运行、会话摘要、项目档案员运行的 Manifest 中没有内置 Skill。
6. 以“（平台内置）”结尾的名称上传、链接安装或经旧文本接口创建 Skill，被拒绝并说明原因。

**验收：** 内置 Skill 不需要 Skill 授权或空间授权，不进入依赖闭包；覆盖与停用确定性生效并可从 Manifest 追溯；系统与管理运行不受影响。

### BSK-P2 真实 DSH 下内置 Skill 提升产出

**优先级：** P2
**角色：** 员工
**运行层级：** 真实 DSH Run/Attempt、Runtime Adapter 与执行容器
**前置数据：** 未固定任何 Skill 的 Agent；一份含表格数据的 PDF 或 xlsx 附件
**spec：** 手工执行，按第 5.2 节留证

1. 上传附件要求分析并“生成一份 HTML 报告”：模型激活文件分析与 HTML 页面内置 Skill，成果为单个可离线预览的 HTML，结论标注出处、数值经计算。
2. 要求“整理成 Word 文档”：模型激活 Office 文档内置 Skill，成果 docx 可打开、通过成果登记。
3. 在 Runtime 中紧急停用 `bash` 后重复第 1 步：回答为 Markdown 并说明无法生成 HTML，运行不失败。

另需观察：模型调用 `activate_skill` 时传入的名称能否唯一匹配（目录行形如“文件分析（平台内置）（dsh-work-file-analysis@1.0.0）”，只传“文件分析”会得到“没有唯一匹配”）。

**验收：** 留存 Run/Attempt、激活记录、成果与版本；与不装配内置 Skill 的同题产出对比的人工结论写入发布说明。P0/P1 绿灯不能替代本层。
