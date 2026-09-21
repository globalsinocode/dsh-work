# 批次 3：个人工作闭环（B3/B4/B5/D12）

本批在前八项已交付修复之上实施，不改 DSH 执行引擎、TW-10/AG-03 的产品范围。当前可取得的源码不包含用户本地 TW-10/AG-03 合并结果；应用补丁时必须保留那些已有授权 SQL、purpose 分支和自动化参数。不得把本批隔离测试当作用户新主线回归。

## 范围与默认规则

- B3：现有 Conversation Repository 提供 `listSessionsForUser`，`GET /sessions` 与 `GET /sessions/:sessionId`。先按作者/当前空间权限过滤，再按 Session 分页；最近 Run 列表仍只是快捷入口。本人全局历史不等于团队共享会话目录。
- B4：现有 Content Service 提供 `GET/POST /files`、`GET/DELETE /files/:fileId`。个人材料、会话附件、生成成果由服务端关联确定，不为每类建表；下载仍复用文件授权，移除仍保留底层字节/解析和历史引用。
- B5：采用 [个人内容生命周期](personal-content-lifecycle.md)。软删除统一呈现为“移除”，不物理删除、不自动转交、不编造保留天数。停用账号复用身份同步与 A2 撤权。
- D12：员工主导航为新对话、团队空间、自动任务。历史对话与我的文件保留路由、数据能力和上下文入口，但不显示在主导航。后台默认个人 Workspace 保留，员工端不显示它的卡片、选择器和成员管理。全局请求不带 workspaceId，由服务端按当前用户解析；显式错误 ID 必须拒绝，不回退到第一个团队。团队入口固定团队归属；旧 Session/Run 不迁移空间。

本文件对旧团队交付中 AC-23 的“个人界面冻结”作明确范围修订：本批允许个人工作闭环与共用安全逻辑变化，不改变团队私有/共享会话权限。原团队变更记录保留为历史依据。

## 兼容与查询边界

空间、历史和文件在原服务内共享 `readableWorkspacePredicate`，不新增平行 Repository。服务端身份/功能权限与对象检查仍必须组合使用。新历史和个人文件的游标保留数据库微秒精度，不把 Date 的毫秒截断用于下一页定位。

- 原 `POST /sessions` 支持省略空间、显式本人个人 ID、legacy standalone；不允许他人个人空间或错误团队。
- `/workspaces/:id` 先通过服务端有权列表确认，个人 files/artifacts/conversation 链接分别跳转到材料、成果、历史入口；无权 ID 显示拒绝，不能静默跳回默认页。
- `/artifacts` 为 `/files?source=artifact` 别名；`/tasks/:runId` 和 `/conversations/:runId` 继续可用。Agent/Skill 入口仍在选择器/广场中，不因四导航而删除能力。
- 原型无数据库时，新持久化功能明确 503，不以空列表或 Mock 回答假装工作成功。生产数据库路径不会回退到原型。
- 新增迁移仅 `0044_personal_session_history_index.sql`。0042/0043 是用户已确认的上批重排，本批不再重发其重命名；不修改历史迁移。

## 验证入口

`pnpm test:review:batch03:integration` 执行 B3/B4/B5/D12 的可丢弃 PostgreSQL 回归（包含受控 Run/Attempt 的 HTTP 闭环），已接入 CI。前端新增用例被既有 `test:m5:frontend` 包含。

`pnpm test:e2e` 包含 P0 四导航/旧链接及原有冒烟；`pnpm test:e2e:personal` 使用 `playwright.personal.config.ts`，独立创建 PostgreSQL、受控身份和 `PersonalBrowserRuntime`。该测试替身只由 scripts/testing 显式启动，生产 main 不引用；没有模型调用或第二套 Agent Loop。两套浏览器测试均已接 CI，P1 不被默认 P0 重复运行。

P1 默认端口 4374/4390，可通过 `DSH_WORK_PERSONAL_WEB_PORT` / `DSH_WORK_PERSONAL_SERVER_PORT` 指定；不复用现存业务服务器。测试必须设置专用 `DSH_WORK_TEST_DATABASE_URL`。`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 仅供明确指定已有浏览器，默认仍用 Playwright 安装的 Chromium，不绕过任何浏览器策略。

本环境浏览器访问被系统 URL 管理策略拒绝；预演与 P1 首例返回 `ERR_BLOCKED_BY_ADMINISTRATOR`。未解除策略、未用 DOM 测试冒充浏览器通过。完整 P0/P1 与真实 DSH/OIDC/Python/目标硬件验收仍需在允许的环境执行，见 [D12 证据](review-d12-evidence.md)。
