# 目标机候选发布与 P2 回填

这份文档交给目标机上的智能体。它只说明如何把已推送的候选分支变成一份新的不可变 Release，并在目标机上做正向验收和安全失败验收。本地 Windows 上的测试绿灯不能代替这里的结果。

仓库是 `globalsinocode/dsh-work`。候选分支是 `codex/target-environment-hardening`，当前提交是 `8dd87e030661054c6d3d3c1deb4c51e1a403dd83`。若分支上还有更新的文档提交，以该分支的最新提交为准，并在回填里写实际发布的 Git commit。

## 1. 已经确定、不要重查的事实

- 开发基线是 `target/main` 的 `667b00ea12db2db599f0966c7866c32238583018`。现网不可变 Release `v2026.10.16-01` 对应 `af0faca9a86ab8fdecb937286c69199572232e3a`。
- `POST /api/admin/v1/agents` 的 500 是客户端 ID 命中 PostgreSQL `23505 / agents_pkey` 后未映射。候选版本应返回 409 `state_conflict`。
- `PATCH /api/admin/v1/agents/draft` 的 500 是未校验 JSON 就调用 `.trim()`。候选版本应返回 422 `invalid_request`。
- 发布试运行的当前入口是 `POST /api/admin/v1/agents/:agentId/release/case-trials`。前置条件不满足时返回 409 `state_conflict`，且不创建 trial、Run、Attempt。`POST .../release/trials`（没有 `trialId`）保持 404。
- 223 次失败 Attempt 的主因是供应商 401、少量额度 403 和畸形 prompt。`mcp invocation audit failed` 是没有 usage/tool 证据后的下游告警。不要在目标机用真实密钥再注入 401/403。本地证据在 `server/src/modules/runtime/runtime-adapter.test.ts` 的 `[provider-401]` 与 `[provider-quota-403]`。
- 6 次 504 是 Nginx 连接 `host.docker.internal:4190` 超时。`proxy_connect_timeout 5s` 只让失败更快出现。继续出现时，按 [Runbook 第 14 节](../release/mac-mini-deployment-runbook.md) 记录，不能写成拓扑已经修好。
- 目标 DSH 是 `0.1.2-rc.1`，提交 `76fda729799fe9b3848dbe2c211d4b231032b81e`，正式 profile `acp-app`。`DSH_RUNTIME_COMPATIBILITY` 必须保持未设置。

环境快照在 `config/target-environment/2026-10-17.json`。目标机的 Node、pnpm、PostgreSQL、DSH 版本、DSH commit、profile 和 migration `0081` 应与快照一致。快照里的 `sourceCommit` 是开发基线，候选提交比它新，这项不一致是预期结果。

## 2. 禁止事项

- 不覆盖 Tag、GitHub Release 或目录 `v2026.10.16-01`。不在 `releases/**` 里就地改已发布的包。
- 不复制、不回传模型密钥、Cookie、Token、Authorization、数据库内容、`runtime.env` 或 `~/.dsh`。回填只写 `SET` / `MISSING`、状态码、错误码、ID 的哈希和行数。
- 不在生产业务 Agent 上重放历史失败请求。重复 ID 和非法 PATCH 只作用于本次新建的专用测试 Agent。
- 不新增模型直连、备用 Agent Loop，也不绕过 Run/Attempt、Runtime Adapter 和 DSH。
- 不跳过 M6 quality gate，不用自编译包代替带 Sigstore 来源证明的 GitHub Release。
- 不把自动发布监听打开后立即发布稳定版。监听会在约 300 秒内安装最新稳定 Release。

## 3. 发布门禁

`.github/workflows/release.yml` 只接受 `main`，并且要求该提交上的 **M6 quality gate** 已经成功。`scripts/release/build-release.sh` 还要求 `server/package.json` 的 `releaseVersion` 与所发布的版本号一致。当前文件里的值仍是 `2026.10.16-01`，直接用它发布会被拒绝，也会和现网 Tag 冲突。

按这个顺序做：

1. 在目标机记录回滚指针，先不要部署：

   ```bash
   cat "${DWP_ROOT}/active-release"
   ```

   把输出的版本记为回滚目标。确认它不是即将创建的候选版本。

2. 暂停后续自动升级。把现有 `runtime.env` 里的 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改为 `false`，保留其余所有值。不要打印该文件。记录修改前的值是 `true` 还是 `false`。这一步不会中止已经开始的部署。

3. 选择新版本号。首选发布当天的 `YYYY.MM.DD-01`。执行：

   ```bash
   gh release view "vYYYY.MM.DD-01" --repo globalsinocode/dsh-work
   git ls-remote --tags https://github.com/globalsinocode/dsh-work.git "refs/tags/vYYYY.MM.DD-01"
   ```

   任一命令显示该 Tag 或 Release 已存在，就把末两位加一。不要复用 `v2026.10.16-01`。

4. 在候选分支把 `server/package.json` 的 `releaseVersion` 改成这个不带 `v` 的版本号。只改这一处。提交并推送到 `codex/target-environment-hardening`。

5. 向 `main` 打开 Pull Request。CI 只在 `main` 的 push 和 pull request 上运行，直接推这条分支不会产生 M6。等待 PR 上的 **M6 quality gate** 成功。失败时停止，把失败作业名称和结论写入回填的「未执行项」，不要发布。

6. 合并 PR。不要 force-push `main`。合并提交上的 M6 也必须成功。Manual release 发布的就是这个 `main` 提交，不是分支上合并前的旧 SHA。

7. 在 GitHub Actions 人工运行 **Manual release**。Ref 选择 `main`。输入不带 `v` 的版本号。等待工作流成功。确认新 Release 不是 draft、不是 prerelease、`isImmutable` 为 true，目标 commit 等于刚合并的 SHA，资产包含 `dsh-work-v<版本>.tar.gz` 和同名 `.sha256`。

8. 记录构件 SHA-256、文件清单校验，以及第 1 步的回滚版本。这些值进入第 16 节，不进入聊天里的密钥字段。

## 4. 在目标机安装候选

自动升级保持 `false`。按 [Runbook 第 6～8 节](../release/mac-mini-deployment-runbook.md) 下载、验证来源证明，并执行该 Release 包里的 `release.sh`。不要执行旧 `current` 里的脚本，不要重跑 `v2026.10.16-01` 的 `release.sh`。

安装后核对：

- `active-release` 和 `current` 指向新版本。
- 包内 `server/config/dsh/runtime-lock.json` 仍是 DSH `0.1.2-rc.1` / `76fda729799fe9b3848dbe2c211d4b231032b81e`。
- 宿主机 DSH profile 是 `acp-app`，`DSH_RUNTIME_COMPATIBILITY` 未设置。
- 数据库最高 migration 为 `0081`。只查询版本号，不导出业务表。
- 健康检查通过。`/health` 成功不能代替下面的业务验收。

验收期间不要把 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改回 `true`，也不要重装 release watcher。

## 5. P2 验收

使用管理端的真实登录身份。新建一个名称和 ID 都能看出是「候选验收」的 Agent，后续冲突和非法保存都只用它。

每一项都记录 HTTP 状态、响应 `code`、`traceId`、响应头 `X-Request-Id`。需要证明没有落库时，只记录相关表的行数或 revision，不记录正文。

1. 合法创建：界面或 API 创建该测试 Agent，得到成功状态。审计中有一条该 Agent 的 `agent.create` / `success`。确认只产生一次创建请求。
2. 用同一个 ID 再创建一次。期望 HTTP 409、`state_conflict`。Agent 行和版本行都不增加。
3. 对这个 Agent 发一次缺少 `name` 或 `welcomeMessage` 的 `PATCH /api/admin/v1/agents/draft`。期望 HTTP 422、`invalid_request`。revision 和版本数不变，没有新的 `agent.draft.update` / `success` 审计。
4. 在执行授权、Runtime 兼容或发布检查未满足时调用 `POST /api/admin/v1/agents/:agentId/release/case-trials`。期望 HTTP 409、`state_conflict`，且没有新的 trial、Run、Attempt。不要调用旧的 `POST .../release/trials`。
5. 用真实 DSH 跑一次正常 Attempt。记录 Run ID 和 Attempt ID 的哈希、终态，以及 usage/tool 证据是否存在。不要记录 prompt、回答或文件正文。
6. 从 Nginx JSON 访问日志和后端 `http.request.failed` 或同一次成功请求的响应头里取出同一个 `requestId`。访问日志的 `uri` 不应含查询串。`traceId` 仍是 `trace-http-` 开头，不与 `requestId` 合并。
7. 记录本次观察窗口的起止时间、504 次数、最长 `upstream_connect_time`。值为 `"-"` 表示没有连上上游；大约 5 秒表示建连超时。有连接时间但响应很长，按应用或依赖变慢记录。

供应商 401/403 不在目标机重做。回填里写「使用本地 Task 6 证据，未在目标机注入真实密钥」。

## 6. 回填

把下面这一节追加到目标机已有的 `docs/development/target-environment-diagnostic-questionnaire.md`。该文件不在候选分支里。不要把密钥、业务正文或完整连接串写进去。追加后的文档可以随验收记录提交，但提交前再搜一遍密钥形态。

```markdown
## 16. 候选版本 P2 验收回填

- Release / commit / artifact sha256：
- DSH version / commit / profile / compatibility 是否未设置：
- 数据库版本与最高 migration：
- Agent 合法创建：HTTP 状态、traceId、requestId、审计结果：
- 重复 Agent ID：HTTP 409、code、数据库行数未增加：
- 非法草稿 PATCH：HTTP 422、code、revision 未变化：
- case-trials 前置条件阻塞：HTTP 409、无 trial/Run/Attempt：
- 真实 DSH 正常 Attempt：Run/Attempt ID 的哈希、终态、usage/tool 证据：
- Nginx → 应用关联：同一 requestId 的两条安全日志摘要：
- 观察窗口内 504 次数、最长 connect time、是否在 5 秒附近失败：
- 未执行项与原因：
- 回滚是否演练、回滚目标：
```

回滚演练需要单独的维护窗口批准。没有批准时写「未演练」，并写上第 3 节记下的活动版本。不要为了演练把数据库降级，也不要删除数据卷。

## 7. 可否进入正式发布

只有这些条件同时成立，才把 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改回原来的值并恢复正常发布流程：

- 合法创建、重复 ID 的 409、非法草稿的 422、case-trials 的 409 都符合上一节。
- 真实 DSH 的正常 Attempt 完成，且有 usage/tool 证据。
- 同一次请求能用 `requestId` 把 Nginx 和应用日志对齐。
- 回填和日志里没有密钥。
- 观察窗口内没有新增的未分类 500。

504 仍出现、但在约 5 秒内失败时，记为独立的宿主机代理问题，不能宣称已经根治，也不能因此单独阻断一份否则合格的候选。出现未分类 500、真实 Attempt 没有走 DSH，或来源证明验证失败时，保持自动升级关闭，按 Runbook 回滚到第 3 节记录的版本。

回滚只使用 Runbook 中的 `rollback.sh` 和已验证的旧 Release。Nginx 这一项若要撤回，只恢复候选包里的 `deploy/nginx/default.conf.template` 与 `deploy/nginx/proxy_params`，不修改历史 Release 目录。
