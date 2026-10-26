# Agency 专家包：平台能力与缺口（全量 331）

转换来源：[dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) 中文名册，commit 见 [`fixtures/agency-agents/SOURCE.json`](fixtures/agency-agents/SOURCE.json)。人格为 MIT（The Agency）；**未**移植 DSH 插件召唤、专家团与设置页。

以下缺口对**全部**转换后的 Agent 适用，除非你在租户侧另行登记 MCP 或扩展平台工具。按 **分类** 阅读即可，无需逐人重复。

## 平台默认装配（全员）

| 能力 | 工具/机制 | 典型用途 |
| --- | --- | --- |
| 读工作区 | `read`、`glob`、`grep` | 代码、文档、diff |
| 写成果 | `write`、`edit`、`str_replace_editor` | 报告、规格、笔记（成果目录策略由平台约束） |
| 读图片 | `read_image` | 工作区内截图 |
| 联网搜索 | `web_search` | 公开资料、趋势摘要 |
| 任务清单 | `todo_write` | 多步任务跟踪 |
| MCP | 导入默认 `mcpScope: all` | 仅当租户已登记且健康的 Connector 在 Attempt 中解析成功；**包内未声明 MCP** |

**未默认装配、包内也未声明**：`bash`、`web_fetch`、`python_execute`、`activate_skill`、子代理/委派、专家团。

## 按上游分类的常见缺口

| 分类（`SOURCE.json` 的 `division`） | 人格常假设的能力 | 当前 dsh-work 缺口 |
| --- | --- | --- |
| `engineering`、`testing`、`security` | 跑测试、linter、Shell、CI、深度 SAST | 无 `bash`；不能代替执行命令或宣称已跑绿 |
| `engineering`、`product` | 读生产指标、BI、仓库写权限 | 无内置企业数据连接器；只能读获准工作区与用户输入 |
| `design`、`spatial-computing` | Figma/Sketch、设计稿导出 | 仅文本/Markdown 规格，无设计工具 MCP |
| `marketing`、`paid-media`、`sales` | 社交平台发帖、投放后台、CRM | 无平台账号 MCP；`web_search` 不能替代登录后台 |
| `research`、`academic`、`healthcare`、`finance`、`legal` | 全文文献、付费库、合规结论 | 无 `web_fetch`/学术 API；不能代替持证专业人士出具正式意见 |
| `gis`、`game-development`、`engineering`（部分） | 专用 IDE、引擎、GIS 桌面软件 | 无对应 MCP；仅策略与文档级交付 |
| `company`、`hr`、`project-management` | 内部系统写操作、人事/财务系统 | 无 OA/ERP MCP（除非租户自建 Connector） |

上游 frontmatter 若声明 `tools:`（如 `WebFetch`、`WebSearch`），仅记录在 `SOURCE.json` 的 `upstreamToolsDeclared`，**不会**写入 Agent 包或授予额外平台工具。

## 分类与包 ID

- 包 ID：`agency-<源文件名>`，列表见 `SOURCE.json` → `experts[]`。
- `division` 字段对应上游目录（如 `engineering`、`marketing`）。

## 后续可商讨的补充（非本批实现）

1. 平台开放 `web_fetch` 后：研究、综合、营销类可读取公开 URL 全文（仍受 SSRF 策略约束）。
2. 设计 / 社交 / 数据类 **MCP Connector**：按租户登记，Agent 版本配置 `mcpScope: selected`。
3. 受控 **bash** 或 CI 集成：代码审查、技术写作验证需窄范围审批，非开放 Shell。
4. **Agent 委派**：复刻「召唤专家」须走平台委派能力，禁止第二套 Loop。
5. 版本升级：修改上游 commit 后运行 `pnpm convert:agency-agents`，对已发布 Agent 提升包内 `version` 再导入。

安装与批量导入步骤见 [`agency-agents-install-handoff.md`](agency-agents-install-handoff.md)。
