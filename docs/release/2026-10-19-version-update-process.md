# 从本地开发到投入生产的版本更新流程

记录日期：2026-10-19。生产仓库是 `globalsinocode/dsh-work`。本文描述以后每次版本更新应走的完整路径，并在末尾标明 `v2026.10.19-01` 实际落地时与标准路径的差异。

生产服务器不编译、不合并、不触发发布。开发在本地完成，发布在 GitHub `main` 上由人工工作流完成，目标机只下载已经带 Sigstore 来源证明的不可变 Release，再执行该包内的 `release.sh`。

## 1. 本次已经在运行的版本

| 项 | 值 |
| --- | --- |
| 活动 Release | `v2026.10.19-01` |
| 合并提交 | `ee90ad834410d3b73b035f15f765c2f9e82e40a0`（PR #3） |
| 归档 sha256 | `a318fe44f4e56e7acf4d069d0a1f9257ee78ebb4d6020d730edb3b596df35011` |
| 上一活动版本 / 回滚目标 | `v2026.10.16-01`（`af0faca9a86ab8fdecb937286c69199572232e3a`） |
| 安装时间 | 2026-10-19 10:22 +0800 |
| DSH | `0.1.2-rc.1`，`76fda729799fe9b3848dbe2c211d4b231032b81e`，profile `acp-app` |
| 自动升级 | `DSH_WORK_AUTO_DEPLOY_ENABLED=false` |

GitHub 最新 Release 标签与上表一致。`main` 在该标签之后还有 3 个未发布提交（`719d5d9`），修复内容仍在这些提交里，但尚未进入新的 Release。

## 2. 标准流程

### 2.1 本地开发

1. 从生产仓库的 `main` 建隔离工作树和功能分支。不在日常脏工作区里改，不把目标机的 `runtime.env`、`~/.dsh`、业务库或模型密钥拷回开发机。
2. 修复只走现有 Run / Attempt、Runtime Adapter 与 DSH。不新增第二套 Agent 循环，不在 DSH 不可用时直接调用模型。
3. 用可丢弃 PostgreSQL 做集成验证。数据库连接只使用 `DSH_WORK_TEST_DATABASE_URL`。容器不挂载宿主机目录，测完删除容器。
4. 本地绿灯不能写成目标机 P2。Windows 上既有的符号链接、Unix socket 和 POSIX 路径失败，不作为本链路证据。

### 2.2 推送与合并

1. 推送到 `globalsinocode/dsh-work` 的功能分支。推送功能分支本身不运行 M6，也不会部署。
2. 选定当天未被占用的版本号 `YYYY.MM.DD-NN`。不复用已有 Tag，包括 `v2026.10.16-01` 和已经发布的 `v2026.10.19-01`。
3. 只把 `server/package.json` 的 `releaseVersion` 改成不带 `v` 的版本号，提交并推送。`scripts/release/build-release.sh` 要求它与发布输入一致。
4. 向 `main` 打开 Pull Request，等待该 PR 上的 **M6 quality gate** 成功。失败则停止，不发布。
5. 合并 PR。不 force-push `main`。Manual release 发布的是合并后的 `main` 提交，不是分支上合并前的旧 SHA。合并提交上的 M6 也必须成功。

### 2.3 生成不可变 Release

在 GitHub Actions 人工运行 **Manual release**：

- Ref 必须是 `refs/heads/main`。
- 输入不带 `v` 的版本号。
- 工作流拒绝已存在的 Release 或 Tag。
- 该提交的 M6 必须已经成功。
- 成功后的 Release 不是 draft、不是 prerelease，`isImmutable` 为 true，作者为 `github-actions[bot]`。
- 资产包含 `dsh-work-v<版本>.tar.gz` 和同名 `.sha256`，并有构建来源证明。

不要用本地 `pnpm build` 的目录代替这个包，也不要改包内 `release.json`。

### 2.4 目标机安装前

1. 记录 `active-release`，确认它不是即将安装的版本。该值是回滚目标。
2. 把 `runtime.env` 里的 `DSH_WORK_AUTO_DEPLOY_ENABLED` 保持或改为 `false`。不打印该文件。关闭自动升级不会中止已经开始的部署。
3. 按 Runbook 第 6 节下载并验证：`gh release verify`、归档 sha256、`gh release verify-asset`、`gh attestation verify`（signer-workflow、`refs/heads/main`、source digest、拒绝 self-hosted runner）。任一失败即停止。
4. 确认异机备份目录存在。`preflight.sh` 要求 `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY` 是绝对路径、真实目录、不是软链接、部署账号可写，并且 `df` 设备与部署根不同。这个目录由目标机在安装时写入数据库和数据目录的备份，不能用代码仓库代替。
5. 执行该 Release 包里的 `release.sh`。不执行旧 `current` 里的脚本，不重跑上一版的 `release.sh`，不用裸 `docker compose up` 或手工软链接切换。

### 2.5 安装后验收

核对 `active-release` 与 `current` 指向新版本，`previous` 指向旧版本。DSH 锁、profile、`DSH_RUNTIME_COMPATIBILITY` 未设置、迁移版本和 `/health` 与 Release 内锁一致。`/health` 通过不能代替业务验收。

在专用测试 Agent 上完成 P2，不重放生产业务 Agent，不注入真实供应商 401/403：

1. 合法创建返回成功，且只有一条 `agent.create` / `success` 审计。
2. 同一 ID 再创建返回 409 `state_conflict`，行数不增加。
3. 缺少必填字段的草稿 PATCH 返回 422 `invalid_request`，revision 不变，没有成功的 `agent.draft.update` 审计。
4. 条件不满足时 `POST .../release/case-trials` 返回 409，且不创建 trial、Run、Attempt。旧的 `POST .../release/trials` 保持 404。
5. 一次真实 DSH Attempt 完成，记录 Run / Attempt 的哈希、终态和 usage/tool 证据。不记录 prompt 和回答正文。
6. 同一次请求的 Nginx `request_id` 与应用 `requestId` 一致，访问日志 `uri` 不含查询串。`traceId` 仍以 `trace-http-` 开头。
7. 记录观察窗口内的 504 次数和最长 `upstream_connect_time`。`"-"` 表示没连上上游，大约 5 秒表示建连超时。

回填只写状态码、错误码、哈希和行数。验收期间不把自动升级改回 `true`。

### 2.6 何时恢复自动升级

只有 P2 各项符合、真实 Attempt 走完 DSH、请求号能跨层对齐、回填没有密钥、观察窗口没有新增未分类 500，才按 Runbook 第 10 节恢复 `DSH_WORK_AUTO_DEPLOY_ENABLED=true`。恢复前先确认 GitHub 最新稳定 Release 就是刚验收的版本。

504 若仍在约 5 秒内失败，记为宿主机代理问题，不据此单独否定一份否则合格的候选。出现未分类 500、Attempt 绕过 DSH，或来源证明失败时，保持自动升级关闭，用 Runbook 的 `rollback.sh` 回到记录的旧版本。不降级数据库，不执行 `docker compose down -v`。

## 3. v2026.10.19-01 实际落地时的差异

标准路径里的异机备份闸门没有满足。`/Volumes/dsh-work-backups` 不存在，已挂载的部门共享对 `deploy` 不可写，也不是批准的备份目标。安装使用了操作者授权的 S1 偏差包：手工等值备份、临时去掉预检里的异机备份闸门、迁移后受控停止、再由 `complete-install.sh` 切换。Release 字节和来源证明没有改。

2026-10-19 14:24 的决定是保持现状、不重装。因此：

- 目标机正在运行 `v2026.10.19-01`，第 16.2 节 7 项 P2 已通过。
- 这次安装不能写成无偏差正式验收。
- 自动升级保持关闭，后续 Release 不会自动覆盖这台机器。
- 严格无偏差复跑仍要先有专用异机卷，再用该版本包内的官方 `release.sh`。在做出这个安排之前，不打开自动升级。

## 4. 不能做的事

- 不覆盖已发布 Tag、GitHub Release 或 `releases/v2026.10.16-01` 目录。
- 不从 `tonycc/dsh-work` 发布生产版本。该远程的 `main` 仍停在 `e846ac3`，没有 `v2026.10.19-01`。
- 不把数据库备份、`runtime.env` 或模型密钥提交到 Git。
- 不在自动升级打开的情况下发布新的稳定版。watcher 约 300 秒会安装最新稳定 Release。
- 不把本地测试或目标机隔离仿真写成 P2。
