# 文档导航

`docs/` 现按五类维护：`index`、`development`、`release`、`design`、`history`。当前开发和上线所需内容放在前四类；历史批次、交接快照和一次性核查材料统一进入 `history/`。

| 阅读目的 | 文档 |
| --- | --- |
| 了解产品与仓库 | [项目入口](../../README.md) |
| 开发约束与统一 Agent 执行要求 | [项目工作规范](../../AGENTS.md) |
| 启动开发、选择测试、准备验收 | [开发与测试](../development/development.md) |
| 理解业务、权限和系统边界 | [架构总览](../development/overview.md) |
| 设计和评审 Agent，区分现行规则与扩展门槛 | [Agent 设计规范](../development/agent-design-standard.md) |
| 核对十二条规范的代码证据、测试覆盖和实施缺口 | [Agent 规范与当前实现差异清单](../development/agent-design-gap-analysis.md) |
| 逐步优化执行观测、工具适配、上下文延续、恢复与性能 | [Runtime 执行架构渐进优化方案](../design/runtime-execution-optimization-plan.md) |
| 实施轻量自动任务及核对 AC-20～24 验收 | [AG-03 轻量自动任务实施方案](../design/automation-implementation-plan.md) |
| 理解数据关系与迁移约束 | [数据模型](../design/data-model.md) |
| 规划统一的 Skill、Agent 和运维对话入口 | [管理助手交互方案](../design/admin-assistant-plan.md) |
| 设计已有 Skill 的受控 Python 执行、依赖、权限与成果交付 | [Skill Python 脚本执行方案（核心门禁已实施）](../design/skill-python-execution-plan.md) |
| 了解当前对话安装能力及验收边界 | [对话安装实现](../design/admin-skill-installation-implementation.md) |
| 规划 Skill ZIP 上传、管理助手安装及手工创建模式退出 | [Skill 安装产品方案与实施计划](../design/skill-installation-plan.md) |
| 团队工作空间现行方案与界面基线 | [团队工作空间产品方案与实施计划](../design/team-workspace-plan.md)、[团队工作空间增量界面设计](../design/team-workspace-design.md) |
| 查看历史批次、交付记录与交接快照 | [历史记录总索引](../history/README.md) |
| 修改内部接口与事件 | [内部端口与契约](../development/internal-ports.md) |
| 配置登录、员工目录和首位管理员 | [AI Hub 身份接入](../release/ai-hub-sso-integration.md) |
| 安装、验证与升级执行内核 | [DSH Runtime](../release/dsh-runtime-delivery.md) |
| 发布、首次安装、升级、备份、恢复及地址变更 | [Mac mini 部署手册](../release/mac-mini-deployment-runbook.md) |

机器可读契约与测试夹具放在 `development/`：

- [员工端 OpenAPI](../development/openapi-workbench.json)
- [管理端 OpenAPI](../development/openapi-admin.json)
- [Runtime Manifest Schema](../development/runtime-manifest.schema.json)
- [Run Event Schema](../development/run-event.schema.json)
- [合成测试数据](../development/fixtures/mvp-fixtures.json)

维护规则：

1. API 字段以可执行契约与测试为准，物理数据结构以 [SQL 迁移](../../server/migrations/) 为准，内部类型以源码为准；文档解释边界，不复制完整实现。
2. 同一主题只维护一个入口；新决策直接更新对应文档，不另建重复方案、路线图或已完成清单。
3. 文档写可复现命令和验收条件；测试、CI、发布、远端部署和真实业务验收分别记录，不能互相替代。
4. 接口、配置、命令改变时同步更新文档和校验；过期说明从工作树删除，已提交历史由 Git 保存。
