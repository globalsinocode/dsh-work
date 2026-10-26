# Agency 专家包：跨设备安装交接说明

本文面向在**另一台设备**上部署 dsh-work 时协助安装的智能体或运维人员。这些产物是 **dsh-work 管理端 Agent 草稿包**，不是 DSH Harness 的 `@michengai/dsh-agency-agents` 插件。

## 产物路径（仓库内）

| 用途 | 路径 |
| --- | --- |
| 全量包源码（331 个） | [`docs/development/fixtures/agency-agents/<id>/`](fixtures/agency-agents/) |
| 专家索引与上游 commit | [`docs/development/fixtures/agency-agents/SOURCE.json`](fixtures/agency-agents/SOURCE.json) |
| 转换脚本（需网络拉上游） | [`server/scripts/convert-agency-agents.mjs`](../../server/scripts/convert-agency-agents.mjs) |
| 打包为 ZIP | [`server/scripts/package-agency-agent-fixtures.mjs`](../../server/scripts/package-agency-agent-fixtures.mjs) |
| 能力缺口（按分类） | [`agency-agents-pilot-gaps.md`](agency-agents-pilot-gaps.md) |
| 导入用 ZIP（本地生成，不提交 Git） | `dist/agency-agent-packages/<id>.zip` |

每个 `<id>` 形如 `agency-engineering-code-reviewer`，完整列表见 `SOURCE.json` 的 `experts[].id`。

## 不要做的事

- 不要执行 `dsh plugin add @michengai/dsh-agency-agents`：那是桌面 DSH 插件，与 dsh-work 管理端导入无关。
- 不要批量自动发布或自动加入员工广场：导入后状态为**草稿**，发布与可见性仍走既有治理流程。
- 不要修改包内 `version: 0.1.0` 后强行覆盖已导入内容：同 Agent、同版本、不同 ZIP 会返回 **409 version_conflict**。

## 在目标机上生成 ZIP

前提：已克隆本仓库，已安装 Node.js 与 pnpm（与项目开发文档一致）。

```bash
# 仓库根目录
pnpm install

# 可选：从 GitHub 重新生成 331 个包（需网络；缓存见 fixtures/agency-agents/_cache/raw）
pnpm convert:agency-agents

# 将每个专家目录打成 ZIP
pnpm package:agency-agents
```

生成结果：`dist/agency-agent-packages/*.zip`（约 331 个文件，体积较小，可拷贝到 U 盘或内网共享）。

验证（可选）：

```bash
pnpm test:agency-agent-fixtures
```

## 导入到 dsh-work（管理端）

### 方式 A：管理端 UI（推荐）

1. 使用**平台管理员**登录管理端。
2. 打开 Agent 治理 / ZIP 导入入口（组件 [`AgentZipImportPanel.vue`](../../apps/admin-web/src/components/AgentZipImportPanel.vue)）。
3. **每次选择一个** `dist/agency-agent-packages/<id>.zip` 上传。
4. 导入成功后得到该 Agent 的**草稿**；按需配置负责人、试运行与发布。

批量导入 331 个包时，建议由脚本循环调用 API（方式 B），并在日志中记录成功与 409 幂等跳过。

### 方式 B：HTTP API

- **方法**：`POST /api/admin/agent-packages/import`
- **认证**：管理员会话（与现有管理端 API 相同）
- **请求头**：`x-file-name: <文件名>.zip`（需 URL 编码若含非 ASCII）
- **请求体**：ZIP 二进制

幂等行为（与 [`importPackage`](../../server/src/modules/agent/postgres-agent-release-service.ts) 一致）：

- 同一 Agent、同一 `metadata.version`、**相同内容摘要**：重复导入可收敛为幂等，不破坏已有草稿。
- 同一 Agent、同一版本、**不同内容**：409，需提升包内 `version` 后再导入。

导入后的平台默认（ZIP 不含这些字段，由平台初始化）：

- 可见角色：员工
- 数据范围：企业已授权 + 工作空间已授权
- MCP 使用范围：`all`（仅表示 Attempt 可解析租户内可用 Connector，**不**表示包内声明了 MCP）
- 不默认加入团队空间

## 运行时能力边界

包内 `SOUL.md` 已写明：默认仅装配 DSH 工作区工具（`read`、`glob`、`grep`、`write`、`edit`、`read_image`、`str_replace_editor`、`web_search`、`todo_write`）。**未**包含 `bash`、`web_fetch`、`python_execute`、子代理/专家团、小红书或 Figma 等账号操作。

若业务需要上述能力，须在租户侧单独登记 MCP 或扩展平台工具，并更新 Agent 版本与试运行证据；见 [`agency-agents-pilot-gaps.md`](agency-agents-pilot-gaps.md)。

## 升级与再生成

1. 修改 [`server/scripts/convert-agency-agents.mjs`](../../server/scripts/convert-agency-agents.mjs) 中的 `UPSTREAM_COMMIT`（或拉取新 tag）。
2. 运行 `pnpm convert:agency-agents` 与 `pnpm package:agency-agents`。
3. 对已发布 Agent：提升包内 `metadata.version`（如 `0.2.0`）后再导入，避免 409。

## 许可

人格正文源自 The Agency（MIT），见上游 [`NOTICE`](https://github.com/MichengAI/dsh-agency-agents/blob/main/NOTICE)。转换脚本与包结构遵循本仓库开发规范；对外分发 ZIP 时请保留 `SOURCE.json` 中的来源与 commit 信息。
