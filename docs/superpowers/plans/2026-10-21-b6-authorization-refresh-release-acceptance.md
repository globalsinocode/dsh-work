# Batch 6 Authorization Refresh and Release Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make open admin/employee clients converge promptly after role or data-scope revocation without replaying writes or entering redirect loops, and provide one evidence matrix that keeps all six releases independently auditable.

**Architecture:** Add concurrency-coalesced identity refresh to each portal Store, trigger it on visibility, protected route entry and authorization-related 403 responses, then recompute navigation from the refreshed Session. API calls remain fail-closed and are never automatically replayed; the release matrix records evidence without changing other batches’ implementation ownership.

**Tech Stack:** Vue 3, Pinia, Vue Router, TypeScript fetch clients, Vitest, PostgreSQL revocation integration tests, Playwright multi-context tests, pnpm, Markdown release evidence.

---

## Scope and ownership

- Finding: F-21, plus cross-batch release evidence orchestration only.
- Branch: `codex/hardening-b6-auth-acceptance`.
- No database migration.
- Do not implement fixes owned by Batches 1–5; matrix cells stay `not-run` until their owning release provides evidence.

## File map

- Modify `apps/admin-web/src/stores/auth.ts`, `auth.test.ts`, API client, router and App/shell navigation.
- Modify `apps/workbench-web/src/stores/auth.ts`, EmployeeShell/router/API client and tests.
- Create shared per-app authorization-change handler modules; do not share authentication Store across portals.
- Extend server authorization errors only if a stable safe reason code is missing; do not weaken 403 checks.
- Extend revocation integration and add dedicated multi-context browser suite.
- Create `docs/release/main-flow-hardening-release-matrix.md` and Batch 6 acceptance record.

### Task 1: Specify revocation and release-evidence journeys

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add `AR-01` through `AR-05`**

```markdown
| AR-01 | P1 | admin | 管理角色被撤销 | 页面已打开 | 另一管理员撤权；回到窗口 | 导航/按钮收敛到当前权限，不重放失败写请求 |
| AR-02 | P1 | admin | 完全失去后台访问权 | 已在管理路由 | 停用角色；进入下一路由 | 进入无权限页，不循环登录 |
| AR-03 | P1 | employee | 数据范围被收回 | 工作台已打开 | 管理员收回 scope；窗口恢复可见 | 身份摘要和相关入口更新，服务端继续 403 |
| AR-04 | P1 | admin | 并发 403 合并刷新 | 三个请求同时 403 | 等待页面处理 | 只发一次 /session 刷新，三个原请求都不自动重放 |
| AR-05 | release | operator | 六批次证据隔离 | 任一批单独发布 | 填写矩阵 | 只更新该批状态，未运行批次保持 not-run |
```

- [ ] **Step 2: Validate and commit catalog**

Run: `pnpm verify project`

Expected: PASS.

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify authorization refresh journeys"
```

### Task 2: Add concurrency-coalesced admin identity refresh

**Files:**
- Modify: `apps/admin-web/src/stores/auth.ts`
- Modify: `apps/admin-web/src/stores/auth.test.ts`

- [ ] **Step 1: Write failing refresh tests**

```ts
it('coalesces concurrent refresh calls and replaces permissions', async () => {
  let resolve!: (value: AdminSession) => void
  api.getSession.mockReturnValue(new Promise(value => { resolve = value }))
  const store = useAuthStore()
  const first = store.refresh()
  const second = store.refresh()
  expect(api.getSession).toHaveBeenCalledTimes(1)
  resolve({
    user,
    permissions: ['audit:read'],
    identityProvider: 'local-password',
    apiAudience: 'admin',
  })
  await Promise.all([first, second])
  expect(store.permissions).toEqual(['audit:read'])
})

it('clears access when refreshed Session is no longer authorized', async () => {
  api.getSession.mockRejectedValue(new AdminApiError({}, 403, 'forbidden'))
  const store = useAuthStore()
  await expect(store.refresh()).rejects.toBeDefined()
  expect(store.canAccessAdmin).toBe(false)
})
```

- [ ] **Step 2: Run auth Store tests**

Run: `pnpm --filter @dsh-work/admin-web test -- src/stores/auth.test.ts`

Expected: FAIL because `load()` short-circuits and no refresh exists.

- [ ] **Step 3: Implement `refresh()` and redefine `load()`**

```ts
async function refresh(): Promise<void> {
  if (pendingLoad) return pendingLoad
  pendingLoad = fetchAndApplySession()
  try { await pendingLoad } finally { pendingLoad = undefined }
}

async function load(): Promise<void> {
  if (initialized.value) return
  await refresh()
}
```

`fetchAndApplySession` atomically replaces user/provider/permissions. A 401 clears state and lets the API redirect; an authorization-loss 403 clears permissions without fabricating logout.

- [ ] **Step 4: Run Store tests and commit**

Run: `pnpm --filter @dsh-work/admin-web test -- src/stores/auth.test.ts`

Expected: PASS.

```bash
git add apps/admin-web/src/stores/auth.ts apps/admin-web/src/stores/auth.test.ts
git commit -m "feat: refresh admin authorization state"
```

### Task 3: React to authorization-related 403 without replaying requests

**Files:**
- Create: `apps/admin-web/src/utils/authorization-change.ts`
- Create: `apps/admin-web/src/utils/authorization-change.test.ts`
- Modify: `apps/admin-web/src/api/client.ts`
- Modify: `apps/admin-web/src/App.vue`

- [ ] **Step 1: Write failing handler tests**

```ts
it('coalesces refresh notification and never invokes the failed request again', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const replay = vi.fn()
  const handler = createAuthorizationChangeHandler(refresh)
  await Promise.all([
    handler(new AdminApiError({ code: 'authorization_denied' }, 403, 'denied')),
    handler(new AdminApiError({ code: 'authorization_denied' }, 403, 'denied')),
  ])
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(replay).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run utility test**

Run: `pnpm --filter @dsh-work/admin-web test -- authorization-change.test.ts`

Expected: FAIL because the handler does not exist.

- [ ] **Step 3: Implement an event hook, not automatic retry**

```ts
export type AuthorizationChangeListener = (error: AdminApiError) => void
export function setAuthorizationChangeListener(listener: AuthorizationChangeListener | null): void
```

The API client calls the listener after parsing a 403 whose code is `authorization_denied`, `permission_revoked`, `role_disabled` or `data_scope_revoked`, then throws the original error. It never reissues the request.

- [ ] **Step 4: Register listener in App lifecycle**

App sets a listener that calls `authStore.refresh()` through a coalesced handler and unsets it on unmount. Show one neutral “权限已更新” message after state changes, not one per failed request.

- [ ] **Step 5: Run admin tests and commit**

Run: `pnpm --filter @dsh-work/admin-web test`

Expected: PASS.

```bash
git add apps/admin-web/src/utils/authorization-change.ts apps/admin-web/src/utils/authorization-change.test.ts apps/admin-web/src/api/client.ts apps/admin-web/src/App.vue
git commit -m "fix: converge admin UI after authorization changes"
```

### Task 4: Re-evaluate protected routes and navigation

**Files:**
- Modify: `apps/admin-web/src/router/index.ts`
- Modify: `apps/admin-web/src/router/index.test.ts`
- Modify: `apps/admin-web/src/App.vue`
- Modify: `apps/admin-web/src/App.test.ts`

- [ ] **Step 1: Add failing route tests**

```ts
it('refreshes before protected navigation and redirects to the first allowed page', async () => {
  auth.refresh.mockResolvedValue(undefined)
  auth.canManage = false
  auth.canReadAudit = true
  const result = await guard({ path: '/identity', meta: { permission: 'admin:*' } } as RouteLocationNormalized)
  expect(auth.refresh).toHaveBeenCalledTimes(1)
  expect(result).toEqual({ name: 'audit' })
})

it('uses the existing forbidden route when no admin permission remains', async () => {
  auth.canAccessAdmin = false
  expect(await guard(protectedRoute)).toEqual({ name: 'forbidden' })
})
```

- [ ] **Step 2: Run router tests**

Run: `pnpm --filter @dsh-work/admin-web test -- src/router/index.test.ts`

Expected: FAIL because guard trusts initialized cache.

- [ ] **Step 3: Implement bounded route refresh**

Refresh at most once per navigation; compute a deterministic fallback order (`overview`, `audit`, then the existing `forbidden` route) from current permissions. Keep `AccessDeniedView.vue` as the authenticated no-access destination and do not introduce a second denial route.

- [ ] **Step 4: Add visibility refresh**

Register one `visibilitychange` listener in App/shell. When visible and initialized, call `refresh`; do not poll continuously. Remove listener on unmount.

- [ ] **Step 5: Run admin tests and commit**

Run: `pnpm --filter @dsh-work/admin-web test`

Expected: PASS with no navigation loop or listener leak.

```bash
git add apps/admin-web/src/router/index.ts apps/admin-web/src/router/index.test.ts apps/admin-web/src/App.vue apps/admin-web/src/App.test.ts
git commit -m "fix: reroute revoked admin sessions safely"
```

### Task 5: Apply the same refresh principle to Workbench identity

**Files:**
- Modify: `apps/workbench-web/src/stores/auth.ts`
- Create: `apps/workbench-web/src/stores/auth.test.ts`
- Create: `apps/workbench-web/src/utils/authorization-change.ts`
- Create: `apps/workbench-web/src/utils/authorization-change.test.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Modify: `apps/workbench-web/src/layouts/EmployeeShell.vue`

- [ ] **Step 1: Write failing employee refresh tests**

```ts
it('refreshes role and dataScopes after visibility returns', async () => {
  api.getSession.mockResolvedValueOnce(oldSession).mockResolvedValueOnce({
    ...oldSession, user: { ...oldSession.user, dataScopes: [] },
  })
  const store = useAuthStore()
  await store.load()
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(store.user.dataScopes).toEqual([]))
})
```

- [ ] **Step 2: Run Workbench auth tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- auth.test.ts authorization-change.test.ts`

Expected: FAIL because Workbench auth also short-circuits after initialization.

- [ ] **Step 3: Implement separate Workbench refresh/hook**

Mirror concurrency semantics, not Store code sharing. On authorization-related 403 call `refresh` and throw the original request error. EmployeeShell visibility refresh updates identity-dependent controls/content reset only when user ID changes; role/scope changes update computed UI without destroying unrelated cached data.

- [ ] **Step 4: Run Workbench tests and commit**

Run: `pnpm --filter @dsh-work/workbench-web test`

Expected: PASS.

```bash
git add apps/workbench-web/src/stores/auth.ts apps/workbench-web/src/stores/auth.test.ts apps/workbench-web/src/utils/authorization-change.ts apps/workbench-web/src/utils/authorization-change.test.ts apps/workbench-web/src/api/client.ts apps/workbench-web/src/layouts/EmployeeShell.vue
git commit -m "fix: refresh workbench identity after revocation"
```

### Task 6: Verify server error codes and revocation behavior

**Files:**
- Modify: `server/src/domain/authorization-errors.ts`
- Modify: `server/src/http/router.ts`
- Modify: `server/src/infrastructure/postgres/m5-revocation-pipeline.integration.test.ts`
- Modify: `server/src/http/router-error-experience.test.ts`

- [ ] **Step 1: Add stable-code assertions**

For role removal, role disable and data-scope removal, assert HTTP 403 with safe `error.code` in the approved set and no permission details/SQL/user IDs in message/suggestion.

- [ ] **Step 2: Run revocation/router tests**

Run: `pnpm test:m5:revocation:integration && pnpm test:unit src/http/router-error-experience.test.ts`

Expected: FAIL because the approved revocation-code set is not enforced as one closed mapping.

- [ ] **Step 3: Normalize only missing codes**

Map authorization exceptions through one closed function to `authorization_denied`, `permission_revoked`, `role_disabled`, `data_scope_revoked`. Do not expose role names, scope values or object existence. Existing callers that only know `authorization_denied` remain compatible.

- [ ] **Step 4: Re-run and commit**

Run: `pnpm test:m5:revocation:integration && pnpm test:unit src/http/router-error-experience.test.ts`

Expected: PASS.

```bash
git add server/src/domain/authorization-errors.ts server/src/http/router.ts server/src/infrastructure/postgres/m5-revocation-pipeline.integration.test.ts server/src/http/router-error-experience.test.ts
git commit -m "test: stabilize authorization revocation responses"
```

### Task 7: Add multi-context browser revocation coverage

**Files:**
- Create: `e2e/authorization-refresh.integration.spec.ts`
- Create: `playwright.authorization-refresh.config.ts`

- [ ] **Step 1: Implement admin revocation journey**

Use separate administrator contexts: admin A keeps `/identity` open; admin B revokes A. Trigger one write from A, assert one 403, no duplicate network write, one Session refresh, navigation to the first allowed page/access denied, and hidden write controls.

- [ ] **Step 2: Implement employee scope journey**

Keep employee page open; revoke scope through admin fixture; restore window visibility; assert identity/settings and capability UI update while direct protected API remains 403.

- [ ] **Step 3: Run dedicated P1**

Run: `pnpm exec playwright test --config playwright.authorization-refresh.config.ts`

Expected: PASS with disposable PostgreSQL and independent browser contexts.

- [ ] **Step 4: Commit E2E**

```bash
git add e2e/authorization-refresh.integration.spec.ts playwright.authorization-refresh.config.ts
git commit -m "test: cover live authorization revocation"
```

### Task 8: Create the six-release evidence matrix

**Files:**
- Create: `docs/release/main-flow-hardening-release-matrix.md`
- Create: `docs/release/2026-10-21-b6-auth-acceptance.md`
- Modify: `docs/development/main-flow-breakpoint-target-questions-2026-10-21.md`

- [ ] **Step 1: Create matrix with explicit non-success defaults**

```markdown
| Batch | Commit | Migration | Unit | Integration P1 | Browser P0 | Browser P1 | Target P2 | Release | Rollback checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | not-recorded | 0084 planned | not-run | not-run | not-run | not-run | not-run | not-released | no |
| B2 | not-recorded | 0085 planned | not-run | not-run | not-run | not-run | not-run | not-released | no |
| B3 | not-recorded | 0086 planned | not-run | not-run | not-run | not-run | not-run | not-released | no |
| B4 | not-recorded | 0087 planned | not-run | not-run | not-run | not-run | not-run | not-released | no |
| B5 | not-recorded | none | not-run | not-run | not-run | not-run | not-run | not-released | no |
| B6 | current-branch | none | not-run | not-run | not-run | not-run | not-run | not-released | no |
```

No cell may say passed/released without command output or target evidence linked nearby.

- [ ] **Step 2: Add target-machine authorization questions**

Add read-only counts for authorization-related 403, repeated 403 per open page, Session refresh requests and redirect loops; do not request production mutations.

- [ ] **Step 3: Record Batch 6 focused evidence fields**

Acceptance doc includes exact commit, identity providers tested, role/scope cases, request replay count, router outcome, P0/P1/P2 status and rollback steps.

- [ ] **Step 4: Commit release documentation**

```bash
git add docs/release/main-flow-hardening-release-matrix.md docs/release/2026-10-21-b6-auth-acceptance.md docs/development/main-flow-breakpoint-target-questions-2026-10-21.md
git commit -m "docs: add independent hardening release matrix"
```

### Task 9: Verify and package Batch 6 independently

**Files:**
- Modify: `docs/development/openapi-admin.json`
- Modify: `docs/development/openapi-workbench.json`

- [ ] **Step 1: Run focused tests**

Run: `pnpm test:m5:revocation:integration && pnpm --filter @dsh-work/admin-web test && pnpm --filter @dsh-work/workbench-web test`

Expected: PASS.

- [ ] **Step 2: Run repository gates**

Run: `pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build`

Expected: all exit 0.

- [ ] **Step 3: Run P0 and dedicated P1**

Run: `pnpm test:e2e && pnpm exec playwright test --config playwright.authorization-refresh.config.ts`

Expected: PASS, recorded separately in the matrix.

- [ ] **Step 4: Document the closed 401/403 code set and commit evidence**

```bash
git add docs/development/openapi-admin.json docs/development/openapi-workbench.json docs/release/main-flow-hardening-release-matrix.md docs/release/2026-10-21-b6-auth-acceptance.md
git commit -m "docs: record batch 6 authorization acceptance"
```

## Independent rollback

1. Atomically restore prior admin/workbench/API Release; no migration rollback exists.
2. Server authorization remained fail-closed throughout, so rollback only restores stale-control behavior, not access.
3. Verify login/logout and one permitted admin page; ensure no redirect loop.
4. Keep the evidence matrix factual: mark Batch 6 rolled back and do not alter other batches’ states.
