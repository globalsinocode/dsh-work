# 平台模型路由生效方案

**状态：** 已评审（2026-11-06）。MR-S1 已达到代码级（2026-11-06，迁移 `0120_model_routing_governance.sql`，单元与 PostgreSQL 集成测试）；MR-S2 起尚未实施，路由仍只记录、不决定执行模型。本文其余能力在实施并通过第 8 节验收前均不可用。<br>
**更新日期：** 2026-11-06（简化：路由用途只保留 `default`，取消备用路由与备用重试；DeepSeek 统一以 `openai-completions` 接入；模型校验只保留网关一道，取消 `currentValue` 校验与会话日志核对；快照去掉 `data_policy_version`；移除推理强度）；2026-11-06（网关计量增加缓存读写 token；PR 81 评审修订：升级前 Manifest 不再按默认模型执行、按用途解析路由、重试重新解析而恢复沿用快照、复用 `postgres-encrypted` 凭据、错误按网关记录分类；不做 DSH 持有凭据的阶段，路由生效与模型网关同批实施）；2026-10-26（第 7 节与执行隔离方案对齐）<br>
**依据：** 当前 Model 模块、Run 编排与 Runtime Adapter 代码；DSH `0.1.2-rc.1`（`76fda72979`）的 `dsh-acp`、`dsh-llm-pi-ai`、`dsh-settings-file`、`dsh-credentials-local` 源码与 README；2026-10-25 本地探针（第 3 节）；[发往模型的数据防护方案](model-data-protection-plan.md)。<br>
**执行基线：** 每个 Attempt 一个独立 DSH ACP Worker（`--profile acp --patch`），不改变进程模型。

## 1. 背景与目标

[架构总览 4.4](../development/overview.md#44-平台能力层) 记录了现状：Model 模块保存 Provider、模型和路由，但**路由只记录、不生效**。DSH ACP 固定使用 Profile 中的 `deepseek-official/deepseek-v4-pro`，凭据由 DSH 在 `DSH_HOME` 中管理；平台路由只写入 Attempt 快照（`run_attempts.model_route_snapshot`），不决定实际调用的模型。

目标：Attempt 实际调用的模型由平台路由决定，经平台模型网关转发，并留下可核对的证据。

- 管理员在管理端配置 Provider、模型和默认路由后，新 Attempt 使用该路由；
- 路由随 Attempt 固定并进入 Manifest 摘要；PF-04 恢复沿用来源 Attempt 的快照，重试按 4.2 重新解析；
- DSH 只持有网关地址与本 Attempt 的短期令牌，不持有厂商密钥；
- 实际调用的模型与用量以网关记录为准；
- 路由不可用时 Attempt 明确失败，不回退到 Profile 默认模型。

### 1.1 评审决策（2026-11-06）

| 编号 | 决策 |
| --- | --- |
| R1 | **不做 DSH 持有凭据的阶段。** 原方案中由 Adapter 检查 `DSH_HOME` 凭据引用的做法不实施；路由生效（MR-S2）与[数据防护方案](model-data-protection-plan.md) DLP-S1 的模型网关同批交付 |
| R2 | **路由用途只保留 `default`**（同日简化，取代“保留 `default` 与 `fallback`”）。不设备用路由与“换用备用模型重试”；模型故障时管理员更换默认路由，员工普通重试即可生效（重试会重新解析路由，4.2）。按 Agent、项目空间或部门选择路由的规则以后另行设计 |
| R3 | **P2 真实验收**在现有 DeepSeek 官方与另一家外部厂商之间切换默认路由；具体厂商与凭据在 P2 前确定 |
| R4 | **DeepSeek 统一以 `openai-completions` 经 pi-ai 接入**，不使用 DSH 自带的 `dsh-llm-deepseek` 适配器；全部路由只有一条接入路径 |
| R5 | **模型校验只保留网关一道。** 网关是唯一的转发者，按快照逐请求校验模型；不在 `session/new` 后校验 `currentValue`，也不用会话日志核对实际模型 |

## 2. 边界

- **执行职责不变。** 模型调用仍在 DSH 内由 Agent Loop 发起；平台只决定本 Attempt 的模型配置。不在平台侧直接调用模型，不新增执行循环（[AGENTS.md](../../AGENTS.md)、[总览 3.5](../development/overview.md#35-agent-执行引擎统一)）。网关只做认证、转发、计量与数据防护。
- **凭据只在平台。** 厂商密钥由平台加密保存，只在网关转发时解析；DSH、Manifest、patch 中只有网关地址与 Attempt 令牌的环境变量名（R1）。
- **不做自动切换。** 路由失败即 Attempt 失败，不在 Attempt 内或自动重试中换用其他路由（R2）。
- **`model_requirements` 保持拒绝。** Adapter 继续对声明了模型能力要求的运行返回 `MODEL_CAPABILITY_UNAVAILABLE`；目录标注的能力不能证明真实支持，另行设计。
- **不升级 DSH。** 方案基于锁定的 `0.1.2-rc.1`；2026-10-25 核对 `0.2.1-rc.3`，ACP 对外协议未变化，升级不是本方案前提。
- **不做推理强度配置。** 需要按路由设定推理档位时另行立项。

## 3. 探针结论（2026-10-25）

在本地 DSH `0.1.2-rc.1` 源码检出上，以 `--profile acp --patch <探针 patch>` 启动，独立临时 `DSH_HOME`，上游为记录请求的 OpenAI 兼容假服务。patch 声明 `llm-pi-ai` 路由 `dshw-probe`（`api: openai-completions`、`apiKeyEnv: DSHW_PROBE_KEY`、模型 `probe-chat`），设定 `acp.provider/model`，并把 `settings.path` 指向独立文件。探针脚本保存在会话 scratchpad，未进入仓库。

| 用例 | `session/new` | 首轮调用 | 上游实际收到 |
| --- | --- | --- | --- |
| 正常 | 成功，`configOptions` 中 `model.currentValue = ["dshw-probe","probe-chat"]` | 成功 | `model: probe-chat`，携带 Bearer 凭据 |
| 模型未声明 | 失败：`pi-ai provider "dshw-probe" has no configured model "not-declared"` | — | 无请求 |
| 缺凭据（环境与凭据文件均无） | **成功** | 失败：`no credential for provider route "dshw-probe"` | 无请求 |
| `settings.path` 指向含同名路由的 `settings.yaml` | 成功 | 失败：连接错误，请求被改写到 settings 中的地址 | 无请求 |
| 同上，但 `settings.path` 指向平台独立文件 | 成功 | 成功 | patch 声明的路由生效 |

据此得出的事实：

1. **初始模型由 patch 决定。** `acp` 插件配置的 provider/model 即 Agent 的初始选择；`session/new` 会解析该选择，模型未声明时立即失败。ACP 的 `initialize` 也按该配置判断图片输入支持（`packages/acp/acp/src/index.ts`），因此**不使用** `session/set_config_option` 切换模型。
2. **`session/new` 不校验凭据。** 凭据在首次模型请求时才解析。网关上线后 DSH 只持有令牌，令牌与模型的校验在网关的首个请求上完成（4.6）。
3. **共享 `settings.yaml` 会覆盖 patch。** `dsh-settings-file` 的路由段落热加载并覆盖适配器配置；`settings.path` 可配置，每个 Attempt 指向平台独立文件即可隔离。
4. **会话日志记录请求的模型与实际返回的来源。** 本方案以网关记录为准（R5），会话日志只作排障参考。
5. **候选目录包含未配置凭据的内置模型。** `configOptions` 仍列出 `deepseek-official` 的内置目录模型；平台不开放会话内切换，不受影响。
6. **未验证：** 真实厂商的流式与工具调用兼容性、Anthropic 协议路由；pi-ai 以 `openai-completions` 接 DeepSeek 时推理内容（`reasoning_content`）与工具调用的兼容性（由数据防护方案 DLP-S0 验证，见 4.3）。

## 4. 方案

### 4.1 执行链路

```text
Admin 配置 Provider / 模型 / 默认路由（含 trust_level）
        │
Attempt Dispatcher ── 解析启用的 default 路由 ──> ModelRouteSnapshot（不含密钥）
        │  写入 Manifest.model_route（进入 SHA-256）与 run_attempts.model_route_snapshot
        ▼
Runtime Adapter
  1. 签发 Attempt 短期令牌（绑定租户、Run、Attempt、路由与模型）
  2. 生成每 Attempt patch：settings.path 隔离 + pi-ai 路由（baseURL=网关，apiKeyEnv=令牌变量）+ acp.provider/model
     （与 MCP patch 合并为一个文件）
  3. spawn DSH ──> initialize ──> session/new ──> 执行
  4. DSH ──> 模型网关（校验令牌与模型、数据防护、用平台密钥转发、计量）──> 厂商
  5. 终态：实际模型与用量取网关记录
```

### 4.2 Manifest 携带路由快照

Dispatcher 当前只把 `model_route_id` 写入 Manifest（[attempt-dispatcher.ts](../../server/src/modules/run/orchestration/attempt-dispatcher.ts)）。改为写入不含密钥的 `model_route`，字段按使用方分开：

| 字段 | 来源 | 使用方 | 用途 |
| --- | --- | --- | --- |
| `route_id`、`route_key` | `model_routes` | 审计 | 追溯 |
| `provider_key`、`provider_type` | `model_providers` | Adapter | 生成 DSH 路由名 `dshw-<provider_key>` |
| `model_key` | `provider_models.model_key` | Adapter、网关 | 模型 id；网关校验请求模型与之一致 |
| `base_url` | `model_providers.base_url` | 网关 | 转发的厂商地址；**不写入 DSH patch** |
| `credential_ref_id` | `credential_refs.id` | 网关 | 解析平台加密保存的厂商密钥；不含密钥值 |
| `trust_level` | `model_providers` | 网关 | 数据防护策略（[数据防护方案 5.5](model-data-protection-plan.md#55-provider-信任级别与策略)） |

DSH patch 中的 `baseURL` 固定为网关地址，`apiKeyEnv` 为令牌环境变量名，两者不来自快照。Adapter 与网关只从 Manifest 读取路由，不在执行时回查数据库。

**解析时机：**

- **新建 Run 与重试**：每次创建 Attempt 都由 Dispatcher 重新解析当前启用的默认路由（与现有代码一致：重试经 Dispatcher 重新调用 `resolveRoute`）。管理员修复凭据或更换默认路由后，重试即可生效。
- **PF-04 恢复**：沿用来源 Attempt 的快照（[持久化等待服务](../../server/src/modules/run/postgres-persistent-wait-service.ts) 已复制 `model_route_snapshot`），保证审批前后同一模型。

**兼容：** `model_route` 作为 Manifest `1.0` 的可选字段新增，旧记录在现有兼容层（[runtime-manifest-compatibility.ts](../../server/src/modules/runtime/runtime-manifest-compatibility.ts)，目前只处理预算字段）中识别。MR-S2 上线后 `DSH_HOME` 不再保存厂商凭据，且任何路由不得绕过网关，因此**缺少 `model_route` 的升级前 Attempt 不能再按 Profile 默认模型执行**：这类 Attempt 若在升级后才开始执行或恢复，以 `MODEL_ROUTE_UNAVAILABLE` 失败，重试即新建携带路由的 Attempt。上线前按 Runtime 指南排空执行中的 Attempt。升级后新创建的 Attempt 必须携带 `model_route`，缺失视为编排缺陷，Attempt 失败。

### 4.3 Provider 类型映射（R4）

`model_providers.provider_type` 当前为自由文本，改为枚举，全部经 `dsh-llm-pi-ai` 接入：

| `provider_type` | 首批 | 生成内容 |
| --- | --- | --- |
| `openai-completions` | 开放 | 声明 pi-ai 路由：`api`、`baseURL`（网关）、`apiKeyEnv`（令牌变量）、`models`、`retryPolicy` |
| `openai-responses`、`anthropic-messages` | 不开放 | 同上；探针覆盖后再加入 |

- **DeepSeek 官方**配置为 `openai-completions`，`base_url` 为 DeepSeek 官方的 OpenAI 兼容地址。现有种子数据中 `provider_type = 'deepseek-official'` 的 Provider 迁移为 `openai-completions`。不再使用 DSH 自带的 `dsh-llm-deepseek` 适配器；DLP-S0 验证 pi-ai 对 DeepSeek 推理内容与工具调用的兼容性，不兼容时先修 DSH 的 pi-ai 适配链路（AGENTS.md：完善现有适配链路，不另建执行引擎）。
- 平台声明的 pi-ai 路由名统一加前缀 `dshw-<provider_key>`，避免与 DSH 内置路由同名（pi-ai 对重复注册的路由名在加载时失败）。
- `retryPolicy` 由平台显式给出：只重试连接错误、408、429 与 5xx，**不重试其他 4xx**（含网关的令牌拒绝与数据防护拒绝），避免与平台 Attempt 重试叠加放大。

### 4.4 每 Attempt patch

当前 `prepareMcpProcess` 在没有 MCP 连接时直接返回，且要求启动参数含 `--profile`（[dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)）；正式执行与 MCP 连接检查都调用它。将其泛化为统一的 patch 生成器，保留 `--profile` 前提，并区分两种模式：**带路由**（正式执行，Manifest 携带 `model_route`）与**无路由**（MCP 连接检查，只生成 MCP 段落，沿用基础默认模型）。带路由模式的一个文件包含：

1. `settings.path` 指向 Attempt 目录内的平台设置文件（不存在或为空），隔离共享 `DSH_HOME/settings.yaml`；
2. pi-ai 模型路由（4.3）；
3. `acp.provider: dshw-<provider_key>` / `acp.model: <model_key>`；
4. 既有 MCP 客户端段落与环境变量。

patch 只含环境变量名，不含令牌或密钥值；敏感值继续沿用 `!!js process.env.X` 注入方式。

Adapter 目前有三条启动 DSH 的路径，只有正式执行使用路由：

| 路径 | 位置 | 是否发出模型请求 | 处理 |
| --- | --- | --- | --- |
| 工具目录探测 | `listTools` | 否，只到 `session/new` | 继续使用基础部署 patch 的默认模型 |
| MCP 连接检查 | `inspectMcpConnection` | 否，只到 `session/new` | 同上；调用生成器的无路由模式 |
| 正式执行 | `execute` | 是 | 使用 Attempt patch；`session-summary` 等系统运行经同一路径，自然使用路由 |

基础部署 patch（[acp-managed-credentials.cordis.yml](../../server/config/dsh/acp-managed-credentials.cordis.yml)）中的 `acp.provider/model` 保留为上述两条探测路径的默认值。网关上线后 `DSH_HOME` 不再保存厂商凭据；探测路径不发出模型请求，不受影响（第 3 节事实 2）。

### 4.5 凭据与令牌（R1）

- 厂商密钥复用现有的平台加密凭据：`credential_refs.backend = 'postgres-encrypted'`，密文保存在 `credential_secrets`（迁移 `0054_encrypted_connector_credentials.sql`），读写经 `PostgresEncryptedCredentialStore`，与 MCP、WeKnora、钉钉连接器的凭据同一机制。明文只在网关转发时解析（[数据防护方案 5.2](model-data-protection-plan.md#52-模型网关最小范围)）。Model Provider 的新配置只接受 `postgres-encrypted`，存量 `dsh-managed` 记录由管理员重新录入密钥。
- **管理端录入密钥已在 MR-S1 提前提供**（2026-11-06）：新建 Provider 时可一并填写 API Key，或在“密钥”中录入、替换；以 `postgres-encrypted` 保存，只显示末尾 4 位，切换回 DSH 受管引用时删除密文。MR-S2 之前执行仍使用 `DSH_HOME` 中的凭据，录入的密钥在网关上线后生效。
- Adapter 为每个 Attempt 签发短期令牌，通过环境变量交给 DSH；Attempt 终态即失效。
- **两道检查：**
  - **创建 Attempt 前**：保留现有 `resolveRoute` 的检查（[postgres-model-governance-repository.ts](../../server/src/modules/model/postgres-model-governance-repository.ts)）：Provider 或模型停用、凭据引用缺失或状态不是 `configured` 时直接报依赖不可用，不创建 Attempt（4.7 第一行）。
  - **转发时**：网关解密失败、凭据已被吊销，或厂商返回 401/403，以 `MODEL_CREDENTIAL_INVALID` 结束 Attempt。

### 4.6 校验与证据（R5）

- **模型校验：** 网关校验每个请求的令牌与模型：令牌须属于本 Attempt，请求模型须等于快照 `model_key`，否则拒绝，Attempt 以 `MODEL_ROUTE_UNAVAILABLE` 结束。patch 配置错误（如模型未声明）在 `session/new` 时已由 DSH 报错；其余配置错误在首个模型请求时由网关发现，不另做 `currentValue` 校验。
- **网关计量字段：** 每个请求一条记录，包括输入、输出、**缓存读取**、**缓存写入** token，以及尝试次数。缓存字段从厂商响应的用量中读取：OpenAI 兼容协议取 `prompt_tokens_details.cached_tokens`，DeepSeek 取 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，Anthropic 取 `cache_read_input_tokens` / `cache_creation_input_tokens`。厂商没有返回时记为 `null`，不记为 0，以免把“未知”统计成“未命中”。输入 token 是否已包含缓存部分按各厂商口径换算，统一为“输入总量 + 其中缓存读取量”。缓存数据用于观察提示词缓存命中率，包括数据防护遮盖带来的变化（[数据防护方案第 8 节](model-data-protection-plan.md#8-风险)）；第一期只记录与展示，不参与计费。
- **实际模型与用量：** 终态时以网关记录的模型与 token 用量写入终态事件的 `effective_model` 并用于用量归属。
- 管理端运行详情展示路由快照与实际模型；不展示凭据。

### 4.7 失败语义

| 情形 | 结果 |
| --- | --- |
| 无可用默认路由 | 维持现状：Dispatcher 报依赖不可用，不创建 Attempt |
| 模型未在路由中声明 / 令牌或请求模型与路由不符 | Attempt 失败，`MODEL_ROUTE_UNAVAILABLE` |
| 厂商密钥缺失、无效或被吊销（网关检查或厂商 401/403） | Attempt 失败，`MODEL_CREDENTIAL_INVALID` |
| 配额或余额耗尽（厂商明确返回额度类错误） | Attempt 失败，`MODEL_QUOTA_EXHAUSTED` |
| 限流（429，`retryPolicy` 重试后仍失败） | Attempt 失败，`MODEL_RATE_LIMITED` |
| 上游连接失败、超时、5xx | Attempt 失败，`MODEL_UPSTREAM_UNAVAILABLE` |
| 数据防护拒绝 | 见[数据防护方案 5.6](model-data-protection-plan.md#56-拦截与失败语义) |

当前 [classifyRuntimeFailure](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) 把模型错误统一归为 `MODEL_INVOCATION_FAILED`。

**错误的来源与传递：**

- **记录：** 网关为每个请求记录结果：来源（网关自身拒绝或厂商返回）、HTTP 状态、厂商错误码、是否经过重试，按 Attempt 关联。
- **区分来源：** 网关自身的拒绝在响应体 `code` 中给出平台错误码（如 `MODEL_ROUTE_UNAVAILABLE`、数据防护方案 5.6.2 的错误码），并带响应头 `x-dshw-origin: gateway`；厂商的错误原样透传给 DSH。两者都是 403 时，以网关记录的来源区分，不靠状态码猜测。
- **分类：** Attempt 失败时，Adapter 以网关对该 Attempt 最后一个失败请求的记录为准做分类，不解析 DSH 的错误文本。记录缺失（如网关不可用）时按 Runtime 不可用处理；无法归入四类的厂商错误保留 `MODEL_INVOCATION_FAILED`。
- **四类不得合并：** 员工端提示与管理员排障据此区分：限流与上游故障可以稍后重试，凭据与额度问题需要管理员处理（修复凭据或更换默认路由后重试）。

任何情形都不回退到 Profile 默认模型（升级前旧 Manifest 的处理见 4.2）。

### 4.8 路由用途（R2）

- `model_routes.purpose` 只允许 `default`。现有 `chat`、`analysis`、`fallback` 路由迁移为 `purpose = 'default'` 且停用（现有唯一索引只约束启用的默认路由，不冲突），由管理员确认后删除。
- **解析方式改为按用途：** 现有代码按路由 `key` 解析（Dispatcher 传入 `'default'`，仓储按 `r.key` 查询），而“每租户一条启用的默认路由”的唯一索引按 `purpose` 建立，两者不一致：管理员新建一条 `key` 不是 `default` 的默认路由时，执行时会找不到。改为取 `purpose = 'default'` 且启用的那一条；`key` 只用于展示与审计。
- 每个租户最多一条启用的默认路由（沿用现有唯一索引）。更换默认路由即停用旧路由、启用新路由。
- `resolveRoute` 的能力校验（`ModelCapabilityMismatchError`）保留。

### 4.9 治理补强

- Provider 类型改为枚举选择；Provider 增加 `trust_level`（`internal` / `external`，[数据防护方案 5.5](model-data-protection-plan.md#55-provider-信任级别与策略)），新建时必选，存量迁移为 `external`。
- 路由可编辑名称、目标模型与启停；模型可单独启停（需新增接口与管理端操作）。Provider 与模型停用时，引用它们的路由在解析时视为不可用：这一检查现有 `resolveRoute` 已实现，保留。
- 修改或停用路由只影响之后新建的 Attempt；进行中的 Attempt 使用已固定的快照运行至终态。
- 管理端去掉“仅记录”提示，改为说明路由经网关生效；凭据配置改为录入厂商密钥（只写不读，保存后不回显）。

## 5. 改动范围

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| Manifest | `server/src/modules/runtime/runtime-types.ts`、`manifest-compiler.ts`、`runtime-manifest-compatibility.ts`、[runtime-manifest.schema.json](../development/runtime-manifest.schema.json) | 新增可选 `model_route`，旧版本兼容 |
| 编排 | `server/src/modules/run/orchestration/attempt-dispatcher.ts` | 按用途解析默认路由并写入快照 |
| Adapter | `server/src/modules/runtime/dsh-acp-runtime-adapter.ts` | 统一 patch 生成器、令牌签发与注入、按网关记录细分模型错误 |
| 模型网关 | 新模块（[数据防护方案 5.2](model-data-protection-plan.md#52-模型网关最小范围)） | 令牌与模型校验、转发、计量（含缓存读写 token）、上游错误记录 |
| DSH 配置 | `server/config/dsh/acp-managed-credentials.cordis.yml` | 默认值保留给探测路径，注释说明被 Attempt patch 覆盖 |
| Model 模块 | `server/src/modules/model/model-types.ts`、`model-governance-service.ts`、仓储 | `provider_type` 枚举、`trust_level`、用途收敛与按用途解析、路由编辑与模型启停、平台加密凭据 |
| 管理端 | `apps/admin-web/src/views/ModelGovernanceView.vue` | 类型与信任级别选择、路由编辑、模型启停、密钥录入；运行详情展示实际模型 |
| 数据 | SQL 迁移 | `provider_type`、`trust_level`、`purpose` 约束；`deepseek-official` 迁移为 `openai-completions`；非默认用途路由迁移为停用；默认路由种子为 DeepSeek 官方 `deepseek-v4-pro` |
| 文档 | [总览](../development/overview.md) 3.5、4.4、第 10 节；[内部端口与契约](../development/internal-ports.md)；[Runtime 指南](../release/dsh-runtime-delivery.md)；`deploy/runtime.env.example` | 删除“路由只记录不生效”，补充网关与凭据说明 |

不改动：启动检查（`dsh-runtime-installation.ts`）与两条探测路径继续使用基础默认模型；ACP 客户端（`acp-json-rpc-client.ts`）无需改动。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 共享 `settings.yaml` 覆盖平台路由 | 每 Attempt 隔离 `settings.path`（已实测有效）；DSH Models 页面写入不再影响平台运行，需在 Runtime 指南中说明 |
| pi-ai 接 DeepSeek 时推理内容或工具调用不兼容（R4） | DLP-S0 先验证；不兼容时完善 DSH 的 pi-ai 适配链路，不另建执行引擎 |
| 路由生效要等网关建好（R1 的代价） | MR-S1 可先行；MR-S2 与 DLP-S1 同批交付，分期见第 9 节 |
| 没有备用路由，默认模型故障时需管理员介入（R2 的代价） | 四类错误码让员工端提示与管理员排障清楚区分；管理员更换默认路由后员工重试即生效 |
| 配置错误在首个模型请求时才暴露（R5 的代价） | 由网关以 `MODEL_ROUTE_UNAVAILABLE` 明确失败，延迟仅为一次请求 |
| pi-ai 协议兼容性差异（流式、工具调用、思考格式） | 首批只开放 `openai-completions`；每接入一个厂商须 P2 留证 |
| DSH 内置 `workflow` 工具参数允许按阶段覆盖 provider/model | 该工具不在[内置工具注册表](../../server/src/modules/runtime/builtin-tools.ts)，现被策略拒绝；放行前须评审；网关按快照校验模型，越权请求会被拒绝 |
| 双层重试放大请求量 | 路由 `retryPolicy` 由平台显式设置，不重试其他 4xx |
| 厂商错误文本各异，细分不准 | 以网关记录的状态码与错误码为准；无法归类时保留 `MODEL_INVOCATION_FAILED`；P2 补充真实厂商样本 |
| DSH 升级后插件 id 或配置字段变化 | 纳入 DSH 升级准入检查：pi-ai 路由声明、`settings.path`、网关地址与令牌变量 |

## 7. 模型网关（与路由生效同批实施）

pi-ai 路由的 `baseURL` 指向平台模型网关，`apiKeyEnv` 为本 Attempt 的短期令牌；网关校验令牌后用平台加密保存的密钥转发，并在网关侧计量。DSH 中不持有任何模型凭据。网关只做认证、转发、计量与数据防护，不承担任何 Agent 执行逻辑；详细设计、令牌、拒绝传递与数据防护见[发往模型的数据防护方案](model-data-protection-plan.md)第 5 节。

原方案把网关列为第二阶段，并与[执行隔离方案](execution-isolation-plan.md)第 10 节的后续方向对齐。按 R1 与数据防护方案 D1，网关提前与路由生效同批实施。执行隔离方案的判断仍然成立：执行容器的环境变量由执行器固定，网关不是放开可执行能力的前提；它缓解的是 DSH 本身被攻破时的长期凭据暴露，并为数据防护提供唯一的请求通道。

## 8. 验证

| 层级 | 内容 |
| --- | --- |
| 单元 | patch 生成（带路由与无路由模式、有/无 MCP、缺 `--profile` 拒绝）、令牌注入不含值、网关令牌与模型校验、按网关记录的错误分类（含网关 403 与厂商 403 区分）、按用途解析默认路由、旧 Manifest 在升级后失败、用途与信任级别校验、各协议缓存 token 字段解析与缺失时记为 `null` |
| P1 集成（MR-S2） | 受控 DSH + 网关 + 本地 OpenAI 兼容假上游（或 `dsh-llm-mock-server`）：路由生效、`key` 不为 `default` 的默认路由可被解析、模型未声明、共享 `settings.yaml` 存在同名路由、令牌越权与请求模型不符被拒、厂商 401 以 `MODEL_CREDENTIAL_INVALID` 结束、429 经 `retryPolicy` 重试仍失败后以 `MODEL_RATE_LIMITED` 结束、额度类错误以 `MODEL_QUOTA_EXHAUSTED` 结束且不被重试、5xx 与连接失败以 `MODEL_UPSTREAM_UNAVAILABLE` 结束、除 408/429/5xx 外的 4xx 不被重试、探测路径不发出模型请求、停用路由不影响进行中 Attempt、更换默认路由后重试使用新路由而 PF-04 恢复沿用快照 |
| P1 集成（MR-S3） | `effective_model` 与用量归属、假上游返回缓存用量时计量记录与运行详情一致 |
| P2 真实验收 | 目标 DSH 版本下，在 DeepSeek 官方与另一家外部厂商（R3，P2 前确定）之间切换默认路由：新 Attempt 的上游请求、网关记录与用量统计均指向新模型，两家厂商的缓存读写 token 被正确记录（或明确为未返回）；按 [PF-07 验收手册](../development/pf07-platform-acceptance.md) 留证 |

Mock 或 P1 通过不能代替 P2，未完成 P2 前总览仍须标注路由生效“未真实验收”。

## 9. 分期

| 阶段 | 内容 | 依赖 | 完成标志 |
| --- | --- | --- | --- |
| MR-S1 治理数据补强（代码级已完成） | `provider_type` 枚举与历史取值迁移、`trust_level`、用途收敛与按用途解析、路由编辑与模型启停、管理端录入厂商密钥（加密保存，MR-S2 起生效）；不改变执行行为 | 无，可先行 | 管理端与接口用例通过；执行仍按 Profile 默认模型 |
| DLP-S0 探针 | 见数据防护方案第 7 节；本方案关心 pi-ai 接 DeepSeek 的推理内容与工具调用兼容性、4xx 与 429 重试行为 | 无 | R4 可行性定论 |
| MR-S2 + DLP-S1 路由生效与网关 | Manifest `model_route`、统一 patch 生成器、令牌、网关校验转发与计量、平台加密凭据、模型错误细分 | MR-S1、DLP-S0 | 所有正式执行经网关，路由决定实际模型；第 8 节 P1（MR-S2）通过 |
| MR-S3 证据与展示 | `effective_model` 与用量归属、运行详情、文档更新 | MR-S2 | 第 8 节 P1（MR-S3）与管理端用例通过 |
| MR-P2 真实验收 | 第 8 节 P2 | MR-S3 | 留证完成，总览去掉“未真实验收” |

数据防护的识别与还原（DLP-S2）在网关链路上叠加，不阻塞 MR-S2/S3。
