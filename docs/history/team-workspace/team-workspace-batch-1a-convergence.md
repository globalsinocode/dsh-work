# 批次 1A 技术收敛草案

**状态：** 批次 0 产出，对应方案 9.2 节四项「批次 1A 开发前」收敛事项；待评审确认后作为 1A 设计与迁移依据。  
**更新日期：** 2026-09-09  
**依据：** [团队工作空间产品方案与实施计划](../../design/team-workspace-plan.md) 6.2/6.3/6.5 节及 2026-09-09 代码核查。

四项草案共用同一前提：**所有新增机制限定团队空间分支，个人空间代码路径与数据不做转换**（AC-23/AC-27）。

## 1. Agent 成员与平台允许范围

### 现状（核查证据）

- `agents`/`agent_versions` 已是完整实体；发布/停用/回滚走 admin API（`server/src/http/admin/agent-routes.ts`），`agent_versions.visible_role_ids` 与 `data_scopes` 是既有治理字段。
- 员工端 `listWorkbenchAgents` 已按 `visible_role_ids ? roleId` 过滤（`postgres-agent-service.ts:411`），`resolveWorkbenchAgentVersion`（`:437`）可服务端解析版本。
- **不存在「允许加入空间」概念**：任何团队空间都可以被加入任何已发布 Agent，除非补治理字段。方案 9.2 要求「平台允许范围的治理入口」。

### 草案

- **允许范围语义**：Agent 默认发布后即可被加入团队空间；平台管理员在 admin 端 Agent 治理页新增开关「允许加入团队空间」（默认开），关闭后该 Agent 不再出现在团队空间的「添加 Agent」搜索结果中。首版不做按空间白名单（复杂度与收益不匹配，写入对账清单）。
- **存储**：`agents` 增加列 `allow_workspace_join boolean not null default true`；admin 端 `PATCH /api/admin/v1/agents/:agentId` 扩展该字段（沿用现有 DTO/校验模式）。
- **员工端契约**（新接口，属 1A）：
  - `GET /api/workbench/v1/workspaces/:workspaceId/agent-candidates?query=&cursor=`：返回平台已发布（`status='published'`）、`allow_workspace_join=true`、`visible_role_ids` 与当前员工角色有交集的 Agent 摘要（名称/职责/版本/状态），不返回模型、凭据与 Skill/Tool 配置明细；详情由候选详情接口按需返回（关联技能、所需工具、数据范围摘要）。
  - `POST /api/workbench/v1/workspaces/:workspaceId/agent-members { agentId }`：服务端解析 `active_version_id` → 校验发布状态、允许范围、**并执行与 `authorizeRuntime` 相同的依赖校验**（Agent 显式授权其 Skill 依赖的全部工具，`postgres-authorization-service.ts:94-107` 已有该检查，抽出复用）→ 同事务写成员关联 + 授权来源（见第 2 节）→ 失败不部分保存（AC-03）。
- **已确认决策（2026-09-09）**：
  - 「可见角色交集」以**添加人（负责人）当前角色**判定；成员可用性在发起对话时再按其角色校验。
  - admin 端 Agent 详情页增加只读的「已加入空间」清单（评估停用影响），纳入 1A。

## 2. 授权来源多对多模型与存量对账

### 现状（核查证据）

- `workspace_capability_grants` 字段仅 `(tenant_id, workspace_id, capability_type, capability_version_id)`，PK 即唯一约束；运行时**没有任何写入 API**，仅迁移种子（`0010_m4_authorization.sql:36-48`）产生存量数据。
- `requireWorkspaceCapabilities`（`postgres-authorization-service.ts:301-321`）：grant 数为 0 抛「未配置授权」，否则按版本 ID 白名单匹配。
- 方案 6.3 要求：grant 集合作为「有效授权集合」，新增「授权-来源」多对多关系；移出 Agent 时不得误删其他来源仍需要的授权（AC-26）。

### 草案

- **新表 `workspace_grant_sources`**：

  | 字段 | 说明 |
  | --- | --- |
  | `id` | 主键 |
  | `tenant_id`, `workspace_id` | 归属 |
  | `capability_type`, `capability_version_id` | 指向既有 grant（`('agent','skill','tool')`） |
  | `source_type` | `agent_member`（Agent 关联）/ `manual`（明确人工授权）/ `legacy_unresolved`（存量待对账） |
  | `source_ref_id` | `agent_member` 时指向空间-Agent 关联实体 ID，其余为 null |
  | `status` | `active` / `revoked` |
  | `created_by`, `created_at`, `revoked_at` | 审计 |

- **有效集合计算**：`workspace_capability_grants` 保持为有效集合，由来源变更在**同一事务**内同步（新增来源 → upsert grant；撤销来源 → 仅当该 grant 无其他 active 来源时删除）。同步逻辑收敛在 Workspace/Authorization 应用服务内，不允许绕过直接写 grant。
- **存量对账**：迁移将既有 grants 各生成一条 `source_type='legacy_unresolved'` 的来源记录；admin 运营端（`admin/operations-routes.ts` 现有 `GET /workspaces` 基础上）增加「授权来源对账清单」视图：列出 legacy 来源及可能归属的 Agent（按 capability_type='agent' 匹配 agent_versions 推断，仅提示不自动回填）。**对账完成前**，凡涉及 legacy 来源的破坏性调整（移除 Agent、停用工具等）被拒绝并提示先对账（方案 6.3 第 303 行）。
- **与 Agent 成员联动**：加入 Agent 事务 = 写关联 + 为该 Agent 及其 Skill/Tool 依赖各建 `agent_member` 来源 + 同步 grant；升级 = 新版本来源 + 保留旧版本来源（既有 Session 仍可执行）；停用/移出 = 撤销该关联的全部来源，仅清理无其他 active 来源的 grant（AC-21/AC-26）。
- **已确认决策（2026-09-09）**：
  - legacy 对账完成后来源记录改写为 `manual` 并记审计，消除长期歧义。
  - `workspace_grant_sources` 撤销行保留（`status='revoked'`）不物理删除，供审计追溯。

## 3. 团队负责人唯一性约束

### 现状（核查证据）

- `workspace_members.member_role` 四值枚举已存在，但**全仓无一处读取 `member_role` 做授权判断**（仅 EXISTS 成员判断，`postgres-authorization-service.ts:207-212` 等），是死数据。
- 个人空间成员保护触发器（`0013` 迁移 106-138 行）已存在且必须不改写。
- 无「恰有一个 owner」的数据库约束；转交/角色变更逻辑尚不存在。

### 草案

- **单一事实来源**：团队负责人 = `workspace_members` 中 `member_role='owner'` 的成员关系，不新增 `workspaces.owner` 列（方案 6.3 已定）。
- **数据库约束**：创建团队限定可延迟约束触发器：

  ```sql
  create constraint trigger team_workspace_single_owner
    after insert or update or delete on workspace_members
    deferrable initially deferred
    for each row execute function assert_team_workspace_single_owner();
  ```

  触发器函数仅对 `workspace_type='team'` 的空间检查「恰有一个 owner」，否则 raise。个人空间行直接跳过（不改写 0013 触发器）。
- **转交事务**：`SELECT ... FOR UPDATE` 锁定 `workspaces` 行 → 更新旧 owner 与新 owner 的 `member_role`（提交时触发器校验）→ 写审计。任何时刻（含提交前）读取到的都是完整状态；并发转交只有一次成功（行锁串行化 + 提交校验，AC-02）。
- **角色→动作映射**（现状缺失，1A 新增）：在 Authorization 模块新增 `requireTeamRole(workspaceId, userId, roles)`，读 `member_role` 判定；权限矩阵（方案第 5 节）映射为服务端中间件/守卫，员工端仅按「允许动作」响应渲染。
- **存量数据（已确认决策 2026-09-10）**：约束触发器**无条件创建**（与方案 6.4 一致——方案只要求「约束通过前不执行转交」，未要求门禁约束创建）。异常空间对新写入 fail-closed：0 owner 空间补加 owner 行可自愈，2+ owner 空间需先人工对账收敛；迁移内以 NOTICE 输出异常清单。转交/角色调整 API 上线时在服务层前置校验当前空间恰有一个 owner，异常空间拒绝转交（对账完成前阻断，方案 6.4 第 314 行）。
- **已确认决策（2026-09-10）**：触发器函数位于迁移 `0022_team_workspace_authorization.sql`（1A-T1 已交付，9 项集成测试覆盖跨空间 UPDATE、个人空间跳过与 0013 守卫并存）。

## 4. 运行中收权机制

### 现状（核查证据）

| 缺口 | 证据 |
| --- | --- |
| claim/execute 前无授权复核 | `RunOrchestrationService.executeClaimed`（`:369-389`）直接调 Runtime；授权仅在 startRun/retry 时做一次（`:107-113,169-175`） |
| 取消仅本人、无系统入口 | `cancel()`（`:149-160`）经 `requireOwnedRun` 校验 `requestedBy`；`dsh-acp-runtime-adapter.ts:143` 的 `cancelCause='user'` 硬编码 |
| SSE 建连后不复查权限 | `streamRunEvents`（`conversation-routes.ts:158-211`）250ms 轮询推送，循环内无鉴权 |
| 无撤权事件 | `audit_events` 仅审计展示，无驱动收权的事件机制 |

### 草案（对应方案 6.5 节七条）

1. **授权修订标识 + 持久化撤权事件**：`workspaces` 增加 `team_auth_revision integer not null default 0`；新表 `workspace_revocation_events(id, tenant_id, workspace_id, user_id, kind, payload jsonb, status pending/processed, attempts, created_at, processed_at, unique(workspace_id, user_id, kind, payload_hash))`——事件幂等（唯一键 + 已处理跳过），可重放，进程重启后未处理事件继续处理（1A 完成，覆盖成员移除/退出/角色降级/Agent 停用与移出）。
2. **执行前复核**：`executeClaimed` 调用 Runtime 前调用 `authorizeRuntime` 复核（员工有效、团队角色、Agent 关联与版本、平台授权、数据范围）；复核失败 → run 置 `failed` 并写 `run_events` 说明「授权已撤销」，不调用 Runtime。复核只决定是否执行，不改不可变 Manifest。`recoverAfterServiceRestart` 重入队的任务同样在 execute 前复核。
3. **SSE 拦截**：`streamRunEvents` 循环每批写出前检查（团队分支启用）：内存授权缓存（key 含 `team_auth_revision`，修订号变化即失效，TTL ≤ 10s）+ 收到撤权事件时主动关闭订阅、丢弃待交付内容；断线续传时重新走建连鉴权。个人空间分支走原路径（AC-23）。
4. **系统取消**：`dsh-acp-runtime-adapter.cancel` 增加 `cancelCause: 'user' | 'system_revoke'`；`RunOrchestrationService` 新增内部方法 `systemCancelRun(runId, cause)`（不走用户 API、不要求 requestedBy 本人）：排队 → 直接置 `cancelled`；运行中 → `cancel_requested` + `runtime.cancel`；终态 → 幂等返回原 run。撤权处理循环消费事件调用该方法。
5. **竞态约束**：撤权事件 `processed` 提交后，新授权决策必须拒绝；取消实际执行可异步，但结果不得继续交付给失权者（写出前检查兜底）；验收覆盖「检查与写出」「领取与执行」「取消与完成」三组竞态（AC-09）。
6. **范围**：1A 交付 1-5（成员/角色/Agent 收权）；2A 在同一机制上扩展来源分享撤回与派生依赖失效（读取时同步校验 + 异步级联状态投影）。

### 已确认决策（2026-09-09）

- 授权缓存首版采用**进程内缓存 + 修订号失效**（现状为单进程调度器；多实例部署时另行评审）。
- `team_auth_revision` 采用 `workspaces` **独立整型列**（避免时间精度竞态）。
- 撤权事件保留策略：`processed` 事件按部署环境保留策略清理（写入方案第 9 节）。

## 5. 遗留观察与决策（1A-T7，2026-09-10）

### 5.1 `0013` 成员保护触发器不校验 personal→team 移动后的旧空间

**观察：** `protect_personal_workspace_membership`（`0013_m5_personal_workspaces.sql:106-138`）在 UPDATE 时只取 `NEW.workspace_id` 判定目标空间类型。把个人空间唯一 owner 的 `workspace_members` 行 `UPDATE` 到团队空间时，目标被识别为 team 而直接放行；旧的个人空间随后失去 owner 成员行，且没有任何约束阻止。团队侧的可延迟单负责人约束只校验新、旧**团队**空间，明确跳过个人空间，因此也不会兜底。

**决策（1A-T7）：本批次不修，记录为已知数据完整性缺口并固定当前行为。**

理由：

1. 方案 6.4 明确「不改写个人空间已有唯一索引、成员保护触发器和创建者规则」，AC-23/AC-27 要求团队迁移不修改个人业务记录、保护触发器与唯一索引；在 1A 内改写 0013 触发器违反该边界。
2. 该路径没有任何 API 入口（成员管理只做新增/改角色/移除，转交只更新 `member_role`），属潜在完整性缺口而非可利用越权。
3. 认证过的升级基线检查（AC-27）已覆盖唯一索引与空间非空约束；触发器存在性也纳入检查。

**后续建议：** 在独立批次用新迁移扩展 0013 守卫（UPDATE 且跨空间时同时校验 `OLD` 个人空间，拒绝使个人空间失去 owner 成员行），并同步更新 `team-workspace-migration.integration.test.ts` 中固定当前行为的用例。
