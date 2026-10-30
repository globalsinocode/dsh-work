# 平台模型路由生效方案

**状态：** 待评审，尚未实施。本文所述能力在实施并通过第 8 节验收前均不可用。<br>
**更新日期：** 2026-10-26（第 7 节与执行隔离方案对齐，模型网关列为其第 10 节后续方向；明确 4.2 旧 Manifest 兼容与 4.7 不回退的关系；修正 4.5 引用）<br>
**依据：** 当前 Model 模块、Run 编排与 Runtime Adapter 代码；DSH `0.1.2-rc.1`（`76fda72979`）的 `dsh-acp`、`dsh-llm-pi-ai`、`dsh-settings-file`、`dsh-credentials-local` 源码与 README；2026-10-25 本地探针（第 3 节）。<br>
**执行基线：** 每个 Attempt 一个独立 DSH ACP Worker（`--profile acp --patch`），不改变进程模型。

## 1. 背景与目标

[架构总览 4.4](../development/overview.md#44-平台能力层) 记录了现状：Model 模块保存 Provider、模型和路由，但**路由只记录、不生效**。DSH ACP 固定使用 Profile 中的 `deepseek-official/deepseek-v4-pro`，凭据由 DSH 在 `DSH_HOME` 中管理；平台路由只写入 Attempt 快照（`run_attempts.model_route_snapshot`），不决定实际调用的模型。

目标：Attempt 实际调用的模型由平台路由决定，并留下可核对的证据。

- 管理员在管理端配置 Provider、模型和 `default` 路由后，新 Attempt 使用该路由；
- 路由随 Attempt 固定并进入 Manifest 摘要，重试和恢复沿用同一快照；
- 实际调用的 provider/model 从 DSH 会话日志取得，用量按实际模型归属；
- 路由不可用时 Attempt 明确失败，不回退到 Profile 默认模型。

## 2. 边界

- **执行职责不变。** 模型调用仍在 DSH 内由 Agent Loop 发起；平台只决定本 Attempt 的模型配置。不在平台侧直接调用模型，不新增执行循环（[AGENTS.md](../../AGENTS.md)、[总览 3.5](../development/overview.md#35-agent-执行引擎统一)）。
- **第一阶段凭据仍归 DSH。** 平台只保存凭据引用名，密钥值留在 `$DSH_HOME/.credentials.yaml` 或进程环境，平台不读取、不传递密钥。模型网关与短期令牌是第二阶段（第 7 节）。
- **不做 Attempt 内自动切换。** `fallback` 用途的路由不在 Attempt 内部生效；路由失败即 Attempt 失败，是否换路由重新执行由平台的显式重试决定。
- **`model_requirements` 保持拒绝。** Adapter 继续对声明了模型能力要求的运行返回 `MODEL_CAPABILITY_UNAVAILABLE`；目录标注的能力不能证明真实支持，另行设计。
- **不升级 DSH。** 方案基于锁定的 `0.1.2-rc.1`；2026-10-25 核对 `0.2.1-rc.3`，ACP 对外协议未变化，升级不是本方案前提。

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

1. **初始模型由 patch 决定。** `acp` 插件配置的 provider/model 即 Agent 的初始选择；`session/new` 会解析该选择，模型未声明时立即失败。ACP 的 `initialize` 也按该配置判断图片输入支持（`packages/acp/acp/src/index.ts`），因此**不使用** `session/set_config_option` 切换模型：会话建立后再切换，`session/new` 仍依赖 Profile 默认模型可用，图片能力判断也会停留在默认模型上。
2. **`session/new` 不校验凭据。** 凭据在首次模型请求时才解析，缺失时以 `MISSING_CREDENTIAL` 类错误让首轮失败。仅凭 `currentValue` 不能证明路由可用。
3. **共享 `settings.yaml` 会覆盖 patch。** `dsh-settings-file` 的路由段落热加载并覆盖适配器配置；`settings.path` 可配置，每个 Attempt 指向平台独立文件即可隔离。
4. **会话日志能区分“请求的模型”和“实际返回的模型”。** `request/header.data.header.config` 与 `request/context.data` 记录选择，调用失败时也会写入；`assistant/message.data.message.source` 只在模型实际返回时出现，是实际生效路由的证据。
5. **候选目录包含未配置凭据的内置模型。** `configOptions` 仍列出 `deepseek-official` 的内置目录模型；平台不开放会话内切换，不受影响。
6. **未验证：** `reasoning_effort`（假上游未声明推理档位）、真实厂商的流式与工具调用兼容性、Anthropic 协议路由。

## 4. 方案

### 4.1 执行链路

```text
Admin 配置 Provider / 模型 / 路由
        │
Attempt Dispatcher ── resolveRoute('default') ──> ModelRouteSnapshot（不含密钥）
        │  写入 Manifest.model_route（进入 SHA-256）与 run_attempts.model_route_snapshot
        ▼
Runtime Adapter
  1. 启动前检查：凭据引用可解析（只判断存在，不读取值）
  2. 生成每 Attempt patch：settings.path 隔离 + 模型路由 + acp.provider/model（与 MCP patch 合并为一个文件）
  3. spawn DSH ──> initialize ──> session/new
  4. 校验 configOptions.model.currentValue == [provider, model]，不符即失败
  5. 执行；结束时从会话日志 assistant/message.source 取实际 provider/model，写入终态事件与用量
```

### 4.2 Manifest 携带路由快照

Dispatcher 当前只把 `model_route_id` 写入 Manifest（[attempt-dispatcher.ts](../../server/src/modules/run/orchestration/attempt-dispatcher.ts)）。改为写入不含密钥的 `model_route`：

| 字段 | 来源 | 用途 |
| --- | --- | --- |
| `route_id`、`route_key` | `model_routes` | 追溯 |
| `provider_key`、`provider_type` | `model_providers` | 生成 DSH 路由名与适配器选择 |
| `base_url` | `model_providers.base_url` | pi-ai `baseURL` |
| `model_key` | `provider_models.model_key` | 模型 id |
| `credential_ref` | `credential_refs.external_ref` | `apiKeyEnv` 引用名 |

Adapter 只从 Manifest 读取路由，不在执行时回查数据库，保证同一 Attempt 的重试、PF-04 恢复（[持久化等待服务](../../server/src/modules/run/postgres-persistent-wait-service.ts) 已复制快照）与审计看到同一份配置。旧 Manifest 缺少 `model_route` 时，由兼容层按 Profile 默认模型执行：这是对升级前已创建 Attempt 的数据兼容，不属于 4.7 所说的失败回退；升级后新创建的 Attempt 必须携带 `model_route`，缺失视为编排缺陷，Attempt 失败。

### 4.3 Provider 类型映射

`model_providers.provider_type` 当前为自由文本，改为枚举并映射到 DSH 适配器：

| `provider_type` | DSH 适配器 | 生成内容 |
| --- | --- | --- |
| `deepseek-official` | `dsh-llm-deepseek`（Profile 已挂载） | 只设定 `acp.provider: deepseek-official`、`acp.model` |
| `openai-completions` | `dsh-llm-pi-ai` | 声明路由：`api`、`baseURL`、`apiKeyEnv`、`models` |
| `openai-responses`、`anthropic-messages` | `dsh-llm-pi-ai` | 同上；首批不开放，探针覆盖后再加入 |

平台声明的 pi-ai 路由名统一加前缀 `dshw-<provider_key>`，避免与 DSH 内置路由同名（pi-ai 对重复注册的路由名在加载时失败）。`retryPolicy` 由平台显式给出，避免与平台 Attempt 重试叠加放大。

### 4.4 每 Attempt patch

当前 `prepareMcpProcess` 在没有 MCP 连接时直接返回（[dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)），模型配置不能依赖它。将其泛化为统一的 Attempt patch 生成器，一个文件包含：

1. `settings.path` 指向 Attempt 目录内的平台设置文件（不存在或为空），隔离共享 `DSH_HOME/settings.yaml`；
2. 模型路由（4.3）；
3. `acp.provider` / `acp.model`；
4. 既有 MCP 客户端段落与环境变量。

patch 只含引用名，不含密钥；敏感值继续沿用 `!!js process.env.X` 注入方式。基础部署 patch（[acp-managed-credentials.cordis.yml](../../server/config/dsh/acp-managed-credentials.cordis.yml)）中的 `acp.provider/model` 保留为默认值，供启动检查和目录探测使用。

### 4.5 凭据

第一阶段沿用 `dsh-managed` 后端：`credential_refs.external_ref` 填 DSH 凭据名。`dsh-credentials-local` 按“进程环境 → `$DSH_HOME/.credentials.yaml` 的 `refs` → 项目与用户 `.env`”解析 `apiKeyEnv`。

因 `session/new` 不校验凭据（第 3 节事实 2），Adapter 在启动 Worker 前检查引用可解析：进程环境中存在同名变量，或凭据文件 `refs` 中存在该键。只判断存在，不读取、不记录值。检查失败以 `MODEL_ROUTE_UNAVAILABLE` 结束 Attempt；首轮仍出现 `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` 时映射为同一错误码，保留 DSH 原始原因供管理端查看。

### 4.6 校验与证据

- `session/new` 返回后，`configOptions` 中 `model.currentValue` 必须等于 `JSON.stringify([provider, model])`，否则 Attempt 以 `MODEL_ROUTE_UNAVAILABLE` 失败；
- 终态时从 Attempt 会话日志读取 `assistant/message.data.message.source` 的 provider/model，写入终态事件的 `effective_model` 并用于用量归属；与快照不一致时记录告警事件；
- 管理端运行详情展示路由快照与实际模型；不展示凭据引用以外的凭据信息。

### 4.7 失败语义

| 情形 | 结果 |
| --- | --- |
| 无可用 `default` 路由 | 维持现状：Dispatcher 报依赖不可用，不创建 Attempt |
| 凭据引用不可解析 | Attempt 失败，`MODEL_ROUTE_UNAVAILABLE` |
| 模型未在路由中声明 / `currentValue` 不符 | Attempt 失败，`MODEL_ROUTE_UNAVAILABLE` |
| 上游连接、配额、限流 | 沿用现有 Runtime 错误分类；不切换到其他路由 |

任何情形都不回退到 Profile 默认模型（升级前旧 Manifest 的兼容执行见 4.2，不属于回退）。

### 4.8 推理强度（可选，后做）

路由增加可选 `reasoning_effort`。`session/new` 后，若 `configOptions` 中存在 `reasoning_effort` 且包含该值，调用 `session/set_config_option`；不存在时 Attempt 失败而不是静默忽略。需先补充探针验证。

## 5. 改动范围

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| Manifest | `server/src/modules/runtime/runtime-types.ts`、`manifest-compiler.ts`、`runtime-manifest-compatibility.ts`、[runtime-manifest.schema.json](../development/runtime-manifest.schema.json) | 新增 `model_route`，旧版本兼容 |
| 编排 | `server/src/modules/run/orchestration/attempt-dispatcher.ts` | 写入路由快照 |
| Adapter | `server/src/modules/runtime/dsh-acp-runtime-adapter.ts` | 统一 Attempt patch 生成器、凭据引用检查、`currentValue` 校验、实际模型提取 |
| ACP 客户端 | `server/src/modules/runtime/acp-json-rpc-client.ts` | `newSession` 返回 `configOptions`；4.8 时新增 `setConfigOption` |
| DSH 配置 | `server/config/dsh/acp-managed-credentials.cordis.yml` | 默认值保留，注释说明被 Attempt patch 覆盖 |
| Model 模块 | `server/src/modules/model/model-types.ts`、`model-governance-service.ts` | `provider_type` 枚举与校验；迁移现有数据 |
| 管理端 | `apps/admin-web/src/views/ModelGovernanceView.vue` | Provider 类型改为选择；凭据引用说明为 DSH 凭据名；运行详情展示实际模型 |
| 数据 | SQL 迁移 | `provider_type` 约束；默认路由种子为 `deepseek-official/deepseek-v4-pro`，现有部署行为不变 |
| 文档 | [总览](../development/overview.md) 3.5、4.4、第 10 节；[内部端口与契约](../development/internal-ports.md)；[Runtime 指南](../release/dsh-runtime-delivery.md)；`deploy/runtime.env.example` | 删除“路由只记录不生效”，补充配置与凭据说明 |

不改动：启动检查（`dsh-runtime-installation.ts`）与目录探测进程继续使用基础默认模型；`session-summary` 等系统运行经同一 `execute` 路径，自然使用路由。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 共享 `settings.yaml` 覆盖平台路由 | 每 Attempt 隔离 `settings.path`（已实测有效）；DSH Models 页面写入不再影响平台运行，需在 Runtime 指南中说明 |
| 凭据缺失延迟到首轮暴露 | 启动前引用检查 + 首轮错误映射 |
| pi-ai 协议兼容性差异（流式、工具调用、思考格式） | 首批只开放 `deepseek-official` 与 `openai-completions`；每接入一个厂商须 P2 留证 |
| DSH 内置 `workflow` 工具参数允许按阶段覆盖 provider/model | 该工具不在[内置工具注册表](../../server/src/modules/runtime/builtin-tools.ts)，现被策略拒绝；放行前须评审 |
| 双层重试放大请求量 | 路由 `retryPolicy` 由平台显式设置 |
| DSH 升级后插件 id 或配置字段变化 | 纳入 DSH 升级准入检查：路由声明、`settings.path`、日志 `source` 字段 |

## 7. 第二阶段：模型网关（另行立项）

pi-ai 路由的 `baseURL` 指向平台模型网关，`apiKeyEnv` 改为本 Attempt 的短期令牌；网关校验令牌后用平台加密保存的密钥转发，并在网关侧计量。DSH 中不再持有任何模型凭据，`dsh-managed` 后端退役。第一阶段的 Manifest 快照、patch 生成与校验结构不变，只替换路由目标与凭据来源。网关只做认证、转发与计量，不承担任何 Agent 执行逻辑。该阶段列在[执行隔离方案](execution-isolation-plan.md)第 10 节后续方向：执行容器的环境变量由执行器固定，模型可执行的代码本就接触不到 Worker 凭据，网关不是放开可执行能力的前提；它缓解的是 DSH 本身被攻破时的长期凭据暴露。

## 8. 验证

| 层级 | 内容 |
| --- | --- |
| 单元 | patch 生成（有/无 MCP、各 `provider_type`）、凭据引用检查、`currentValue` 不符失败、日志 `source` 提取、旧 Manifest 兼容 |
| P1 集成 | 受控 DSH + 本地 OpenAI 兼容假上游（或 `dsh-llm-mock-server`）：路由生效、模型未声明、缺凭据、共享 `settings.yaml` 存在同名路由四个场景，与第 3 节探针一致 |
| P2 真实验收 | 目标 DSH 版本下，两个真实厂商之间切换 `default` 路由，新 Attempt 的上游请求、会话日志 `source` 与用量统计均指向新模型；按 [PF-07 验收手册](../development/pf07-platform-acceptance.md) 留证 |

Mock 或 P1 通过不能代替 P2，未完成 P2 前总览仍须标注路由生效“未真实验收”。
