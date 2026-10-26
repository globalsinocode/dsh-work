# Batch 6 撤权收敛与发布验收记录（2026-10-21）

## 范围

- Finding F-21：管理端/员工端长会话在角色、停用或数据范围变化后收敛导航与身份摘要。
- 六批次证据矩阵模板（不修改 B1–B5 实现归属）。

## 身份与场景

| 项 | 计划覆盖 |
| --- | --- |
| 身份提供方 | `local-password`（P1 浏览器夹具）、`prototype-sso`（单元） |
| 管理端 | 移除 `admin:write` 等价角色后导航收敛；完全失权进入 `/forbidden` |
| 员工端 | 用户 data scope 收回后设置页摘要更新 |
| 请求重放 | 授权相关 403 不自动重试原写请求 |
| 路由 | 刷新后按 overview → audit → forbidden 顺序回落 |

## 证据状态（提交前占位）

| 层级 | 命令 | 状态 | 备注 |
| --- | --- | --- | --- |
| Unit / 前端 | `pnpm --filter @dsh-work/admin-web test` 等 | not-run | 由 CI/本地 Green 后填入 |
| Integration P1 | `pnpm test:m5:revocation:integration` | not-run | 需 `DSH_WORK_TEST_DATABASE_URL` |
| Browser P0 | `pnpm test:e2e` | not-run | 冒烟服务 |
| Browser P1 | `playwright.authorization-refresh.config.ts` | not-run | 独立 PostgreSQL 夹具 |
| Target P2 | 生产/OIDC 多账号 | not-run | 不在本批自动化范围 |

## 回滚

1. 原子回退含 B6 的前后端 Release（无迁移）。
2. 服务端授权保持 fail-closed；回滚仅恢复「不刷新 Session」的旧 UI 行为。
3. 回滚后验证：登录/登出、一条允许的管理页路由、无 `/login` ↔ `/forbidden` 循环。
4. 矩阵中 B6 行标记 rolled back；不改动 B1–B5 单元格。
