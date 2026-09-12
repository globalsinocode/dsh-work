# 文档导航

只维护当前开发、系统边界和部署操作所需的文档。历史里程碑、一次性审核和测试结果不作为现状说明；已提交内容通过 Git 历史追溯。

| 阅读目的 | 文档 |
| --- | --- |
| 了解产品与仓库 | [项目入口](../README.md) |
| 开发约束与统一 Agent 执行要求 | [项目工作规范](../AGENTS.md) |
| 启动开发、选择测试、准备验收 | [开发与测试](testing/development.md) |
| 理解业务、权限和系统边界 | [架构总览](architecture/overview.md) |
| 理解数据关系与迁移约束 | [数据模型](data-model.md) |
| 规划统一的 Skill、Agent 和运维对话入口 | [管理助手交互方案（前端待确认）](product/admin-assistant-plan.md) |
| 设计已有 Skill 的受控 Python 执行、依赖、权限与成果交付 | [Skill Python 脚本执行方案（待实施）](product/skill-python-execution-plan.md) |
| 了解当前对话安装能力及验收边界 | [对话安装实现](product/admin-skill-installation-implementation.md) |
| 规划 Skill ZIP 上传、管理助手安装及手工创建模式退出 | [Skill 安装产品方案与实施计划（待实施）](product/skill-installation-plan.md) |
| 规划团队工作空间功能、权限、页面入口与分批实施 | [团队工作空间产品方案与实施计划](product/team-workspace-plan.md) |
| 团队工作空间的批次拆分、现状核查与遗留清理 | [批次 4（空间用量）](product/team-workspace-batch-4-tasks.md)、[TW-09 现状核查](product/team-workspace-tw09-survey.md)、[遗留清理与工程卫生](product/team-workspace-cleanup-tasks.md) |
| 修改内部接口与事件 | [内部端口与契约](contracts/internal-ports.md) |
| 配置登录、员工目录和首位管理员 | [AI Hub 身份接入](deployment/ai-hub-sso-integration.md) |
| 安装、验证与升级执行内核 | [DSH Runtime](deployment/dsh-runtime-delivery.md) |
| 发布、首次安装、升级、备份、恢复及地址变更 | [Mac mini 部署手册](deployment/mac-mini-deployment-runbook.md) |

机器可读契约继续保留在 `contracts/`：

- [员工端 OpenAPI](contracts/openapi-workbench.json)
- [管理端 OpenAPI](contracts/openapi-admin.json)
- [Runtime Manifest Schema](contracts/runtime-manifest.schema.json)
- [Run Event Schema](contracts/run-event.schema.json)
- [合成测试数据](testing/fixtures/mvp-fixtures.json)

维护规则：

1. API 字段以可执行契约与测试为准，物理数据结构以 [SQL 迁移](../server/migrations/) 为准，内部类型以源码为准；文档解释边界，不复制完整实现。
2. 同一主题只维护一个入口；新决策直接更新对应文档，不另建重复方案、路线图或已完成清单。
3. 文档写可复现命令和验收条件；测试、CI、发布、远端部署和真实业务验收分别记录，不能互相替代。
4. 接口、配置、命令改变时同步更新文档和校验；过期说明从工作树删除，已提交历史由 Git 保存。
