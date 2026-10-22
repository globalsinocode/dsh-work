# Batch 2 文件与工作空间契约验收记录

- **迁移**：`0085_workspace_object_gc.sql`
- **单元**：`workspace-object-gc-service.test.ts`（经 `pnpm --filter @dsh-work/server test:unit` 路径执行）
- **集成 P1**：`pnpm test:m5:shared-files:integration`、`pnpm test:m5:file-versions:integration`（需 `DSH_WORK_TEST_DATABASE_URL`）
- **浏览器 P1**：`pnpm exec playwright test --config playwright.content-workspace.config.ts`（`CW-02`）
- **P2**：未采集
- **回滚**：保留 0085；停用 GC 作业前确认无积压删除队列
