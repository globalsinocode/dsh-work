# Skill 广场首批候选审批记录

- **批次**：`batch-01`
- **审批方式**：按 Cursor 计划「Skill 广场候选审批」（`batch-01`）全文批准（Implement the plan），等价于勾选计划「建议首批」全部条目。
- **审批日期**：2026-10-15
- **星数核对日期**：2026-10-15（GitHub API）

## 批准范围

### obra/superpowers（MIT，`bb92a77741419a4ab5f06e711a283343f1ada0c3`）

- writing-plans、executing-plans、systematic-debugging、test-driven-development
- requesting-code-review、receiving-code-review、verification-before-completion
- brainstorming、finishing-a-development-branch

### anthropics/skills（`dbd4588f9e1033efb41dad4bef2f7947c8993d44`）

- docx、pdf、pptx、xlsx、doc-coauthoring、internal-comms  
- **许可**：文档技能为 source-available；导入前已记录于 `SOURCE.json`。

### anthropics/knowledge-work-plugins（Apache-2.0，`e6b505348c39c6e751a70d52ff407e7b0a6bf676`）

- 显式：`productivity/skills/task-management`、`human-resources/skills/onboarding`
- 插件目录内全部 `skills/*/SKILL.md`：`finance`、`legal`、`product-management`、`operations`、`sales`、`customer-support`、`productivity`、`human-resources`
- **排除**：路径匹配外部连接器依赖（CRM、Slack、日历、收件箱同步等），见 `SOURCE.json` → `kwp.skipSkillNamePattern`

### infometa/workbuddyskills（无仓库许可证，`ccbc6809c9c10c0fdcd33c3eccd3a2424cdb926e`）

- deep-research、excalidraw-diagram、fbs-bookwriter（补充包，不替代高星来源）

## 发布约束

1. 仅通过既有 `parseSkillPackage` + 管理端安装链路保存 **待验证草稿**。
2. 含 Python 或 `needs_review` 兼容项：**不得**进入 `PUBLISH-ALLOWLIST.json` 直至人工试运行确认。
3. 本批次 **不** 自动发布到员工 Skill 广场。
