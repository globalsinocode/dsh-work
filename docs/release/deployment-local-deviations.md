# 部署本地偏差登记

更新时间：2026-10-09

本文件登记**上游源码之外**、仅存在于特定部署环境的运行期偏差。登记的目的只有一个：
让「重新构建发布」这件事**不会静默抹掉这些差异**。每条偏差都必须写明内容、理由、
重放程序、校验方法和退出条件。

## 维护规则

1. 能在源码中解决的问题**不进本表**——直接改源码并提 PR。
2. 只有暂不具备回灌条件、或确实属于站点特有取值的偏差才登记在此。
3. 每条偏差必须有稳定编号；重放脚本必须**锚点失配即失败报错**，禁止静默跳过：
   静默跳过等于差异已经丢失，却没有任何人知道。
4. 本仓库为公开仓库：**站点特有的业务标识（具体连接器名、内网地址、租户取值）
   一律不得写入本文件**，只能写机制，具体取值放部署级配置（如 `runtime.env`）。
5. 偏差一旦回灌源码或失效，必须在本文件标注退出并说明去向，不得留空壳条目。
6. 本表是**仓库侧**登记：只收「需要在新构件上重放」的代码/配置偏差。
   部署侧另有一套更细的运行记录（含 `.orig` 备份、修改前后 sha256、验证脚本与回滚命令），
   位于部署根的 `automation/local-deviations/<日期>-<主题>/`；本表条目必须与之互相引用，
   不得只写其中一处。

---

## DEV-001 工具连接器范围放宽

| 项 | 值 |
| --- | --- |
| 状态 | **已退出（2026-10-09）** —— 按第 8 节第 2 条改为运行时配置，已回灌源码；新构件**无需重放** |
| 首次生效 | 2026-09-29 |
| 退出时间 | 2026-10-09，随构件 `v2026.10.09-01` 安装生效 |
| 载体（历史） | 编译产物 `server/dist/modules/tool/postgres-tool-connector-service.js` |
| 去向 | 源码 `server/src/modules/tool/postgres-tool-connector-service.ts` + `server/src/domain/tool-category.ts`，提交 `ef55c5f`（副分支 `release/2026.10`） |
| 替代机制 | 部署配置 `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS`（逗号分隔；缺省只含 DSH 运行时连接器；站点取值只写在 `runtime.env`，不入库） |
| 性质 | **授权范围放宽**（非缺陷修复） |
| 下游条目 | 下面第 1–8 节保留为历史记录；生效中的机制见第 9 节 |

### 1. 偏差内容

移除若干处 SQL 中 `and t.connector_id = ${DSH_RUNTIME_CONNECTOR_ID}` 的硬限制，
使**已准入**（`admission_status = 'approved'`）的工具不再被强制绑定到 DSH 运行时连接器，
从而可以挂在任意健康连接器上，与 v2026.09.14-01 的解析口径保持一致。

| # | 源码方法 | 查询用途 |
| --- | --- | --- |
| 1 | `assertReferences`（私有） | 草稿/引用校验（原表误记为 `assertDraftReferences`，2026-10-09 更正） |
| 2 | `assertAuthorizationCompatibility` | 授权兼容性校验 |
| 3 | `resolveRuntimeToolNames` | 工具引用 → DSH 工具名映射 |
| 4 | `resolveRuntimeApprovalMode` | 审批策略解析 |
| 5 | `loadBindingSnapshot` | 绑定快照加载与物化（原表误记为 `assertActiveToolBindings`，2026-10-09 更正） |

> 部署侧完整记录（原始备份、修改前后 sha256、验证脚本与回滚命令）：
> `automation/local-deviations/2026-09-29-tool-resolution-hotfix/`
> 该偏差还牵出两个仍在的遗留项（`syncToolCatalog` 按行 id 判定运行时工具存活；
> 缺少 `plm_query` / `mes_query` 的 toolPolicies 条目），详见
> `automation/local-deviations/2026-10-08-plm-tool-resync-repair/deviation.txt`。

### 2. 未放宽的门禁（必须保持原样）

放宽的只是「工具可以挂哪个连接器」，**不是**「工具是否可用」。以下门禁一律不变：

- `admission_status = 'approved'`
- `tv.status = 'published'` 与工具自身的可用状态
- 连接器健康状态与凭据配置校验
- 写工具白名单（`t.mode = 'write'` 时的 `dsh_tool_name` 集合）
- 角色与数据范围（`allowed_role_ids` / `data_scopes`）

### 3. 存在的理由

组织内存在由 **非 DSH 运行时连接器**提供的已准入只读工具。原限制会导致这些工具在解析、
授权兼容性、审批策略、绑定物化四个环节被一致地过滤掉，表现为「工具已准入却用不了」。
本偏差只解除连接器归属限制，其余门禁全部保留。

### 4. 风险

属于**授权范围放宽**：可用工具集合从「DSH 运行时连接器下的工具」扩大到
「任意健康连接器下的已准入工具」。风险面由第 2 节的门禁收敛；但**审批人需要明确知道
这条偏差存在**，否则会误以为工具的可用范围仍被连接器收窄。

### 5. 与上游的关系（升级前必读）

1. 上游 `main` **仍保留全部** `DSH_RUNTIME_CONNECTOR_ID` 限制，本偏差在上游不存在。
2. **升级到上游 `main` 后，偏差面从 5 处扩大到 6 处**：`main` 新增了
   `resolvePlatformDefaultToolReferences()`（`baa2202` 中不存在），其中同样带该限制。
   照搬只处理 5 处的旧重放脚本，会造成新旧路径行为不一致。
3. `main` 在**同一文件**新增了 MCP scope 模型（`mcp_scope` = `none` / `selected` / `all`，
   由 `normalizeAgentMcpScope` 归一化，并在 `resolveMcpConnectionsForAgentVersion` 中过滤）。
   重放前必须先与该模型对齐，避免出现两套互相冲突的连接器过滤逻辑。
4. 上游新增迁移 `0072`–`0076`，只增不降；回滚应用不会回滚数据库。

### 6. 重放程序

> ⚠️ **2026-10-09 起本节不再适用于新构件**：偏差已回灌源码（第 9 节），新构件不自带这 5 处改动，
> 也不需要重放。本节只保留为「若必须回到 2026-09-29 那种构件级热修」时的历史程序，
> 且仅允许用于**已经安装、无法替换**的旧构件。

在新构件上重新应用本偏差时：

1. 打开 `server/dist/modules/tool/postgres-tool-connector-service.js`
   （对应源码为上表方法；升级后需**同时处理第 5 节第 2 点的第 6 处**）。
2. 定位上述方法中的 `connector_id` 条件行，逐处移除。
3. **锚点计数必须等于预期数量**（当前 5 处；升级到 `main` 后为 6 处）。
   计数不符时**报错退出**，不得部分应用、不得静默跳过。
4. 修改前先留存 `.bak-<时间戳>`，修改后按第 7 节校验。
5. 重放**只允许修改 `server/dist/**` 编译产物**，不得改动 `server/src/**` 源码。
6. 重放后重启服务方可生效。

> 参考实现：本机已有同类做法的脚本 `fix-session-skill-not-referenced.py`
> （默认 dry-run、`--apply` 才落盘、先备份再写、锚点失配即失败）。
> 本偏差的重放脚本应遵循同一安全约定。

### 7. 校验方法

- **正向**：挂载在非 DSH 运行时连接器下的**已准入只读工具**，在其连接器被显式列入
  `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS` 时可被正常解析并调用
  （`resolveRuntimeToolNames` / `resolveRuntimeApprovalMode` / `loadBindingSnapshot`
  三个环节均不再因连接器归属而失败）。
- **反向 0**：连接器**未被列入**配置时，上述环节仍然全部拒绝。
- **反向 1**：`admission_status != 'approved'` 的工具**仍然被拒绝**。
- **反向 2**：未发布版本（`tv.status != 'published'`）的工具**仍然被拒绝**。
- **反向 3**：写工具白名单之外的写工具**仍然被拒绝**。
- **反向 4**：连接器不健康（`status != 'healthy'`）时**仍然被拒绝**。
- **一致性**：`assertReferences` 与 `assertAuthorizationCompatibility` 的判定结果
  必须与运行时解析结果一致（不得出现"草稿校验通过但运行时解析失败"）。
- **管理面不变**：`GET /tools*`、目录同步与绑定列表仍固定只认 DSH 运行时连接器；
  `resolvePlatformDefaultToolReferences`（上游 `main` 新增的第 6 处）**不在可配置范围内**。

### 8. 退出条件

满足**任一**条件即应注销本偏差并在本文件标注去向：

1. 该放宽被上游接受并合入 `main`；
2. 改为**运行时配置**表达（例如按连接器白名单的环境变量或配置项），
   使其能够在源码中表达、无需重放；
3. `mcp_scope` 模型覆盖该场景后，本偏差自然作废；
4. 业务上不再需要非 DSH 运行时连接器提供的工具。

> 优先推荐第 2 条：把"允许的连接器范围"做成显式配置，比在编译产物上打补丁
> 更安全、可审计，也与本仓库「仓库为真源」的发布链路相容。

### 9. 退出记录（2026-10-09）

**走的退出条件**：第 8 节第 **2** 条（改为运行时配置）。

**为什么不是另外三条**：

- 第 1 条（上游接受并合入 `main`）不成立：上游 `main` 至今保留全部连接器归属限制；
  引入 `mcp_scope` 的那个提交反而**新增**了第 6 处同款限制（见第 5 节第 2 点）。
- 第 3 条（`mcp_scope` 覆盖该场景）**不成立**，这是 2026-10-09 评估的关键结论：
  `resolveMcpConnectionsForAgentVersion` 只处理 `c.protocol = 'mcp'` 的连接器，
  而本偏差改的是 `tools` / `tool_versions` 的解析路径，普通 REST 工具连接器不在其覆盖范围。
- 第 4 条（业务上不再需要）不成立：站点仍有由非 DSH 运行时连接器提供的已准入只读工具。

**替代实现**（提交 `ef55c5f`，副分支 `release/2026.10`，随 `v2026.10.09-01` 安装）：

1. `server/src/domain/tool-category.ts` 新增 `resolveAllowedToolConnectorIds()`：
   读取 `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS`（逗号分隔），逐个校验标识格式，
   非法取值**构造即失败**（不静默忽略）；返回集合恒含 DSH 运行时连接器并去重。
2. 第 1–5 处解析点由 `= DSH_RUNTIME_CONNECTOR_ID` 改为
   `= any(${allowedToolConnectorIds}::text[])`（沿用全仓库既有的数组参数写法）。
3. **刻意不放宽**的边界：管理面（`GET /tools*`、目录同步、绑定列表、工具增删与状态操作）
   仍固定只认 DSH 运行时连接器；上游新增的第 6 处 `resolvePlatformDefaultToolReferences`
   也不进入可配置范围，避免业务连接器上的同名工具被注入为平台默认能力。
4. 站点取值只写在部署配置 `runtime.env`（本文件遵守第 4 条规则，不记录具体连接器名）。
   不设置时行为回落到偏差之前：只有 DSH 运行时连接器下的工具可解析。

**验证证据**：

- 单元/集成：`pnpm --filter @dsh-work/server test:m4:tool:integration` 3/3
  （默认范围拒绝 5 个解析点；显式放行后逐个通过；连接器离线 / `admission_status='unavailable'` /
  写工具白名单 / 版本不匹配 / 角色不匹配 / 数据范围未覆盖 六类反向仍然拒绝；
  `getTools()` 与 `listToolBindings()` 不受配置影响；白名单解析与非法取值规则单独覆盖）。
- 安装后：`releases/v2026.10.09-01` 用自带 `release.json` 校验 1330/1330 sha256 一致、
  0 修改、0 个 `.bak`（即旧构件上的本偏差补丁已不存在，且无需重放）。
- 部署侧记录：`automation/local-deviations/2026-10-09-retire-list/dev-001-decision.md`
  （注销评估与取舍）、`retire-list.md` P6（退役结果与归档位置）、
  `automation/local-deviations/2026-10-09-install-v2026.10.09-01/`（安装偏差、备份凭据与校验脚本）、
  `automation/state/installed-releases.md`（线上 provenance）。
- 站点功能验收（真实会话中引用该连接器工具）按发布验收流程单独执行，属 T12 第 6 项。

**仍然存在的遗留项**（与本偏差无关，另行登记，不要因本条目退出而忽略）：

- `syncToolCatalog` 仍按行 id 判定运行时工具存活；
- 站点业务工具的 `toolPolicies` 条目缺失问题。

详见部署侧 `automation/local-deviations/2026-10-08-plm-tool-resync-repair/deviation.txt`。

---

## 站点侧流程偏差索引（不进入重放表）

下面几条**不是**"改构件/改配置"的偏差，而是部署与运维过程中的站点特例。它们不需要在重建发布时重放，
但必须与上面的重放表互相引用：部署侧的 `automation/` 目录**不在任何版本控制仓库里**，
只有本文件在仓库中可追溯，因此在这里留索引，避免站点历史只存在于某台机器上。

| # | 日期 | 主题 | 载体 / 位置 | 状态与去向 |
| --- | --- | --- | --- | --- |
| S1 | 2026-09-24 | 跳过异地备份（站点无第二存储目标） | 部署脚本 `release.sh` 两处 hunk | **已退出**：2026-10-09 安装沿用同款两 hunk 偏差（`automation/local-deviations/2026-10-09-install-v2026.10.09-01/`），待有异地目标后恢复原校验 |
| S2 | 2026-10-08 | nginx 上游 IPv6 不可达（容器内 502） | 容器内 `deploy/nginx/default.conf.template` | **已退出**：T5 把 resolver 与 upstream host 源码参数化（`DSH_WORK_NGINX_UPSTREAM_HOST` / `DSH_WORK_NGINX_DNS_RESOLVER`，默认值与补丁逐字等效），新构件无需站点补丁 |
| S3 | 2026-10-09 | 安装 `v2026.10.09-01`：`launchctl bootstrap` 被沙箱拒绝 | 部署脚本 `release.sh` 的 launchd 安装步骤与备份步骤 | **已退出（本次安装）**：两处 hunk + 收尾脚本；证据 `automation/local-deviations/2026-10-09-install-v2026.10.09-01/`（`release.sh.orig`/`release.sh`/`diff`/`install.log`/`complete-install.log`）；线上 provenance 记于 `automation/state/installed-releases.md` |
| S4 | 2026-10-09 | 退役 DSH 侧静态 MCP 挂载 `mcp-skillhive` | `~/.dsh/profiles/acp/cordis.patch.yml`（站点 DSH 配置，不在仓库内） | **已退出**：静态挂载与受控注入同名导致 DSH 启动期 `duplicate loader entry id: mcp-skillhive`，连接器自检长期失败；退役后自检 `healthy`、12 个能力同步生效。证据 `automation/local-deviations/2026-10-09-retire-static-mcp-mount/receipt.txt` |
| S5 | 2026-10-09 | 安装后修站点配置：运行时工具解析白名单漏列一个业务连接器 | 部署侧 `runtime.env` 的 `DSH_WORK_ALLOWED_TOOL_CONNECTOR_IDS` 取值 | **已退出**：已发布 Agent 版本的 `tool_refs` 引用了该连接器上的工具，而 T11 写入的白名单按"连接器当前是否健康"取值、漏了这一项，导致建会话被拒（`authorization.runtime` blocked，文案为"工具不存在、未发布、不可用或不符合受控运行策略"）。追加该连接器并重启服务；取值判据已写进构件 `deploy/runtime.env.example` 与部署手册 §12.1（提交 `65af1e3`、`f080ecd`）。证据 `automation/local-deviations/2026-10-09-allowlist-missing-skillhive/`（`receipt.txt`、`admin-operation-sheet.md`、只读预检脚本） |
| S6 | 2026-10-09 | 新构件新增会话期"发布绑定漂移"门禁，站点历史已发布版本需重新发布 | 管理端 Agent 发布操作（数据面，不改构件/脚本） | **进行中**：站点做过连接器迁移，7 个业务工具的绑定修订已从 rev 1 漂到 rev 2，而当前 active 版本发布时固定的仍是 rev 1；旧构件只在发布时校验，新构件在会话期也校验，因此建会话被拒（改动前该版本可正常运行）。处置＝管理端「创建新版本 → 检查 → 试运行 → 审核通过并发布」，操作单见 `automation/local-deviations/2026-10-09-allowlist-missing-skillhive/admin-operation-sheet.md` |

> 约定：站点专有取值（连接器标识、令牌、主机名）只写在部署侧 `runtime.env` 与部署侧记录里，
> 一律不进入本文件；本文件只写机制、状态与去向。
