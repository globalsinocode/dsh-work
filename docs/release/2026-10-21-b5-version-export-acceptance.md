# Batch 5 不可变版本选择与导出验收记录

- **迁移**：无新增（复用既有版本与导出表）
- **单元**：`session-export-service.test.ts`、`conversation-export.test.ts`
- **OpenAPI**：`docs/development/openapi-workbench.json` 导出与会话端点需与实现同步复核
- **浏览器 P1**：`pnpm exec playwright test --config playwright.version-export.config.ts`（`VE-05`）
- **P2**：未采集
- **回滚**：导出为只读能力，回滚前端菜单即可；服务端导出接口可保留
