# DSH-work 改动报告（2026-10-16 ~ 2026-10-22）

核对时间：2026-10-22 上午。数据来自本地仓库 `dsh-work1` 与 GitHub `globalsinocode/dsh-work`（`origin`：`https://github.com/globalsinocode/dsh-work.git`）。提交按提交者日期计入区间 `2026-10-16 00:00` 至 `2026-10-22 24:00`（UTC+8）。树差异的基线是 10 月 16 日之前的 `origin/dev`：`0ababea`。

## 结论

这一周 GitHub `dev` 上有 **82 条非合并提交**、**9 个版本标签**。相对基线，已推送内容是 **181 个文件，+14,231 / −737 行**。

三层进度并不相同：

| 位置 | 提交 | 状态 |
| --- | --- | --- |
| GitHub `main` | `8277d76`（10/21 08:18） | 团队空间输入条与附件已合并。比标签 `v2026.10.20-05` 超前 12 个提交，这 12 个还没打新 tag |
| GitHub `dev` | `4570060`（10/21 16:18） | 比 `main` 多 5 个提交 |
| 本地 `dev` | `7d15437` | 比 GitHub `dev` 少 1 个提交（名册加载修复 `4570060` 尚未拉取） |

本地工作区相对 `7d15437` 还有 **64 个已改文件（+3,265 / −584 行）** 和 **54 条未跟踪路径**。这些是 10 月 21 日的六批加固，尚未进入 GitHub 的 `dev` 或 `main`。`origin/main` 的提交都已包含在 `origin/dev` 中。

本周 GitHub 只合并了 [PR #3](https://github.com/globalsinocode/dsh-work/pull/3)（`codex/target-environment-hardening` → `main`，即 `v2026.10.19-01`）。10 月 18 日没有提交。另有 4 个更早的本地 stash（拉远端前的暂存），没有计入下面的功能改动。

## 提交量

非合并提交按提交者日期（来源：`origin/dev`）：

| 日期 | 条数 |
| --- | ---: |
| 10/16 | 15 |
| 10/17 | 13 |
| 10/18 | 0 |
| 10/19 | 28 |
| 10/20 | 21 |
| 10/21 | 5 |

10/16 的 15 条里，有 13 条作者日期在 10/9–10/10，提交者日期是 10/16，属于发布线回灌。

作者（非合并提交）：

| 作者 | 条数 |
| --- | ---: |
| 1tang1315 | 31 |
| globalsinocode | 25 |
| GJcode-code | 15 |
| dsh-work release line | 11 |

## 已打标签的发版

标签都在 `origin/main` 上。10/21 早上把 `dev` 合并进 `main`（`8277d76`）之后没有新标签。`git describe`：`main` 为 `v2026.10.20-05-12-g8277d76`，`dev` 为 `v2026.10.20-05-18-g4570060`。

| 标签 | 时间 | 这一版带上的内容 |
| --- | --- | --- |
| `v2026.10.16-01`（同 `target-v2026.10.16-01`） | 10/16 10:42 | 发布线回灌：Agent 校验与失败回填、ACP 模型路由、Skill/工具连接器源码化 |
| `v2026.10.19-01` | 10/19 10:00 | PR #3 目标环境加固：草稿分类、委派校验、预检与 nginx 日志 |
| `v2026.10.19-02` | 10/19 20:02 | Windows 执行、成员名册、成果卡片与 CI 跨平台修复 |
| `v2026.10.19-03` | 10/19 22:08 | 成果预拉取不再打成请求风暴；补充分支同步约定 |
| `v2026.10.20-01` | 10/20 08:48 | 团队空间添加员工不再限定 AI Hub 目录身份 |
| `v2026.10.20-02` | 10/20 09:52 | 旧版 Excel（`.xls`）按文件头识别并解析 |
| `v2026.10.20-03` | 10/20 10:29 | 工作簿内嵌图片挂进工作区；附件在 dispatcher 只取一次 |
| `v2026.10.20-04` | 10/20 10:44 | 提示词不再承诺模型一定能看图 |
| `v2026.10.20-05` | 10/20 11:08 | 管理端可声明图片输入；图片 ZIP 总量与条目上限；部署说明 |

## 已推送到 GitHub 的功能改动

同日连续提交按主题合并。纯版本号提交，以及「把 main 并回 dev」的同步提交，不单列功能。

### 10/16 发布线回灌（`v2026.10.16-01`）

- `ccb499e` globalsinocode：回灌可见角色校验、提示词检查与失败原因（B1/C2/D1/D2）。
- `cb54005`、`ec0542a` release line：ACP 模型路由改为站点配置，并显式转进 DSH 子进程。这是此前 `-02` 安装预检失败、以及 T4 造成「agent 无 provider/model」的修复。
- `8fc76a0` release line：ACP 模板不再写死模型路由，交给 DSH 设置。
- `0cd7590` release line：运行时工具连接器范围改为显式配置（DEV-001 源码化，替代构件补丁）。
- `3cd1fd2` release line：会话指定 Skill 进入 Manifest 与提示词。
- `6cb7e95` release line：`activate_skill` / `python_execute` 接受 `id@version`。
- `7159b5a` release line：畸形 `agent_spec` 改为领域错误，并补齐夹具与 tool-binding 文案。
- `3b7a5f5` release line：nginx 上游双栈解析参数化，站点取值不再依赖构件补丁。
- `590a647` globalsinocode：团队对话页按 Run 打开时补齐共享讨论历史。
- `dd1f6d9` globalsinocode：候选查询断言改为部署面语义，并补业务角色对照。
- `ca871d1`、`075e1f8`、`3c87e7d` release line：白名单必须覆盖已发布 Agent 版本引用过的连接器；记录升级后必查的两类「建会话 403」；手册补升级前白名单核对 SQL。

作者日期在 10/9–10/10 的条目，提交者日期均为 10/16，随这次回灌进入本周历史，且不在 10/16 之前的基线 `0ababea` 里。

### 10/17 目标环境加固（10/19 经 PR #3 进入 main）

- `667b00e` globalsinocode：弹窗内 `el-form` 拦截原生提交，回车不再把页面重载、丢掉已输入内容。
- `1e40512` GJcode-code：非法草稿与重复 id 分类。
- `3fb9ac0` GJcode-code：拒绝畸形委派目标列表。
- `8281396`、`ef54098`、`e81cb56` GJcode-code：保留发布试用冲突语义；草稿冲突不记成功审计；补 e2e 失败分类。
- `ce71469`、`ffb5628` GJcode-code：目标环境 preflight；模拟 provider 拒绝的审计链。
- `d24539d`、`210fdae` GJcode-code：代理连接失败做关联并设上限；nginx 访问日志去掉 query string。
- `8dd87e0`、`1aa5e41`、`6814b4a` GJcode-code：检查夹具纳入目标环境快照；模拟清理步骤对齐具名 worktree；补充目标候选的 P2 交接文档。

`v2026.10.19-01` 的标签说明是 `Merge pull request #3 from globalsinocode/codex/target-environment-hardening`，准备提交为 `25e7e38`（`chore(release): prepare 2026.10.19-01`）。

### 10/19 对话执行、成员与 CI

运行与成员：

- `af2afeb` 1tang1315：身份 HTTP 超时可配置，恢复僵死目录同步。
- `eec0921` 1tang1315：Windows overlay 与 Skill 迁移补齐旧 Attempt manifest。
- `d6fb206`、`9fb2d04` 1tang1315：修复 Windows 本地 DSH 执行；路径与 Run 状态同步，改善对话执行体验。
- `e0e576a`、`acece8d` 1tang1315：成员角色变更后触发 refresh，名册热更新；成员弹窗禁用负责人选项，并引导至空间设置转交。
- `677cd31` 1tang1315：团队空间 Tab 快捷键快速 @ Agent 成员。

成果展示：

- `a0a1ec9` 1tang1315：发送、重试与下载统一防连点。
- `3153b5c` 1tang1315：继续对话后仍展示各轮 Run 的成果卡片。
- `79ae89e` 1tang1315：团队空间成果自动刷新，并优化成果卡片图标。
- `74626d0`、`5e171c6` 1tang1315：点击成果名称直接预览，并扩展多类型展示；Markdown 预览支持引用块与分隔线。
- `11ecaa7` globalsinocode：对话页成果预拉取不再自激成请求风暴（进入 `v2026.10.19-03`）。

CI（`v2026.10.19-02` 前后的一串修复）：

- `c7d8fd6`：修复 CI 静态检查与跨平台验证。
- `ca50d73`：修复 ESLint `projectService` 无法解析 Vue 与共享包。
- `2251d55`：在无 procps 环境下仍能通过 concurrency probe。
- `5a7b913`：修复 Linux 单元测试中的路径与 Agent 包校验。
- `48b5ec4`、`af9910d`：reference `agent.yaml` 校验和与 Git 中的 LF 内容对齐。

分支约定（随后在 10/20、10/21 又改过一次，见下节）：

- `9c02f7e`：约定改动先落 `dev`，零星小改动再 cherry-pick 到 `main`。
- `1ae9e0f`：补全提交前先拉取、`main`→`dev` 双向同步，冲突在本地解决。

### 10/20 文件解析、图片输入与团队空间输入条

已打标签：

- `def4e9f` globalsinocode：团队空间添加员工不再限定 AI Hub 目录身份，本地账号可以加入（`v2026.10.20-01`）。
- `5df3e0f` globalsinocode：旧版 Excel（`.xls`）按文件头识别并解析出可用文本（`v2026.10.20-02`）。
- `9b6c6ae`、`5436a1b` globalsinocode：工作簿内嵌图片随解析结果作为附件挂进工作区；附件在 dispatcher 里只取一次（`v2026.10.20-03`）。
- `d40a2ac` globalsinocode：提示词不再承诺模型一定能看图（`v2026.10.20-04`）。
- `e524e60` globalsinocode：图片 ZIP 读取补上条目数 4096 与解压总量 64 MB 上限。
- `ec0a69f`、`76531ee` globalsinocode：管理端模型能力可声明「图片输入」，与运行时 `input: [text, image]` 对齐；部署手册写明 `DSH_HOME/settings.yaml` 必须声明该能力，未声明时 `read_image` 会在附加图片前拒绝（`v2026.10.20-05`）。
- `cce1add` globalsinocode：工作流改为「改动只落 `dev`，发版时才 merge 进 `main`」。

已在 `main`、晚于 `v2026.10.20-05`、尚未打 tag（10/21 08:18 由 `8277d76` 合并进去）：

- `868004f`、`233ad74` 1tang1315：成果 Markdown 预览与对话区统一为 `packages/ui-core` 的 `renderMarkdownPreview`；标题按原文层级输出（`##` 为 h2），测试断言从旧渲染器的 h4 改为 h2。
- `57ec8c3` 1tang1315：修复团队空间 Tab 快速 @ Agent，历史对话底部输入固定，并统一底部快捷键提示。
- `0294cd7` 1tang1315：团队空间历史与会话共用底栏输入条；`team-space-composer` 统一挂载，草稿按键分开；空间内嵌对话不再自带输入框；Agent 名册由空间页一次加载供 Tab 使用。
- `140bfff`、`fe58d42` 1tang1315：修复会话返回与底栏呈现回归（离开路由后不再误用空间 id 拉线程）；底栏仅在会话详情展示；经 bridge 恢复时回到最新消息；加载态改为详情布局骨架屏。
- `565b76f`、`e99fd0b` 1tang1315：常用任务与预设文案切换不再重挂载输入条；空草稿不再冲掉本地上传；对话页按 Run attachments 在用户消息顶部展示附件；去掉 `contextKey` 未使用变量告警。
- `4cae870`、`e8d02c8` 1tang1315：修复 CI 类型检查与 UI 契约门禁；写明 workbench-web 新建单测目录约定。

图片相关的 6 个提交（`v2026.10.20-03` 至 `-05`）当时直接落在 `main` 并发版。`5c8311b` 用一次合并把它们追平进 `dev`。冲突只在 `ConversationStarter` 底部提示：保留 `dev` 的 `TEAM_COMPOSER_SHORTCUT_HINT` 与 `requiresAgentMember`，同时保留 `main` 补上的 XLS 支持格式。这些 tag 已是不可变 Release，历史没有改写。

### 10/21 只在 GitHub `dev`、还没进 `main`

| 提交 | 作者 | 本地 `dev` | 改动 |
| --- | --- | --- | --- |
| `1767fe9` | 1tang1315 | 已有 | 发版改为快进 `main`，避免再多出一个合并提交 |
| `ce04d34`、`5769ea3`、`7d15437` | GJcode-code | 已有 | 六批独立加固的设计与计划，并把目标分支指到 `dev` |
| `4570060` | 1tang1315 | 未拉取 | 名册加载中不再把角色未知显示成只读无权限 |

`4570060` 的说明：团队空间进入后员工名册可能晚于空间列表返回。将角色未知与只读成员区分，pending 期间禁用发送，不展示 blocked 文案。改动文件：

- `apps/workbench-web/src/components/ConversationStarter.test.ts`
- `apps/workbench-web/src/components/ConversationStarter.vue`
- `apps/workbench-web/src/components/team-space-composer/team-space-composer.vue`
- `apps/workbench-web/src/views/WorkspaceDetailView.vue`

约 +49 / −2 行。本地执行 `git pull`（或 `git merge --ff-only origin/dev`）后才能包含它。当前工作区有未提交改动，拉取前需要先处理这些改动。

`b79d55c` 是把 `main` 上多出的发版合并提交接回 `dev` 的同步提交，没有新的产品行为。

## 只在本地工作区、尚未提交

相对本地 HEAD `7d15437`。依据未提交的 `docs/development/修改记录.md`。这些批次还没出现在 GitHub 的 `dev` 或 `main` 上。

| 批次 | 迁移 | 内容 |
| --- | --- | --- |
| Batch 1 会话可靠性 | `0084_session_drafts.sql` | 草稿 Session、服务端 `clientIntentId`、空草稿回收；前端 `idempotent-intent` 与 `tasks` 稳定键；`SessionResumeView` 委托 Store；`EmployeeShell` 在页面重新可见时 `refresh` |
| Batch 2 内容与工作空间契约 | `0085_workspace_object_gc.sql` | 对象写入失败可补偿并后台回收；列表/上传统一为 `WorkspaceFileProjection`；团队空间列表改为 `fileCount` 加详情分页；新增 `WorkspaceFilePickerDialog` 并接入 Composer；只读成员有 UI 门控 |
| Batch 3 工作空间通知 | `0086_workspace_notifications.sql` | sequence 游标、按收件人投递；讨论、@、Run 终态同一事务写动态与投递；账号级通知 API 与 SSE；`NotificationInbox` 与壳层角标 |
| Batch 4 自动任务生命周期 | `0087_automation_archive_metadata.sql` | 归档可恢复；执行历史游标分页；手工触发在不确定失败后可按幂等键重试；员工端归档筛选与抽屉轮询；弃用 DELETE 归档 |
| Batch 5 版本选择与 Session 导出 | — | 目录 DTO 增加 `versionId` / `versionReference`；`POST /sessions` 支持 `agentVersionId` / `skillVersionId`，不可用时返回 409 `selected_version_unavailable`；新增 `SessionExportService`，员工端改用服务端导出整段会话或单次 Run |
| Batch 6 撤权刷新与发布证据 | — | 管理端与员工端 coalesced `refresh()`、授权 403 处理器与可见性刷新；路由守卫按 overview → audit → forbidden 回落；服务端 403 映射到稳定撤权码；补充 release 矩阵与验收文档 |
| 本地开发规范 | — | `docs/development/local-skills/dev-standards/` 与本修改记录。只约束本地开发，不打包进 Skill 广场，不通过管理端导入 |

同一工作区里还有未提交的诊断问卷、Agency Agents 试点缺口说明、`docs/user/`、以及授权刷新 / 工作空间通知的 Playwright 配置（`playwright.authorization-refresh.config.ts`、`playwright.workspace-notifications.config.ts`）。

## 已推送改动的目录分布

`0ababea..origin/dev` 按改动文件数的大致占比：员工端 `apps/workbench-web`（组件、视图、utils）最高，其次是 `server/src/modules/runtime`、`server/src/modules/agent`、`server/src/domain`、`server/src/modules/workbench`、`docs/development` 与 `docs/superpowers/plans`。管理端改动集中在模型能力声明。部署侧改动在 `deploy/nginx`。

本地未提交改动的重心在 `apps/workbench-web/src/views`、`server/src/http`、`server/src/modules/workbench/application`、`server/src/modules/automation`，以及四条新迁移 `0084`–`0087`。
