# C6：已有草稿展示文案一次最终确认

## 边界与判定位置

`server/src/modules/agent/agent-draft-copy-policy.ts` 是服务器唯一的 copy-only 白名单：`name`、`description`、`welcomeMessage`、`examplePrompts`。本轮只覆盖 **Agent 已有草稿**，不开放 Skill 包文本编辑，不自动从已发布版本建立草稿。systemPrompt/执行指令、owner/department、角色、数据范围、工具、Skill、可见性、发布/停用、Runtime 参数及未知字段一律不属于低风险；合法字段混入任何不支持键也拒绝，不接受客户端或模型的 risk/confirmation 标签。

`AdminAssistantService.prepareAction` 对通用 `admin-assistant` Run 的请求字段和完整归一化差异都判定；计划 JSON 固定 `confirmation`（策略版本、模式、Attempt、字段），摘要覆盖它。最终 `confirmAction` 重新校验受众、原 Attempt、当前写权限及目标版本。`PostgresAgentService.updateAgent` 在目标行锁中再次检查现有草稿和完整差异，不修改活动版本或已发布目录元数据。没有新增执行引擎，通用助手仍是同一 DSH Run/Attempt 的平台工具调用。

专用 Run 仍可准备高风险计划，但 **执行时必须存在同一管理员/Session/专用 Run/目的的已确认委派记录**。这也允许原 `confirmProposal` 启动专用 Run、再完成委派记账的顺序；不在专用准备瞬间因记账竞态误拒，写入前绝不省略第一次确认。旧计划没有 confirmation 元数据时只按 delegated 处理，不能隐式升级为 single。

## 实现与兼容

- 新计划生成只保存差异，不调用领域写入。最终确认使用既有领域服务、乐观版本检查、幂等状态与审计。
- 不覆盖旧计划摘要，不改迁移，不变更管理员/员工 Session 校验、自动任务、TW-10 或员工导航。
- 取消、配置变化、旧 Attempt、停用账号均不执行；重启仅对执行中计划核对事实，不自动重放写入。
- 新响应 `confirmationMode` 为增量字段；旧前端仍可按原确认卡操作，新前端仅 single 显示“一次最终确认”。权限/发布/Runtime 流程仍显示两步。

## 红绿证据

隔离 PostgreSQL 17.11、Node 22.19.0，全部业务对象为合成测试数据；测试调用的是现有平台工具处理器与真实领域事务，不声称运行了真实模型。

修复前同一核心套件 3 过 / 4 失败：通用 Run 准备低风险计划被旧 purpose 闸门拒绝；无委派确认的专用 Run 却能执行；其余两个低风险流程因前者失败。修复后专属 10 项集成、2 项策略单测通过；相邻 Agent 生命周期 1 项、admin 会话 6 项通过（整组 17 项集成）；管理助手前端 15 项通过。原 Skill 安装套件 11 过 / 1 条真实 DSH 跳过；原通用助手工具目录断言同步接受新增的受限 prepare_admin_action。该套件取消竞态仍打印终态转换告警，日志保留，未扩大本轮修改范围。原始日志在交付包 `evidence/c6-red.tap` / `c6-green-adjacent.tap` / `c6-frontend.log`。

必测覆盖：字段混入与未知字段、现存草稿、no-op、先不写入、一次最终确认、双击只写一次、其他用户/停用身份、取消、目标漂移、Attempt 变化、发布版本不变、缺少委派证据的高风险拒绝、双确认高风险成功、重启不自动执行。

## 命令和限制

`pnpm test:review:c6:unit`、`pnpm test:review:c6:integration` 已接服务器/根脚本和 CI；前端通过既有 `test:m5:frontend` 运行。当前环境使用锁定离线依赖和 node 原入口执行等价命令。

浏览器预演导航 `http://localhost:4480/assistant` 被 Chromium 管理策略以 `ERR_BLOCKED_BY_ADMINISTRATOR` 拒绝；保留 trace，未修改策略。无法完成 Spec→浏览器 Verify，因此本轮未假装完成新 Playwright 旅程，目录内该旅程保持待预演。HTTP/组件测试不能替代浏览器或真实 DSH/OIDC/生产验收；后者均未运行。
