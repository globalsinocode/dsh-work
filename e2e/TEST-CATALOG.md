# 团队工作空间 E2E 验收目录

这里记录面向用户的关键旅程。测试代码在页面交互稳定、通过浏览器预演后再固化；本目录中的“通过”必须注明运行层级，不能把 P0 冒烟当成真实 DSH、OIDC 或生产权限验收。

## 环境与证据层级

| 层级 | 环境 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| P0 | 测试专用冒烟服务（测试身份、内存合成数据）、Playwright Chromium | 页面启动、路由、核心展示与基本交互 | PostgreSQL 持久化、真实 DSH、OIDC、多账号授权 |
| P1 | 专用可丢弃 PostgreSQL、受控测试身份与 Runtime/Worker | 团队空间读写、版本、失败和权限契约 | 生产身份、企业连接器和生产容量 |
| P2 | 真实 DSH Run/Attempt、Runtime Adapter、OIDC 与多账号 | 真实执行、收权和目标环境验收 | 未实际执行的环境或未覆盖的角色 |

## 写法

- 实现前先在对应分册登记关键用户旅程（AGENTS.md 的 Spec 步骤）；新领域没有合适分册时新建分册并在下表登记。
- 每条至少写明优先级、用户角色、运行层级、前置数据、操作步骤、可观察结果及对应 spec 文件；验收标准用业务语言，不预设尚未成型的 DOM 选择器。
- 条目 ID 全局唯一，标题行以 `### <ID> <名称>` 开头，便于按 ID 检索。
- 每次实施的运行结果写进 PR/发布说明或仓库外受控证据，不写进旅程条目；[验证记录](catalog/verification-log.md)仅说明留证约定，不堆积长文。

## 分册

| 分册 | 范围 | 条目 |
| --- | --- | --- |
| [个人工作台](catalog/workbench.md) | 对话、成果、结果核验、Skill 广场与 AI 同事目录、跨轮成果延续。 | `ART-E2E-01`、`I06-E2E-01`、`I06-E2E-02`、`EMP-CATALOG-01`、`EX-TOOL-01`、`EX-ARTIFACT-01`、`EX-ARTIFACT-02`、`EX-ARTIFACT-03`、`EX-ARTIFACT-04`、`EX-ARTIFACT-05`、`EX-ARTIFACT-06`、`EX-ARTIFACT-07`、`EX-SHELL-01`、`EX-SHELL-02`、`EX-CONTEXT-01` |
| [项目空间](catalog/project-space.md) | 团队空间导航与共享讨论、项目空间 S0–S4、Agent 维护项目任务（S6）。 | `TW-E2E-01`、`TW-E2E-10`、`TW-E2E-11`、`PS-E2E-00`、`PS-E2E-01`、`PS-E2E-02`、`PS-E2E-03`、`PS-E2E-04`、`PS-E2E-05`、`PS-E2E-06`、`PS-E2E-07`、`PS-E2E-08`、`PS-S6-01`、`PS-S6-P2` |
| [员工端双模式（S5）](catalog/collab-mode.md) | A 工作模式与 B 协作模式：模式切换、协作壳层、对话列表、单聊、群聊、群组与成员选择。 | `MODE-E2E-01`、`MODE-E2E-02`、`MODE-E2E-03`、`MODE-E2E-04`、`MODE-API-01`、`MODE-E2E-05`、`MODE-E2E-06`、`MODE-E2E-07`、`MODE-E2E-08`、`MODE-API-02`、`MODE-E2E-09`、`MODE-E2E-10`、`MODE-E2E-11`、`MODE-E2E-12`、`MODE-E2E-14`、`MODE-E2E-15`、`MODE-E2E-13`、`MODE-API-03` |
| [Agent](catalog/agents.md) | Agent 定义与能力、详情与发布、岗位权限、轻量自动任务、经验迭代与主动记忆。 | `AG-SOUL-P0`、`AG-CAP-P0`、`AG-DETAIL-01`、`AG-DETAIL-02`、`AG-CAP-P1`、`AG-CAP-P2`、`AE-02`、`AG-SOUL-01`、`AG-REL-01`、`AG-PROTO-02`、`AG-REL-02`、`AG-AUTO-00`、`AG-AUTO-20`、`AG-AUTO-21`、`AG-AUTO-22`、`AG-AUTO-23`、`AG-AUTO-24`、`AG-AUTO-P2`、`EXPERIENCE-ITERATION-01`、`MEMORY-EMPLOYEE-REMOVAL`、`PF-MEMORY-01`、`PF-MEMORY-P2`、`AE-MEMORY-01` |
| [管理端与平台](catalog/admin-platform.md) | 冒烟环境、登录与身份、管理端、内置工具与操作计划、开发接入文档、MCP、持久化等待与审批。 | `E2E-ENV-01`、`TW-E2E-02`、`ADMIN-E2E-03`、`LOCAL-AUTH-P1`、`LOGIN-ENTRY-P1`、`LOGIN-OPTIONS-P1`、`ADMIN-E2E-01`、`ADMIN-E2E-05`、`ADMIN-E2E-02`、`ADMIN-E2E-04`、`C7`、`PF-MCP-01`、`PF-MCP-P2`、`PF-WAIT-01`、`PF-WAIT-P2` |
| [验证记录](catalog/verification-log.md) | 留证约定（非验收标准）；不在工作树堆积某次跑测长文。 | — |
