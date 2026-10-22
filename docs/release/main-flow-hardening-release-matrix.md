# main 流程加固六批次发布证据矩阵

各批次独立记录 commit、迁移与测试证据。未实际执行的层级保持 `not-run`；未发布保持 `not-released`。

| Batch | Commit | Migration | Unit | Integration P1 | Browser P0 | Browser P1 | Target P2 | Release | Rollback checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | pending | 0084 | partial（server 单测；前端 vitest 受 node_modules 权限阻塞） | pass（`team-workspace-sessions-api` 10/10，含 CR-03） | not-run | partial（API：CR-01；UI：待 Vite 修复） | not-run | not-released | no |
| B2 | pending | 0085 | pass（`workspace-object-gc-service`） | not-run（shared-files 未在本轮全跑） | not-run | partial（API CW-04；UI CW-02 待 Vite） | not-run | not-released | no |
| B3 | pending | 0086（FK 已修） | pass（`workspace-notification-recipient-service`） | not-run（activity 未全跑） | not-run | partial（API NT-01） | not-run | not-released | no |
| B4 | pending | 0087 | partial | pass（`automation.integration` 20/20） | not-run | partial（AU-01 用例已加；待 automation harness E2E） | not-run | not-released | no |
| B5 | pending | none | pass（`session-export-service`） | not-run | not-run | not-run（VE-05 需 Vite） | not-run | not-released | no |
| B6 | pending | none | partial（`authorization-change` 单测） | not-run | not-run | partial（AR-01/02/03 已编写；待 local-auth harness） | not-run | not-released | no |

**环境（2026-10-22 晚）**：Docker `deploy/compose.yaml` Postgres `@127.0.0.1:5434`；`DSH_WORK_TEST_DATABASE_URL=postgres://dsh_work:change-me@127.0.0.1:5434/postgres`。`dev` 仍落后 `origin/dev` 1 提交（`4570060` 名册修复已手工合入）。`pnpm install` 因 `node_modules` EACCES 未完成，P1 浏览器 UI 套件暂无法起 Vite。

**API P1 门禁**：`corepack pnpm exec playwright test --config playwright.main-flow-hardening-api.config.ts`（仅 harness + API 用例）。

## 401/403 客户端刷新码（B6）

管理端与员工端在收到下列 **403** `error.code` 时合并触发一次 `/session` 刷新，**不会**自动重放失败请求：`authorization_denied`、`permission_revoked`、`role_disabled`、`data_scope_revoked`。
