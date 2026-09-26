# Agent 数据平面（AE-03）

本契约用于非权威的轻量工作记录和 Agent 私有运行状态。Agent 仍由现有 Task/Run/Attempt → Runtime Adapter → DSH 执行；平台受控工具负责读写。ERP、库存、财务等权威数据继续留在原系统，文件继续使用 Artifact/工作空间。上传 Agent 包不会执行 SQL 或为该 Agent 建表。

## 开发者声明

包内 `agent.yaml` 的 `spec.data` 只声明需求，不授予权限。`schema` 可省略；填写时必须引用同名 `schemas/<key>.json` 文件，作为平台审核候选。配置创建接口也可提交 `data.state` 与集合 key、scope、schemaVersion、actions；已发布集合的 Schema 仍由平台管理。

```yaml
spec:
  instructions: SOUL.md
  data:
    state: true
    collections:
      - key: shortage_records
        scope: workspace
        schemaVersion: 1
        actions: [query, propose, transition]
        schema: schemas/shortage_records.json
```

管理员先创建 Agent 草稿，再发布集合、按 Agent 安装实例授予动作，完成试运行后发布 Agent。发布事务检查集合状态、作用域、Schema 版本、候选内容和当前 Grant；不匹配时拒绝发布。Schema 升级保留历史定义和记录版本，但旧 Agent Version 的固定声明不再允许读写当前集合，须发布新 Agent Version。私有集合只可授权原安装实例；共享集合由租户或 Workspace 拥有，可授权多个 Agent。停用 Agent 或撤回 Grant 不删除企业记录。

## DSH 工具

工具的实际名称使用下划线：`state_get`、`state_put`、`data_query`、`data_propose`、`data_create`、`data_update`、`data_transition`。平台仅把 Agent Version 明确声明的动作放进 Manifest；DSH Bridge 在每次调用前后复核当前执行授权，服务端再次核对 Attempt、Agent Principal、Workspace、集合 Grant、Schema 版本和作用域。不要把这些内置工具重复填入 `spec.capabilities.tools`。

| 工具 | 输入要点 | 结果与语义 |
| --- | --- | --- |
| `state_get` / `state_put` | `namespace`、`key`；写入另需 `value`、`expectedVersion`、`ttlSeconds` | 状态按安装实例隔离，单值 ≤16 KiB、最多 500 键，TTL 为 60 秒～90 天；期望版本不符返回冲突，不承载业务事实或执行检查点 |
| `data_query` | `collectionKey`，可选已批准 `field`+`equals`、`limit`、`after` | 返回 `records`（含每条记录实际 `schemaVersion`）与 `nextCursor`，最多 100 条/页；无任意 SQL 或未批准字段过滤 |
| `data_propose` | `collectionKey`、`recordKey`、`data`、`expectedVersion`、`operationKey` | 按来源 Attempt 幂等保存待审提案；返回 `proposalId`，不创建业务记录；管理员审核后才产生版本 |
| `data_create` / `data_update` | 集合、记录 key、JSON 对象与操作 key；更新另需 `expectedVersion` | 用于已由数据所有者批准可直接写入的非权威工作记录；返回 `recordId`、`recordVersionId`、`version` |
| `data_transition` | 集合、记录 key、预期版本、`expectedStatus`、`nextStatus`、操作 key | 只改变记录 JSON 的 `status` 字段，执行版本与原状态比较，并按当前 Schema 校验；返回新版本引用 |

写入的数据须符合已发布 JSON Schema，单条 ≤64 KiB，每集合最多 10,000 条记录。每个安装实例的状态写入限 120 次/分钟；每个安装实例对每个集合的记录写入与提案合计限 120 次/分钟，审核落库也计入该集合额度。成功事务才占用额度，幂等重放不重复计数；过期计数桶由定时清理。状态最多 500 个有效键，重新写入已过期键也占用一个有效名额。操作 key 在来源 Attempt 内去重；相同 key 配不同请求会冲突，原记录删除后同一 key 的重放也返回冲突。版本、写入 Principal 和来源 Run/Attempt 保存在固定通用表。Agent 产生的 JSON 若需要人工核实业务真实性，应使用 `data_propose`；Schema 通过本身不等于业务事实正确。发布试运行中的数据工具只返回 `trialOnly` 结果，不改动真实状态、记录或提案。

管理员 API 前缀为 `/api/admin/v1/agent-data`：`POST /collections` 发布集合，`GET /collections` 查看定义，`PATCH /collections/:id/schema` 提升 Schema 版本，`PATCH /collections/:id/status` 启停，`PATCH /collections/:id/grants/:agentId` 设置或清空动作授权，`GET /collections/:id/grants` 查看授权，`GET /collections/:id/records` 分页查看记录，`GET /proposals` 和 `POST /proposals/:id/review` 审核提案，`DELETE /records/:id` 删除记录。所有操作要求当前有效的平台管理员角色；API 不允许 Agent 自行发布集合或授权自己。批准提案时在同一事务复核来源 Run/Attempt、Agent Principal 当前角色与数据范围、接收人当前工作台及 Workspace 读取授权和数据范围、团队 Agent 成员及 Workspace 授权，以及来源 Agent Version 固定的集合 Schema 版本。员工交互任务还要求执行角色属于当前用户，并符合 Agent Version 的目录可见角色；Agent 主动任务使用独立批准的执行角色，不要求接收人持有该角色，也不以目录可见角色限制执行提案。撤权或 Schema 升级后须拒绝旧提案的写入。

状态到期后清理；记录超过集合保留期且来源 Run 均已结束后，删除 JSON 正文与全部历史版本，仅保留不含正文的版本摘要、来源、删除原因和操作去重凭据，以便历史任务结果显示已删除的版本引用，并阻止旧 Attempt 重放已删除的写入。待审提案保留 30 天，已处理提案保留 90 天。`task-result/v1` 对实际写入给出不可变 `recordVersionId` 回执，但不把状态游标、集合查询或提案受理当作业务目标已达成，也不把外部系统 `unknown` 回执推断成成功。

代码级验收使用 `pnpm test:agent-data:integration`、Agent 包解析与 Runtime 工具契约测试。真实 DSH/OIDC、多账号撤权、外部写操作及故障恢复属于 P2 验收，需另留真实环境证据。
