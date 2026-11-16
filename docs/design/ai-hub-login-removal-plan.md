# 删除 AI Hub 登录方案

**状态：** AH1～AH7 均已确认；AH-S1 已实施（2026-11-16），Mac mini 升级待第 5 节检查后执行。
**更新日期：** 2026-11-16<br>
**依据：** [组织架构方案](org-structure-plan.md) OD1（“AI Hub 账号登录计划删除”）；现有身份实现（`server/src/modules/identity/`，迁移 0014、0016～0018、0020、0042、0077、0078、0117）；[独立账号登录](../release/local-authentication.md)。

## 1. 现状与目标

**现状：** 平台有三种登录方式：独立账号密码（始终可用）、钉钉容器内免登（绑定在独立账号上）、AI Hub OIDC（部署配置了 `AI_HUB_*` 连接变量时才启用）。AI Hub 一侧包括：

- **登录：** Authorization Code + PKCE 登录、切换账号、回调、登出（`/auth/{workbench|admin}/oidc/*`、`/auth/{audience}/callback`），会话里加密保存 Access/Refresh Token 并按需刷新；
- **员工目录同步：** 默认每 900 秒从 AI Hub 拉取员工增量，停用员工即撤销会话；
- **初始管理员认领：** `/auth/admin/bootstrap`，由 AI Hub 中登记的应用初始管理员一次性认领首位平台管理员；
- **散落的分支判断：** 授权、组织架构、知识库、管理端员工目录、定时任务后台身份复核中按 `identity_provider = 'ai-hub'` 的分支；
- **配置回退：** 服务端与发布脚本在未配置 `DSH_WORK_*_ORIGINS` / `DSH_WORK_*_DEFAULT_ORIGIN` 时回退读取 `AI_HUB_*_PORTAL_URL`。

生产环境（Mac mini）已于 2026-11-15 在数据库中确认：没有 AI Hub 用户，也没有 AI Hub 会话；PF-07 也已决定不验证 AI Hub/OIDC。

**目标：** 彻底删除 AI Hub 登录集成，登录方式只保留独立账号密码与钉钉免登；删除后代码、数据库、配置、部署脚本和文档中不再有 AI Hub 登录相关的路径。

## 2. 决策

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| AH1 | 彻底删除 AI Hub 登录、员工目录同步和 AI Hub 初始管理员认领，不保留开关或隐藏入口。首位管理员只通过独立账号初始化（`auth:bootstrap` / `local-bootstrap.js`）。 | 已确认（2026-11-15） |
| AH2 | 不兼容老 AI Hub 用户：生产库没有 AI Hub 用户和会话，不做账号转换。新迁移删除残留的 `ai-hub-oidc` 会话；遇到任何 `identity_provider = 'ai-hub'` 的用户时直接失败并提示先处理这些账号（只可能出现在开发或测试库中），不静默删除或改写。 | 已确认（2026-11-15） |
| AH3 | 部署中残留的 `AI_HUB_*` 变量和 `DSH_WORK_AUTH_MODE=oidc`/`local` 不再读取：服务启动时只记一条警告并忽略，不阻止启动，避免旧 `runtime.env` 升级后起不来（`DSH_WORK_AUTH_MODE=prototype` 仍按现状报错）。`DSH_WORK_*_ORIGINS` 改为必填，不再回退到 `AI_HUB_*_PORTAL_URL`。 | 已确认（2026-11-16） |
| AH4 | `/auth/{audience}/configuration` 保留 `mode: 'local'` 与 `localEnabled: true`，删除 `aiHubEnabled`；`mode` 不再出现 `oidc`。钉钉相关字段不变。 | 已确认（2026-11-16） |
| AH5 | 部署文档不再假设与 AI Hub 同机：Mac mini 手册删除 AI Hub 端口与健康检查、AI Hub 应用登记、从 AI Hub 目录读取证书等内容，证书改为“企业内网根 CA 签发的服务器证书”，来源目录由部署人员指定。dsh-work 部署目录中已有的证书副本不受影响，现有部署无需重新签发。同机若还运行其他服务，只保留通用的“端口不得冲突”要求。 | 已确认（2026-11-15） |
| AH7 | 不再考虑把治理能力迁入 AI Hub：删除架构总览第 11 节“跨应用治理复用达到门槛后迁入 AI Hub”一条，第 6 条改为 Agent、Skill、Tool、Model、发布治理与 Workspace、Session、Run/Attempt 等运行状态都由 dsh-work 持有。完成后仓库中不再有 AI Hub 的产品或架构依赖。 | 已确认（2026-11-16） |
| AH6 | `users` 表的 `identity_provider`、`business_user`、`external_subject` 列保留（独立账号仍在使用），`identity_provider` 只允许 `local`；只为 AI Hub 服务的 `external_user_id`、`identity_updated_at`、`directory_synced_at` 列一并删除。 | 已确认（2026-11-16） |

## 3. 删除范围

### 3.1 后端

- **整个删除：** `oidc-client.ts`、`ai-hub-client.ts`、`directory-sync-service.ts`、`OidcAuthService`（`auth-service.ts` 中）、`http/auth-routes.ts`（OIDC 登录、回调、切换账号、`/auth/admin/bootstrap`）、`session-repository.ts` 中 OIDC 事务、AI Hub 用户写入、初始管理员认领与 Token 刷新部分，`config.ts` 中 `OidcIdentityConfiguration` 的解析与 `types.ts` 中对应类型。
- **迁出后保留：** `auth-service.ts` 中被独立账号与钉钉登录共用的 `IdentityAccessError`、`assertAudienceAccess`、`normalizeReturnTo`、`validateRequestOrigin`、`resolveRequestOrigin`、`rejectCrossSiteNavigation`、Cookie 读写函数，连同它们依赖的私有函数（`requestOrigin`、`singleForwardedHeader`、`normalizeHeaderOrigin`、`isUnsafeMethod`）移到身份模块的公共文件；`validateRequestOrigin`、`resolveRequestOrigin` 的参数类型从 `Pick<OidcAudienceConfiguration, …>` 改为独立账号配置可满足的类型，调用方只改 import。
- **独立账号服务（`local-auth-service.ts`）：** 删除 `upstream_managed_status`（“AI Hub 账号状态请在企业身份平台中管理”）分支、`loginAccountExists` 中与 AI Hub 登录账号比对的 `union` 查询，以及“撤销此前的密码与 AI Hub 会话”注释中的 AI Hub。
- **简化：** `config.ts` 只剩独立账号配置（`loadStartupIdentityConfiguration` 不再判断 `AI_HUB_*`，按 AH3 警告）；`portal-authenticator.ts`、`local-auth-routes.ts`、`dingtalk-auth-routes.ts` 去掉 `oidc` 参数及“登录时顺带撤销 OIDC 会话”的分支；`main.ts` 去掉 OIDC 服务、目录同步定时器、`automationDirectory` 与 `ai-hub-oidc` 运营来源；`session-routes.ts` 的 `AuthConfiguration` 去掉 `aiHubEnabled`，`router.ts` 中提到 AI Hub 的错误提示改写。
- **删除 `ai-hub` 分支：** 管理端员工目录与搜索（`administration-service.ts`）、组织架构成员查询（`postgres-organization-service.ts`）、知识库权限（`knowledge-access.ts`、`postgres-knowledge-base-service.ts`、`weknora-knowledge-provider.ts`）、定时任务后台身份复核（`postgres-authorization-service.ts` 的 `resolveAutomationSubject` 只做 active + 租户 + 当前角色检查）、运营概览的 `sso` 字段、钉钉配置与自助绑定中的 AI Hub 判断。
- **测试：** 删除只测 AI Hub 的用例（`portal-auth.integration.test.ts`、`bootstrap-scope.test.ts`、`identity.integration.test.ts` / `identity.test.ts` / `authentication-startup.integration.test.ts` 中 OIDC 部分）；`local-auth.test.ts`、`review-p2-origin.test.ts`、`router-error-experience.test.ts` 中的 OIDC 用例与断言同步删改；其他集成测试中构造 AI Hub 用户的夹具改为独立账号。`scripts/acceptance/pf07-mcp-platform-probe.ts`、`scripts/bench/team-workspace-statistics.ts` 插入 `identity_provider = 'ai-hub'` 的测试用户，迁移后会失败，改为独立账号。`test-identity.ts`、`dingtalk-config.ts`、`postgres-workspace-member-service.ts` 中提到 AI Hub 的注释同步删除。`scripts/checks/security.mjs`、`project.mjs` 及其测试中引用 `ai-hub-client.ts` 与 AI Hub 文档的检查项一并删除。

### 3.2 数据库（新迁移 0129）

已有迁移一律不修改。新迁移按顺序：

1. 清理与检查（AH2）：删除 `authentication_provider = 'ai-hub-oidc'` 的会话；存在 `identity_provider = 'ai-hub'` 的用户时抛出异常并说明原因。全新数据库按迁移 0016 的条件不会产生 AI Hub 用户，生产库已确认没有；
2. 删除表 `oidc_login_transactions`、`application_admin_bootstrap_claims`、`identity_directory_sync_state`；
3. `authentication_sessions`：先删除 `access_token_encrypted`、`refresh_token_encrypted`、`token_expires_at` 列（PostgreSQL 删列时会连带删除引用这些列的 `authentication_session_credentials`），再以同名重建该约束，只保留 `local-password` 不带 `binding_id`、`dingtalk` 必带 `binding_id` 两种组合；重建 `authentication_sessions_provider_check` 为 `('local-password', 'dingtalk')`；去掉 `authentication_provider` 的默认值 `'ai-hub-oidc'`（迁移 0077），由代码显式写入；
4. `users`：删除迁移 0078 的 `users_ai_hub_login_account_idx` 与 0016 的 `users_external_identity_unique` 索引；迁移 0017 的 `users_business_directory` 部分索引条件含 `identity_provider = 'ai-hub'`，删除后以 `where business_user` 重建，供管理端员工目录使用；按 AH6 删列（管理端员工目录查询与搜索中对 `external_user_id`、`directory_synced_at` 的引用随 3.1 删除），重建 `identity_provider` 检查为只允许 `local`（0016 中该约束名为自动生成，沿用 0117 的做法按实际定义查找后删除重建）。

### 3.3 前端

- **登录页（`packages/ui-core` 的 `LocalAuthPage.vue`）：** 删除“使用 AI Hub 账号登录”按钮、跳转逻辑、`ai_hub_unavailable` 与“AI Hub 登录尚未启用”提示、“或使用 AI Hub 账号登录”文案；`mode` 只接受 `local`（P0 冒烟为 `prototype`）。
- **两端 `AuthErrorView.vue`：** 删除 `business_user_required`、`access_denied`、`initial_admin_not_authorized` 等只由 OIDC 流程产生的错误文案。
- **管理端员工与权限（`IdentityAccessView.vue`）：** 删除“来源”列、账号来源、AI Hub 用户标识、目录同步时间、“由 AI Hub 管理”说明及 `directoryEnabled` 判断。
- **管理端接入说明（`IntegrationGuideView.vue`）：** 删除“不配置 AI Hub 回调”“不调用 OIDC 登录”“不要求 AI Hub / OIDC”等说明句。
- **登出：** `GET /auth/{audience}/logout` 只由 OIDC 路由注册（未配置 AI Hub 时本来就不存在），两端 `stores/auth.ts` 在 POST 登出失败时回退到 GET 的逻辑删除，`IntegrationGuideView.vue` 中“或 GET”的说法同步删除。
- **类型与注释：** 两端 `domain.ts`、管理端 `stores/auth.ts` 去掉 `ai-hub`、`ai-hub-oidc` 取值；`DingTalkSettingsSection.vue`、`stores/knowledge.ts` 中提到 AI Hub 账号的注释同步删除。

### 3.4 配置与部署

- `.env.example`、`deploy/runtime.env.example` 删除 `AI_HUB_*` 段落与说明。
- `preflight.sh`、`release.sh`、`render-endpoint-compose.mjs` 去掉对 `AI_HUB_*_PORTAL_URL` 的回退，缺少 `DSH_WORK_*_ORIGINS` 时给出明确提示；`release.sh` 未配置 `DSH_WORK_*_DEFAULT_ORIGIN` 时取对应 `ORIGINS` 的第一个，与服务端一致；`preflight.sh` 去掉 `aiHubConfigurationIssue` 警告；`configure-macmini-endpoints.mjs` 与 `set-macmini-endpoints.sh` 不再写入 `AI_HUB_*_PORTAL_URL` / `_REDIRECT_URI`，执行时顺带删除 `runtime.env` 中已有的这四项；`deployment-safety.test.mjs` 相应调整。
- P0 冒烟服务（`smoke-router.ts`）的配置接口去掉 `aiHubEnabled`；`scripts/testing/*-browser.ts` 中的 AI Hub 引用一并清理。

### 3.5 文档与验收材料

- **删除：** `docs/release/ai-hub-sso-integration.md`（同时从 `docs/index/README.md` 与项目检查清单移除）。
- **修改：** 架构总览（身份来源、外部依赖表、上游不可用规则、登录流程、限制与风险、第 11 节生产演进中的“AI Hub 联调”与“治理迁入 AI Hub”（AH7）、第 12 节相关文档中的 AI Hub 接入链接）、内部端口与契约（认证注册、定时任务后台身份、`configuration` 契约、`loginAccount`）、功能规则（项目空间选成员、定时任务后台身份、组织架构范围、钉钉绑定中的 AI Hub 说明）、数据模型、移动端接入规范、开发与测试、独立账号登录、Mac mini 部署手册（按 AH5：开头说明与第 1 节端口表去掉 AI Hub 与 authentik、第 2 节去掉 AI Hub 根目录参数、第 4.2 节去掉 AI Hub 健康检查并改写证书来源、删除第 5 节“在现有 AI Hub 登记应用”、第 7 节去掉 `AI_HUB_*` 配置、第 8 节去掉 OIDC Discovery 预检、第 9 节首位管理员改为 `local-bootstrap.js` 初始化并按独立账号验收，第 10～13 节去掉与 AI Hub 备份回执、登录排错、多入口回调登记的对照，其余章节编号顺延）、三份 OpenAPI（auth、admin、workbench；mobile-h5 中的描述）、Agent 设计规范与生命周期模板中的 OIDC 措辞、相关设计方案中的 AI Hub 说明。
- **项目规范：** `AGENTS.md` P0/P2 说明中的“OIDC”改为“钉钉免登”或删除（需评审时一并确认）。
- **验收矩阵：** `agent-platform-capabilities.v2.json` 中 `real-oidc-task` 已为 `removed`，补充删除原因；`pf07-platform-acceptance.md` 去掉“真实 OIDC”要求。
- **E2E：** `e2e/login-options.integration.spec.ts` 保留并改写（实施时调整：它的只读管理员、搜索、窄屏与新建账号校验用例仍有价值），夹具改为本地账号，AI Hub 相关断言改为“没有 AI Hub 入口、OIDC 入口返回 404”；`scripts/testing/playwright-p0-config.test.mjs` 与管理端相关单测同步调整；`local-auth.integration.spec.ts` 与 `project-space.integration.spec.ts` 去掉 AI Hub 场景；验收目录 `admin-platform.md`、`agents.md`、`organization.md`、`dingtalk.md`、`workbench.md` 与 `TEST-CATALOG.md` 中的 AI Hub 旅程删除或改写。
- **架构图：** `diagrams/` 中的 AI Hub OIDC 节点删除；README 的登录说明同步。
- **其他：** `docs/release/c-tier-p2-acceptance.md` 与 `scripts/acceptance/c-tier-p2.mjs` 中“通过 AI Hub 登录”的说法，`docs/index/README.md` 项目空间一行中的“P2/OIDC”。

## 4. 实施切片

一个实施 PR（AH-S1）：后端、迁移、前端、部署脚本、文档与测试一起改，因为登录配置契约（AH4）与迁移约束需要前后端同时生效，拆开会出现中间不可用的状态。开 PR 后按惯例新开会话评审。

## 5. 前置检查（实施前在 Mac mini 执行）

1. **生产库中的 AI Hub 数据（已完成）：** 2026-11-15 确认生产库没有 AI Hub 用户和会话（AH2）。
2. **部署配置不依赖回退：** `runtime.env` 中 `DSH_WORK_WORKBENCH_ORIGINS`、`DSH_WORK_ADMIN_ORIGINS`、`DSH_WORK_WORKBENCH_DEFAULT_ORIGIN`、`DSH_WORK_ADMIN_DEFAULT_ORIGIN` 均有值（2026-11-09 用 `set-macmini-endpoints.sh` 调整 IP 时已写入，需再确认）。不满足时先补齐，再升级到 AH-S1 版本。`configure-macmini-endpoints.mjs` 过去一直把 `AI_HUB_*_PORTAL_URL` / `_REDIRECT_URI` 写进 `runtime.env`，生产必然有残留：升级后按 AH3 只会产生警告，升级时把这四项与其他 `AI_HUB_*` 一起从 `runtime.env` 删除。
3. **会话影响：** 独立账号会话 Cookie 名在配置 AI Hub 与否时相同（`dsh_work_local_session` / `dsh_work_local_admin_session`），升级不会让独立账号员工全部掉线。

## 6. 验收

- **单元与集成：** 服务端、两端前端单测与集成测试全绿；配置加载测试覆盖“残留 `AI_HUB_*` 时警告并忽略”“缺少 `DSH_WORK_*_ORIGINS` 时报错”。
- **迁移：** 在专用一次性 PostgreSQL 上验证两种情况：无 AI Hub 用户时迁移成功且约束、表、列符合 3.2，残留的 `ai-hub-oidc` 会话被删除；有 AI Hub 用户时迁移失败并给出提示。
- **P0：** 登录页不再出现 AI Hub 入口；独立账号登录、改密、登出正常。
- **P1：** 改的是认证，按项目规范运行全部 `pnpm test:e2e`；覆盖独立账号登录、钉钉容器内免登与绑定、管理端员工与权限、定时任务后台身份复核。
- **P2（Mac mini）：** 完成第 5 节检查后升级；验证员工端与管理端独立账号登录、现有会话不掉线、定时任务按时触发、钉钉免登正常；访问 `/auth/workbench/oidc/login` 返回 404。

## 7. 回滚

迁移会删除表和列，回滚需要从升级前的备份恢复数据库并回退到上一版本。升级前按手册第 12 节完成异机备份。
