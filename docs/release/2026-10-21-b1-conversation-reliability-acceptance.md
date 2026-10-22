# Batch 1 会话与 Run 可靠性验收记录

- **迁移**：`0084_session_drafts.sql`
- **提交范围**：`dev` 工作区未单独打 tag；证据以本文件与 `main-flow-hardening-release-matrix.md` 为准
- **P0**：未在本机执行（vitest/vue 解析环境未就绪）
- **P1**：`team-workspace-sessions-api.integration.test.ts` 草稿隐藏用例待 `DSH_WORK_TEST_DATABASE_URL` 跑绿
- **P2**：未采集
- **回滚**：保留 0084；代码回滚后忽略 draft 行，不物理删除草稿 Session
