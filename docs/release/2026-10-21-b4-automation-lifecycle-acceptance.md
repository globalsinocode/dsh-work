# Batch 4 自动任务生命周期验收记录

- **迁移**：`0087_automation_archive_metadata.sql`
- **集成 P1**：`pnpm test:automation:integration`
- **浏览器 P1**：`e2e/automation.integration.spec.ts`（`AG-AUTO-20`–`24`，专用 `automation-workbench-browser` harness）
- **前端单元**：`apps/workbench-web/src/stores/automation-intents.test.ts`、`AutomationsView.test.ts`
- **P2**：未采集
- **回滚**：归档元数据列可保留；恢复逻辑回滚后仅影响归档展示
