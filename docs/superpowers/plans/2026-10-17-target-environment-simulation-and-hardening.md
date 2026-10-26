# 目标环境模拟与故障收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不复制目标机真实凭据、业务数据或 `DSH_HOME` 的前提下，建立可重复的目标环境模拟，修复 Agent 创建/草稿保存的未分类 500，固化模型供应商 401/403 与 MCP 审计告警的因果回归，并提升 Nginx 504 的关联与失败时延证据。

**Architecture:** 继续使用唯一的 `Run/Attempt → Runtime Adapter → DSH` 执行链路；平台只补充 HTTP 输入边界、PostgreSQL 错误映射、合成故障夹具和代理层可观测性。P0、P1、P2 分层留证：本地使用一次性 PostgreSQL、合成 ACP Worker 和候选 Nginx 容器，目标机只在候选发布环境做真实 DSH 验收，不把本地绿灯当成真实环境通过。

**Tech Stack:** TypeScript 5.9、Node.js test runner、PostgreSQL 17、Playwright、DeepSeek Harness ACP、Nginx 1.30、Docker Compose、pnpm。

---

## 1. 已确认事实与实施决策

本计划依据 `docs/development/target-environment-diagnostic-questionnaire.md` 第 14、15 节编制。执行人员不得重新猜测已经有证据的结论：

- 开发基线使用 `target/main` 的 `667b00ea12db2db599f0966c7866c32238583018`；目标机不可变 Release `v2026.10.16-01` 对应 `af0faca9a86ab8fdecb937286c69199572232e3a`。两者差异已知且不涉及本轮后端错误分类。
- `POST /api/admin/v1/agents` 的 500 是客户端 ID 命中 PostgreSQL `23505 / agents_pkey` 后未映射为类型化冲突；没有证据支持浏览器连续双提交。
- `PATCH /api/admin/v1/agents/draft` 的 500 是未校验 JSON 结构即调用 `.trim()`；目标 Agent、缺失字段和调用方无法从现有日志恢复。
- 旧版 `POST .../release/trials` 的业务前置条件被当成 500；当前基线已经改为 `POST .../release/case-trials`，并通过 `stateConflict` 表达 409。本轮只加回归，不恢复旧入口，也不再写第二个修复实现。
- 223 次失败 Attempt 的主因是 201 次供应商 401、2 次额度 403 及少量 malformed prompt；`mcp invocation audit failed` 是没有 usage/tool 证据后的下游告警，不是独立 MCP 故障。
- 6 次 504 是 Nginx 容器连接 `host.docker.internal:4190` 超时。缩短 `proxy_connect_timeout` 只能减少等待，不能解决 Docker Desktop 宿主代理偶发不可达；拓扑迁移不纳入本轮。
- 目标 DSH 是 `0.1.2-rc.1 @ 76fda729799fe9b3848dbe2c211d4b231032b81e`，正式 `acp-app` profile，且 `DSH_RUNTIME_COMPATIBILITY` 未设置。旧本地 `0.1.1-rc.2` compatibility 路线不能作为等价模拟。

### 安全边界

- 不复制目标机的模型密钥、Cookie、Token、Authorization、数据库内容、`~/.dsh` 或 `DSH_HOME`。
- 401/403 使用合成 ACP Worker 或本地假供应商响应；不得为复现向真实供应商发送错误密钥或消耗真实额度。
- P1 数据库必须是一次性、可丢弃 PostgreSQL；不得连接开发业务库或生产库。
- P2 只部署候选 Release 并按既有 Run/Attempt、Runtime Adapter、DSH 链路验证；不得在生产数据上重放历史失败请求。
- 不新增模型直连、备用 Agent Loop、生产 Mock 降级或绕开 DSH 的测试接口。

## 2. 预期文件变更

| 操作 | 文件 | 作用 |
| --- | --- | --- |
| 新增 | `server/src/modules/agent/agent-draft-input.ts` | 将未知 JSON 转成类型化 Agent 草稿输入，错误统一为 422 |
| 新增 | `server/src/modules/agent/agent-draft-input.test.ts` | 覆盖缺字段、错类型、数组元素和数值边界 |
| 修改 | `server/src/http/admin/agent-routes.ts` | POST/PATCH 在进入服务层前解析未知输入 |
| 修改 | `server/src/modules/agent/postgres-agent-service.ts` | 仅把 `23505 + agents_pkey` 映射成 409 |
| 新增 | `server/src/infrastructure/postgres/agent-draft-api.integration.test.ts` | 用真实 PostgreSQL 验证 201/409/422 及事务不落脏数据 |
| 修改 | `docs/development/openapi-admin.json` | 为创建补 409，为草稿更新补 409/422 |
| 修改 | `server/src/infrastructure/postgres/agent-release-governance.integration.test.ts` | 固化当前 `case-trials` 的业务阻塞 409 |
| 修改 | `server/src/modules/runtime/testing/mock-acp-worker.ts` | 增加合成供应商 401/403 失败模式 |
| 修改 | `server/src/modules/runtime/runtime-adapter.test.ts` | 固化供应商拒绝 → Attempt 失败 → 无证据告警的因果链 |
| 新增 | `config/target-environment/2026-10-17.json` | 无密钥的目标环境机器可读快照 |
| 新增 | `scripts/testing/target-environment-preflight.mjs` | 比对本地模拟与目标快照，并输出脱敏结果 |
| 新增 | `scripts/testing/target-environment-preflight.test.mjs` | 验证版本、compatibility、秘密输出与失败分类 |
| 修改 | `package.json` | 将新脚本测试加入 `test:scripts`，增加显式 preflight 命令 |
| 新增 | `docs/development/target-environment-simulation.md` | 本地搭建、故障注入、证据矩阵和清理说明 |
| 修改 | `server/src/http/http-error-log.ts` | 增加 ISO 时间戳和安全 requestId |
| 修改 | `server/src/http/router.ts` | 接收/生成请求关联 ID，并在错误日志和响应中一致使用 |
| 修改 | `server/src/http/review-p2-error-logging.test.ts` | 验证关联字段、脱敏和日志失败不影响响应 |
| 新增 | `scripts/testing/nginx-proxy-config.test.mjs` | 静态验证代理关联字段及 5 秒建连上限 |
| 修改 | `deploy/nginx/default.conf.template` | JSON access log 包含 requestId 与 upstream 时延 |
| 修改 | `deploy/nginx/proxy_params` | 覆盖转发 `X-Request-Id`，设置 `proxy_connect_timeout 5s` |
| 修改 | `docs/release/mac-mini-deployment-runbook.md` | 增加 504 定位、候选验证与回滚口径 |
| 修改 | `e2e/TEST-CATALOG.md` | 登记 Agent 创建/草稿错误分类的 P1 旅程 |
| 修改 | `e2e/agent-capabilities.integration.spec.ts` | 验证正常创建仍只产生一次请求并成功保存 |

## 3. 执行顺序

工作轨 A（任务 1–4）修复用户可见 500；工作轨 B（任务 5–6）建立目标环境模拟；工作轨 C（任务 7）处理 504 证据与失败时延。三条工作轨不共享实现状态，推荐按 A → B → C 执行，最后统一完成任务 8–9。

### Task 1: 从目标源码基线创建隔离工作区

**Files:**

- Read: `docs/development/overview.md`
- Read: `docs/development/internal-ports.md`
- Read: `docs/development/development.md`
- Read: `docs/development/agent-design-standard.md`
- Read: `docs/development/agent-design-gap-analysis.md`

- [ ] **Step 1: 确认远端引用和当前工作区不被修改**

```powershell
git rev-parse target/main
git rev-parse target-v2026.10.16-01
git status --short
```

Expected: 前两条分别输出 `667b00ea12db2db599f0966c7866c32238583018` 与 `af0faca9a86ab8fdecb937286c69199572232e3a`；记录但不清理当前脏工作区。

- [ ] **Step 2: 创建隔离 worktree 和分支**

优先使用 Codex 原生 `create_worktree(ref="target/main", name="target-environment-hardening")`。原生工具不可用时执行：

```powershell
git worktree add C:\Users\23234\local-code\dsh-work-target-hardening -b codex/target-environment-hardening target/main
```

Expected: 新 worktree 的 `HEAD` 为 `667b00e...`，原目录的文件和 HEAD 均不变化。

- [ ] **Step 3: 安装锁定依赖并启动一次性 PostgreSQL**

```powershell
corepack pnpm install --frozen-lockfile
docker run -d --name dsh-work-target-sim-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dsh_work_test -p 127.0.0.1:55432:5432 postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
```

Expected: 容器 `dsh-work-target-sim-pg` 健康，数据只存在于该一次性容器，不挂载开发或目标机 volume。

- [ ] **Step 4: 跑基线**

```powershell
pnpm test:m1
pnpm test:review:p2:logging
pnpm typecheck
```

Expected: 全部通过；若基线失败，先保存原始输出并判断是依赖/环境还是源码失败，不在功能提交中掩盖。

### Task 2: 先复现并修复 Agent 创建/草稿更新的两个 500

**Files:**

- Create: `server/src/modules/agent/agent-draft-input.test.ts`
- Create: `server/src/modules/agent/agent-draft-input.ts`
- Create: `server/src/infrastructure/postgres/agent-draft-api.integration.test.ts`
- Modify: `server/src/http/admin/agent-routes.ts`
- Modify: `server/src/modules/agent/postgres-agent-service.ts`
- Modify: `docs/development/openapi-admin.json`

- [ ] **Step 1: 写输入结构的 RED 单元测试**

测试从一份合法 create/update payload 派生表格用例，逐项把以下字段改成 `undefined`、对象或错误数组元素：

```text
create: id, name, description, visibility, welcomeMessage, systemPrompt,
        changeSummary, roleIds, dataScopes, examplePrompts, skills, tools,
        maxOutputBytes, maxToolCalls, timeoutSeconds
update: agentId，加上 create 中除 id 外的同一组字段，以及 expectedRevision
optional: workInstructions, executionRoleIds, executionDataScopes
```

每个非法输入都必须抛 `RequestError(422, "invalid_request", ...)`，不得出现 `TypeError`。空白字符串是否允许继续由现有 `normalizeConfiguration` / `assertConfiguration` 决定；本层只保证结构安全，不复制业务校验。

```powershell
node --experimental-strip-types --test server/src/modules/agent/agent-draft-input.test.ts
```

Expected RED: 模块不存在或非法 payload 尚未被类型化拒绝。

- [ ] **Step 2: 实现唯一的 HTTP 草稿解析器**

在 `agent-draft-input.ts` 导出：

```ts
export function parseCreateAgentDraftInput(value: unknown): Omit<CreateAgentDraftInput, 'actor'>
export function parseUpdateAgentDraftInput(value: unknown): Omit<UpdateAgentDraftInput, 'actor'>
```

实现要求：

- 先验证 plain object，再验证所有会被 `.trim()`、`unique()` 或数值比较使用的字段。
- 字符串数组逐项验证；可选数组存在时也逐项验证。
- 三个额度字段必须是正安全整数。
- 不在解析器里重新实现 MCP scope、delegation policy、AgentSpec 内容和授权上限；保持现有领域校验为权威来源。
- 错误消息只列字段名和期望类型，不回显请求值。

- [ ] **Step 3: 让路由从 `unknown` 开始解析**

把两个入口改为先读取未知 JSON：

```ts
const input = parseCreateAgentDraftInput(await readJsonBody<unknown>(request))
```

```ts
const input = parseUpdateAgentDraftInput(await readJsonBody<unknown>(request))
const { expectedRevision, ...draft } = input
```

保留 `requireRequestIdentity`、`preservePublicationScope: true` 和现有服务调用，不允许路由自行写数据库。

- [ ] **Step 4: 写 PostgreSQL RED 集成测试**

`agent-draft-api.integration.test.ts` 使用现有 Router、测试身份和一次性 PostgreSQL fixture，覆盖：

1. 合法 POST 返回 201。
2. 相同 ID 的第二次 POST 返回 409、`state_conflict`，原 Agent 和版本各只有一条。
3. 合法 Agent 的 PATCH 分别缺少 `welcomeMessage`、`name`、`description`、`visibility`、`systemPrompt`、`changeSummary` 时返回 422、`invalid_request`。
4. 数组包含非字符串时返回 422。
5. 任何 422 后 `revision` 与版本数量不变化。

```powershell
$env:DSH_WORK_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/dsh_work_test'
node --env-file-if-exists=.env --experimental-strip-types --test server/src/infrastructure/postgres/agent-draft-api.integration.test.ts
```

Expected RED: 重复 ID 是 500；至少一个非法 PATCH 是 500。

- [ ] **Step 5: 仅映射精确的主键冲突**

在 `postgres-agent-service.ts` 增加窄判断：

```ts
function isAgentIdConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint_name?: unknown }
  return candidate?.code === '23505' && candidate.constraint_name === 'agents_pkey'
}
```

只包住 `createAgent` 的事务写入；命中后抛 `stateConflict('Agent 标识已存在，请刷新列表后重新创建')`，其他数据库异常原样抛出。不得用“先查再插”替代约束捕获，否则保留竞态。

- [ ] **Step 6: 同步 OpenAPI**

- `POST /agents` 增加 409 response，保留 201/422。
- `PATCH /agents/draft` 增加 409 与 422 response，保留 200。
- 请求 schema 的 required 字段与运行时解析器一致；`expectedRevision` 在 PATCH 中必填。

- [ ] **Step 7: 跑绿并提交**

```powershell
node --experimental-strip-types --test server/src/modules/agent/agent-draft-input.test.ts
$env:DSH_WORK_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/dsh_work_test'
node --env-file-if-exists=.env --experimental-strip-types --test server/src/infrastructure/postgres/agent-draft-api.integration.test.ts
pnpm typecheck
git add server/src/modules/agent/agent-draft-input.ts server/src/modules/agent/agent-draft-input.test.ts server/src/http/admin/agent-routes.ts server/src/modules/agent/postgres-agent-service.ts server/src/infrastructure/postgres/agent-draft-api.integration.test.ts docs/development/openapi-admin.json
git commit -m "fix(agent): classify invalid drafts and duplicate ids"
```

Expected: 单元与集成测试通过，API 不再把这两类调用方错误返回 500。

### Task 3: 固化发布试运行的 409 语义，不恢复旧入口

**Files:**

- Modify: `server/src/infrastructure/postgres/agent-release-governance.integration.test.ts`
- Verify: `server/src/http/admin/agent-release-routes.ts`
- Verify: `docs/development/openapi-admin.json`

- [ ] **Step 1: 添加当前入口回归**

新增 API 级断言：执行授权、Runtime 兼容或发布检查未满足时，`POST /api/admin/v1/agents/:agentId/release/case-trials` 返回 409；响应 code 为 `state_conflict`，且不创建 trial/Run/Attempt。

- [ ] **Step 2: 固化旧入口已退出**

断言 `POST /api/admin/v1/agents/:agentId/release/trials` 返回 404，OpenAPI 中不存在该 start 路径；带 `trialId` 的 continue/confirm/cancel 路径不受影响。

- [ ] **Step 3: 验证且只提交测试**

```powershell
$env:DSH_WORK_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/dsh_work_test'
pnpm test:agent-release:integration
git add server/src/infrastructure/postgres/agent-release-governance.integration.test.ts
git commit -m "test(agent): preserve release trial conflict semantics"
```

Expected: 当前代码直接通过；若失败，只修现有 `case-trials → startTrial → stateConflict` 路径，不增加兼容入口。

### Task 4: 固化关键 Agent 创建旅程

**Files:**

- Modify: `e2e/TEST-CATALOG.md`
- Modify: `e2e/agent-capabilities.integration.spec.ts`

- [ ] **Step 1: 先写业务验收条目**

在目录中登记 P1 旅程“Agent 草稿请求错误分类”：合法管理端创建只发出一次 POST 并保存；重复 ID 是可恢复冲突；结构不完整是输入错误；两者都不产生额外版本或审计成功记录。明确 P1 使用一次性 PostgreSQL和受控 Runtime，不能证明真实 DSH/OIDC。

- [ ] **Step 2: 更新浏览器旅程**

在点击“完成创建”前监听 `/api/admin/v1/agents` 的 POST 数量，断言成功弹窗出现且计数为 1。通过 `page.request` 对同 ID 发第二次请求，断言 409；不要用双击模拟一个没有证据的前端缺陷。

- [ ] **Step 3: 浏览器预演并跑 spec**

```powershell
pnpm test:e2e:agent-capabilities
git add e2e/TEST-CATALOG.md e2e/agent-capabilities.integration.spec.ts
git commit -m "test(e2e): cover agent draft failure classification"
```

Expected: 正常创建、单次提交、409 呈现和后续能力装配旅程全部通过。

### Task 5: 建立无凭据的目标环境快照与 preflight

**Files:**

- Create: `config/target-environment/2026-10-17.json`
- Create: `scripts/testing/target-environment-preflight.mjs`
- Create: `scripts/testing/target-environment-preflight.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写机器可读快照**

快照只保存非敏感事实：

```json
{
  "capturedAt": "2026-10-17",
  "sourceCommit": "667b00ea12db2db599f0966c7866c32238583018",
  "release": { "version": "v2026.10.16-01", "commit": "af0faca9a86ab8fdecb937286c69199572232e3a" },
  "node": "26.8.1",
  "pnpm": "11.24.0",
  "postgres": "17.11",
  "dsh": { "version": "0.1.2-rc.1", "commit": "76fda729799fe9b3848dbe2c211d4b231032b81e", "profile": "acp-app", "compatibility": null },
  "migrationsThrough": "0081"
}
```

不要加入主机名、用户名、目录、端口、连接串或任何 SET 值。

- [ ] **Step 2: 写 preflight 的 RED 测试**

测试通过依赖注入的命令结果与环境对象覆盖：完全匹配、Node/pnpm/DSH commit 不匹配、compatibility 被设置、迁移落后、必须键缺失，以及输出中从不包含传入的秘密值。

```powershell
node --test scripts/testing/target-environment-preflight.test.mjs
```

Expected RED: preflight 模块不存在。

- [ ] **Step 3: 实现只读 preflight**

CLI：

```powershell
node scripts/testing/target-environment-preflight.mjs --profile config/target-environment/2026-10-17.json --json
```

输出每项 `match`、`mismatch`、`missing` 或 `not-checked`，并满足：

- 读取 `node --version`、`pnpm --version`、当前 Git commit、`server/config/dsh/runtime-lock.json`、DSH 的版本/commit 与 profile。
- `DSH_RUNTIME_COMPATIBILITY` 只允许 `missing`；任何值均失败。
- 数据库检查只读取 `schema_migrations` 的最大版本；没有 `DSH_WORK_TEST_DATABASE_URL` 时标记 `not-checked`，不回退到业务数据库变量。
- 对密钥、连接串和 provider credential 只输出 `SET/MISSING`，绝不输出值。
- 退出码：全匹配 0，有 mismatch/missing 1，仅可选项 not-checked 仍为 0。

- [ ] **Step 4: 接入脚本测试**

在根 `package.json` 增加：

```json
"preflight:target-simulation": "node scripts/testing/target-environment-preflight.mjs --profile config/target-environment/2026-10-17.json",
```

并把 `scripts/testing/target-environment-preflight.test.mjs` 加入现有 `test:scripts` 显式文件列表。

- [ ] **Step 5: 验证与提交**

```powershell
pnpm test:scripts
pnpm preflight:target-simulation
git add config/target-environment/2026-10-17.json scripts/testing/target-environment-preflight.mjs scripts/testing/target-environment-preflight.test.mjs package.json
git commit -m "chore(testing): add target environment preflight"
```

Expected: 测试通过；当前机器若不是目标等价环境，preflight 以明确 mismatch 退出，这是正确结果而不是测试失败。

### Task 6: 用合成 Worker 复现供应商 401/403 与审计告警链

**Files:**

- Modify: `server/src/modules/runtime/testing/mock-acp-worker.ts`
- Modify: `server/src/modules/runtime/runtime-adapter.test.ts`
- Create: `docs/development/target-environment-simulation.md`

- [ ] **Step 1: 先写两个 RED 运行时测试**

给 Mock Worker 约定两个仅测试可见的输入标记：`[provider-401]` 与 `[provider-quota-403]`。测试断言：

1. `handle.done` 为 `failed`，`errorCode` 保持 `RUNTIME_EXECUTION_FAILED`。
2. 错误阶段是模型 turn，不被改写为 MCP authentication/availability 错误。
3. 会话没有 usage/tool evidence 时只产生一次 `mcp invocation audit failed` 告警，告警不覆盖主失败。
4. 日志与事件不出现合成 token、Authorization 或完整上游响应体。

```powershell
pnpm test:m1
```

Expected RED: Mock Worker 尚不支持这两个故障模式，或因果断言缺失。

- [ ] **Step 2: 扩展 Mock Worker，不改生产执行入口**

两个标记都在 ACP `session/prompt` 阶段返回合成错误；401 使用 `Invalid token`，403 使用 `quota is not enough`。不要在生产 Adapter 中增加测试开关，不要创建 HTTP 模型代理，也不要写 `.env` 密钥。

- [ ] **Step 3: 编写模拟操作文档**

`target-environment-simulation.md` 必须包含：

- 从 `target/main` 创建隔离 worktree，Node/pnpm/PostgreSQL/DSH 与快照对齐。
- 从 `deploy/runtime.env.example` 生成本机忽略的 `.env.target-simulation`，只使用测试秘密；不得复制目标 `runtime.env` 或 `~/.dsh`。
- 运行 preflight、迁移一次性 PostgreSQL、执行 Task 2–3 集成测试。
- 运行 `[provider-401]`、`[provider-quota-403]`、malformed prompt 和无 usage/tool evidence 场景。
- 区分“主因”“下游告警”“独立 504”，并列出每个场景的 Run/Attempt、错误码、日志和预期状态。
- 清理只删除本轮明确命名的容器、volume、测试数据库和 worktree；不使用宽泛递归删除。

- [ ] **Step 4: 验证与提交**

```powershell
pnpm test:m1
pnpm check:secrets
git add server/src/modules/runtime/testing/mock-acp-worker.ts server/src/modules/runtime/runtime-adapter.test.ts docs/development/target-environment-simulation.md
git commit -m "test(runtime): simulate provider rejection audit chain"
```

Expected: 401/403 的主失败和 MCP 审计告警关系可重复，且完全不依赖真实供应商。

### Task 7: 为 504 增加跨层关联和 5 秒失败上限

**Files:**

- Modify: `server/src/http/http-error-log.ts`
- Modify: `server/src/http/router.ts`
- Modify: `server/src/http/review-p2-error-logging.test.ts`
- Create: `scripts/testing/nginx-proxy-config.test.mjs`
- Modify: `deploy/nginx/default.conf.template`
- Modify: `deploy/nginx/proxy_params`
- Modify: `package.json`
- Modify: `docs/release/mac-mini-deployment-runbook.md`

- [ ] **Step 1: 写应用日志 RED 测试**

更新安全日志测试，要求每条 `http.request.failed` 具有：

```text
timestamp: ISO-8601 UTC
requestId: 32 位小写十六进制
traceId: trace-http-UUID
method, registered route path, status, code, message, responseStarted
```

带合法 `X-Request-Id` 时响应和日志使用同值；缺失或格式不合法时 Router 生成新值。继续验证 URL 参数、请求体、Cookie、Token、堆栈、任意对象和控制字符不进入日志。

- [ ] **Step 2: 实现安全 requestId**

在请求刚进入 Router 时只接受 `/^[a-f0-9]{32}$/` 的 header，否则用 16 字节随机值生成。设置响应头 `X-Request-Id`，所有失败日志显式传入该值；`traceId` 继续用于产品错误信封，不与 requestId 合并。

`http-error-log.ts` 在 JSON 顶层增加 `timestamp: new Date().toISOString()` 与 `requestId`，不记录原始 URL、Referer、User-Agent、请求头或 IP。

- [ ] **Step 3: 写 Nginx 配置 RED 测试**

`nginx-proxy-config.test.mjs` 读取模板并断言：

- JSON access log 包含 `$time_iso8601`、`$request_id`、`$request_method`、`$uri`、`$status`、`$request_time`、`$upstream_connect_time`、`$upstream_header_time`、`$upstream_response_time`、`$upstream_addr`。
- 不使用 `$request_uri`，避免查询参数进入新增 JSON 日志。
- `proxy_set_header X-Request-Id $request_id` 覆盖客户端值。
- `proxy_connect_timeout 5s` 生效；长响应仍保留现有 `proxy_read_timeout 3600s`。

- [ ] **Step 4: 修改代理配置**

在 `default.conf.template` 的 http 级 include 范围定义 `log_format dsh_work_json escape=json ...` 并设置 `access_log`；在 `proxy_params` 增加 requestId 转发和 5 秒 connect timeout。不要改成静态 IP，不删除 Docker resolver/`ipv6=off`，不把 Node 服务搬进 Compose。

- [ ] **Step 5: 接入测试并更新 runbook**

把 `scripts/testing/nginx-proxy-config.test.mjs` 加入 `test:scripts`。Runbook 增加：

1. 通过同一 requestId 关联 Nginx access 与应用 error log。
2. `upstream_connect_time` 为空或接近 5 秒时按宿主代理不可达处置；有 connect time 但 response time 很长时按应用/依赖慢处置。
3. 5 秒是 fail-fast 缓解，不是可用性修复；若继续出现，另立方案评估将后端纳入同一容器网络。
4. 回滚仅恢复这两个 Nginx 文件和候选 Release，不修改历史 Release 目录。

- [ ] **Step 6: 本地候选容器验证**

```powershell
pnpm test:review:p2:logging
pnpm test:scripts
docker compose --env-file .env.target-simulation -f deploy/compose.yaml config
```

在隔离 Compose 项目里让上游端口暂时不可监听，发起一条 `/health/live` 请求，断言 504 在 8 秒内返回且 Nginx JSON 日志有 requestId 和 upstream timings；随后启动合成上游并断言 200 恢复。不得对目标机生产服务执行故障注入。

- [ ] **Step 7: 提交**

```powershell
git add server/src/http/http-error-log.ts server/src/http/router.ts server/src/http/review-p2-error-logging.test.ts scripts/testing/nginx-proxy-config.test.mjs deploy/nginx/default.conf.template deploy/nginx/proxy_params package.json docs/release/mac-mini-deployment-runbook.md
git commit -m "fix(deploy): correlate and bound proxy connect failures"
```

### Task 8: 完成本地分层验证

**Files:**

- Verify: all changed files

- [ ] **Step 1: 静态与单元测试**

```powershell
pnpm ci:check
pnpm check:architecture
pnpm test:m1
pnpm test:review:p2:logging
```

Expected: 全部通过；无第二套 Agent 执行链路、无秘密、无 OpenAPI/类型漂移。

- [ ] **Step 2: P1 集成测试**

```powershell
$env:DSH_WORK_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/dsh_work_test'
pnpm test:integration
pnpm test:agent-release:integration
```

Expected: 一次性 PostgreSQL 全绿；失败用例不向业务数据库写入。

- [ ] **Step 3: 浏览器测试**

```powershell
pnpm test:e2e:agent-capabilities
```

若 Router、认证 fixture 或公共导航在实现中发生额外修改，再执行完整 `pnpm test:e2e`；否则记录只运行相关 P1 spec 的原因。

- [ ] **Step 4: 最终差异检查**

```powershell
git diff --check
git status --short
git log --oneline target/main..HEAD
```

Expected: 无空白错误；只有计划列出的变更；提交按功能边界分开。

- [ ] **Step 5: 清理本轮一次性数据库**

确认所有 P1 证据已经保存后，仅删除本计划创建的明确命名容器：

```powershell
docker rm -f dsh-work-target-sim-pg
```

Expected: 容器及其未挂载数据被删除；不触碰其他容器、volume、开发数据库或目标机数据。

### Task 9: 目标机候选发布与 P2 回填

**Files:**

- Modify after execution: `docs/development/target-environment-diagnostic-questionnaire.md`
- Verify: `docs/release/mac-mini-deployment-runbook.md`

- [ ] **Step 1: 构建不可变候选 Release**

从已验证提交构建新的唯一版本号；不要覆盖 `v2026.10.16-01`，不要在 `releases/**` 就地补丁。记录 Git commit、构件 sha256、文件清单校验和回滚指针。

- [ ] **Step 2: 目标机只做正向与安全失败验收**

目标机智能体按 Runbook 执行并把以下内容追加到诊断文档新章节，不得回传任何秘密或业务正文：

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

重复 ID 与非法 PATCH 只允许在专用测试 Agent/候选验收数据上执行；模型 401/403 不在目标机用真实密钥注入，使用本地 Task 6 证据。

- [ ] **Step 3: 判定发布**

只有以下条件同时成立才可进入正式发布：两个 API 错误分类符合 409/422、正常 Agent 旅程通过、真实 DSH 正常 Attempt 通过、requestId 可关联、无秘密泄露、候选观察窗口没有新增未分类 500。504 若仍出现但已在 5 秒内失败，应记录为独立基础设施问题，不能宣称已根治。

## 4. 完成定义

- Agent 重复 ID 与草稿结构错误在单元、P1 PostgreSQL 和相关浏览器旅程都有证据，且不再返回 500。
- 当前 `case-trials` 的 409 语义被回归测试固定，旧 start route 仍不存在。
- 本地模拟使用目标 DSH 正式基线或明确报告 mismatch；未复制目标机凭据和数据。
- 合成 401/403 能稳定证明“模型供应商拒绝是主失败、MCP 审计告警是下游现象”。
- Nginx 与应用日志能通过 requestId 关联，日志含 ISO 时间，且新增字段继续满足脱敏约束。
- 宿主上游不可达在约 5 秒内失败；文档明确该项只是缓解，未把它表述为拓扑根治。
- `pnpm ci:check`、相关单元/P1/E2E 和 `git diff --check` 全部通过；P2 结果由目标机按安全模板回填。

