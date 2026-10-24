# 文档导航

`docs/` 只保留对后续开发和上线仍有约束或参考价值的文档，分四类：`index`、`development`（架构、规范、契约与开发测试）、`design`（数据模型和进行中的方案）、`release`（身份接入、Runtime 与部署）。已完成的批次记录、交接快照、评审证据、一次性人工验收清单和已并入规范的实施方案不在工作树中保留，需要时从 Git 历史查阅。

| 阅读目的 | 文档 |
| --- | --- |
| 了解产品与仓库 | [项目入口](../../README.md) |
| 开发约束与统一 Agent 执行要求 | [项目工作规范](../../AGENTS.md) |
| 启动开发、选择测试、准备验收 | [开发与测试](../development/development.md) |
| 理解业务、权限、系统边界和未完成事项 | [架构总览](../development/overview.md) |
| 修改模块接口与事件 | [内部端口与契约](../development/internal-ports.md) |
| 理解数据关系与迁移约束 | [数据模型](../design/data-model.md) |
| 项目空间、个人内容、管理助手、Skill、定时任务、验证发布等产品与安全规则 | [功能规则](../development/feature-rules.md) |
| 设计和评审 Agent，区分现行规则与扩展门槛 | [Agent 设计规范](../development/agent-design-standard.md) |
| 按统一阶段定义、发布、运行和退役 Agent | [通用 Agent 全生命周期模板](../development/agent-lifecycle-template.md) |
| 移动端 H5 接入 | [移动端接入规范](../development/mobile-integration-guide.md) |
| 平台基线真实验收（PF-07） | [PF-07 验收手册](../development/pf07-platform-acceptance.md) |
| 进行中：执行观测、上下文延续与性能 | [Runtime 执行架构渐进优化方案](../design/runtime-execution-optimization-plan.md) |
| 项目空间产品决策与切片背景（S0～S6 已实现；现行规则以功能规则为准，P2/OIDC 与部分 P1 旅程仍开放） | [项目空间方案](../design/project-space-plan.md) |
| 独立账号登录 | [独立登录](../release/local-authentication.md) |
| 配置 AI Hub 登录、员工目录和首位管理员 | [AI Hub 身份接入](../release/ai-hub-sso-integration.md) |
| 安装、验证与升级执行内核 | [DSH Runtime](../release/dsh-runtime-delivery.md) |
| 发布、首次安装、升级、备份、恢复及地址变更 | [Mac mini 部署手册](../release/mac-mini-deployment-runbook.md) |

浏览器验收目录见 [e2e/TEST-CATALOG.md](../../e2e/TEST-CATALOG.md)。某次跑测结果放 PR/发布说明或仓库外证据，见 [verification-log 约定](../../e2e/catalog/verification-log.md)。

机器可读契约与测试夹具放在 `development/`：

- [员工端 OpenAPI](../development/openapi-workbench.json)、[管理端 OpenAPI](../development/openapi-admin.json)、[认证 OpenAPI](../development/openapi-auth.json)、[移动端 OpenAPI](../development/openapi-mobile-h5.json)
- [Runtime Manifest Schema](../development/runtime-manifest.schema.json)、[Run Event Schema](../development/run-event.schema.json)
- [平台能力矩阵](../development/agent-platform-capabilities.v1.json)
- [通用参考 Agent 包](../development/fixtures/reference-text-agent/agent.yaml)、[合成测试数据](../development/fixtures/mvp-fixtures.json)

维护规则：

1. API 字段以可执行契约与测试为准，物理数据结构以 [SQL 迁移](../../server/migrations/) 为准，内部类型以源码为准；文档解释边界和规则，不复制完整实现。
2. 同一主题只维护一个入口；新决策直接更新对应文档，不另建重复方案、路线图或已完成清单。
3. 方案全部交付后，把仍有效的规则并入[功能规则](../development/feature-rules.md)或架构文档，然后删除方案；交付记录、评审证据和一次性核查不进工作树。
4. 文档写可复现命令和验收条件；测试、CI、发布、远端部署和真实业务验收分别记录，不能互相替代。
5. 接口、配置、命令改变时同步更新文档和校验；过期说明直接删除，已提交历史由 Git 保存。
