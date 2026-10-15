# 8a：严格试运行证据绑定 Attempt 与启动配置

基线：3015d241，依赖批次 0/A1/A2。这里只修复证据隔离，不实施 8b 的场景化判据放宽。

## 失败样例与验证

修复前：将 AdminSkillInstallationService 恢复到未修复版本，保留同一 PostgreSQL 回归。首次失败 Attempt 留下激活、Python 成功和非空回复，当前重试 Attempt 没有这些证据。旧代码返回 passed=true，预期 false，测试真实失败。

修复后：新增证据/指纹单测 10/10；专用 PostgreSQL 用例 4/4；安装、Skill 生命周期与 Agent 生命周期相邻回归共 14 条，13 通过、1 条真实 DSH 专项按原配置跳过。新增实际资源草稿变更、依赖变更和完整快照重试回归通过。服务器 TypeScript、构建、变更文件及全仓 ESLint 通过。Node 22.19.0，PostgreSQL 17.11，专用一次性测试库。

## 代码变化

- 通过 runs.current_attempt_id 精确定位 Attempt；激活、Python、事件都按 Attempt 查询。
- 完成回复取该 Attempt 的 assistant.completed 事件，不用旧 Attempt 在同一 Run 下留下的 messages。
- 激活匹配 Skill 版本，Python 证据匹配该快照声明的入口；保留本轮之前的全部依赖覆盖规则。
- 测试开始前在内存固定原草稿及完整依赖图的摘要；Run 创建后写入不可更新的 skill_test_bindings。若服务恰好在 Run 创建与绑定写入之间退出，该测试不可用于发布，必须重测；不猜测或回填证据。
- 同步与异步测试结果均以 Attempt 标识持久化；发布要求当前成功 Attempt、attempt-v2 证据策略及原始配置/资源/依赖摘要相符。
- 发布在原领域事务中锁定当前 Run 和依赖版本并再次比较，不改写旧 Manifest，也不自行运行模型。
- Skill 测试重试复制完整不可变 Manifest，只有 Attempt 标识和创建时间变化，不再只重建根 Skill。

## 迁移与兼容

新增 0039_skill_test_attempt_evidence.sql；不修改 0001–0038。增加启动绑定表与严格结果的 Run/Attempt 关联，旧结果保留为 legacy。不修改已发布 Skill 的状态；旧待发布草稿需重新完成新策略测试。既有无实际 Runtime 的失败测试替身仍可记录失败，但不能伪造 passed 证据。

旧版应用能忽略新增列，但回滚旧代码会恢复其旧发布判据，不能视为安全等效回滚。数据库与 Skill 内容目录仍须成组备份。没有在生产执行迁移。

## 未验收

真实 DSH Profile、真实模型、真实 Python 容器及目标主机业务结果尚未验证。受控 ACP Worker 与合成证据证明工程行为，不证明 Skill 业务答案正确。C9、C10、8b 不在本提交范围。
