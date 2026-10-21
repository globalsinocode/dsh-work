# Batch 2 Content and Workspace Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make team file writes compensatable and truthfully projected, replace the fake reference command with a real authorized picker, enforce viewer capabilities in the UI, and decouple/paginate workspace reads.

**Architecture:** Keep immutable content-addressed objects and PostgreSQL metadata. Prevalidate before object writes, journal unavoidable post-write failures as GC candidates, and delete only after a grace period plus a database no-reference proof. Serve one canonical file projection from all write/read endpoints and split frontend stores by read model.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, local ObjectStorage port, Vue 3, Pinia, Element Plus, Vitest, Node test runner, Playwright, pnpm.

---

## Scope and ownership

- Findings: F-02, F-03, F-04, F-05, F-08, F-10, F-13.
- Integration branch: `dev`; start from the latest `dev` and land Batch 2 as a continuous, self-contained commit range after its Green gate passes.
- Reserved migration: `server/migrations/0085_workspace_object_gc.sql`; renumber only if occupied.
- Do not change notifications, Session/Run execution, automation lifecycle, version selection, exports, or auth refresh.

## File map

- Create `server/migrations/0085_workspace_object_gc.sql`.
- Create `server/src/modules/workbench/application/workspace-object-gc-service.ts` and test.
- Modify `server/src/domain/object-storage.ts` and `server/src/infrastructure/storage/local-object-storage.ts` to support safe key deletion.
- Modify `server/src/modules/workbench/application/postgres-content-service.ts` for prevalidation, candidate journaling and canonical projection.
- Modify `server/src/http/workbench/content-routes.ts`, `server/src/domain/types.ts`, `docs/development/openapi-workbench.json`.
- Create `apps/workbench-web/src/components/WorkspaceFilePickerDialog.vue` and test.
- Modify `packages/workbench-components/src/TaskComposer.vue` and its test.
- Modify `apps/workbench-web/src/stores/content.ts`, `apps/workbench-web/src/views/WorkspacesView.vue`, `WorkspaceDetailView.vue`, API/types/tests.
- Test existing shared-file/version integration suites and add `e2e/content-workspace-contracts.integration.spec.ts`.

### Task 1: Specify file and workspace journeys

**Files:**
- Modify: `e2e/TEST-CATALOG.md`

- [ ] **Step 1: Add P1/P2 cases `CW-01` through `CW-07`**

```markdown
| CW-01 | P1 | team member | 无效 logicalFileId 上传新版本 | 可丢弃存储与数据库 | 上传到不存在文件 | 请求失败；对象被记录为候选且最终无孤儿 |
| CW-02 | P1 | team member | 团队文件真实引用 | 当前空间有可引用文件 | 输入框选择文件并发送 | 请求携带 logicalFileId，刷新前后行为一致 |
| CW-03 | P1 | team member | 解析失败仍显示文件事实 | 合成解析失败文件 | 首次上传 | 列表出现 failed 行和安全错误；不生成重复 logical file |
| CW-04 | P1 | viewer | 上传能力门控 | viewer 身份 | 打开空间 Files | 不显示上传入口；伪造请求仍 403 |
| CW-05 | P1 | employee | 局部读取失败 | /artifacts 返回 503，/workspaces 成功 | 进入团队空间 | 空间仍显示，成果模块独立报错 |
| CW-06 | P1 | team member | 成功上传即时引用 | 可解析文件 | 上传后不刷新 | 立即出现引用按钮并可选择 |
| CW-07 | P1 | employee | 大文件列表分页 | 单空间超过一页文件 | 滚动/加载更多 | 空间首页响应不携带全量文件，详情不重不漏 |
```

- [ ] **Step 2: Validate catalog**

Run: `pnpm verify project`

Expected: PASS.

- [ ] **Step 3: Commit spec**

```bash
git add e2e/TEST-CATALOG.md
git commit -m "test: specify content and workspace contract journeys"
```

### Task 2: Add safe object deletion and GC candidate persistence

**Files:**
- Create: `server/migrations/0085_workspace_object_gc.sql`
- Modify: `server/src/domain/object-storage.ts`
- Modify: `server/src/infrastructure/storage/local-object-storage.ts`
- Modify: `server/src/infrastructure/storage/local-object-storage.test.ts`

- [ ] **Step 1: Write a failing storage deletion test**

```ts
test('deleteIfExists removes only the exact validated object key', async () => {
  await store.putIfAbsent('workspace-files/a/object.bin', Buffer.from('x'))
  assert.equal(await store.deleteIfExists('workspace-files/a/object.bin'), true)
  assert.equal(await store.deleteIfExists('workspace-files/a/object.bin'), false)
  await assert.rejects(store.deleteIfExists('../outside'), /非法存储键/)
})
```

- [ ] **Step 2: Run the storage test**

Run: `pnpm test:unit src/infrastructure/storage/local-object-storage.test.ts`

Expected: FAIL because `deleteIfExists` is absent.

- [ ] **Step 3: Extend the port and local adapter**

```ts
export interface ObjectStorage {
  putIfAbsent(key: string, bytes: Uint8Array): Promise<void>
  read(key: string): Promise<Uint8Array>
  deleteIfExists(key: string): Promise<boolean>
}
```

Use the same validated root containment function as reads/writes. Implement deletion with `rm(path, { force: true })`, return whether the file existed, and never accept absolute/traversal keys.

- [ ] **Step 4: Add the GC table**

```sql
create table workspace_object_gc_candidates (
  tenant_id text not null,
  storage_key text not null,
  object_sha256 text not null,
  reason_code text not null,
  not_before timestamptz not null,
  status text not null default 'pending' check (status in ('pending','deleted','retained','failed')),
  attempts integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, storage_key)
);
create index workspace_object_gc_due_idx
  on workspace_object_gc_candidates (tenant_id, not_before)
  where status in ('pending','failed');
```

- [ ] **Step 5: Run storage tests and migration verification**

Run: `pnpm test:unit src/infrastructure/storage/local-object-storage.test.ts && pnpm verify contracts`

Expected: PASS.

- [ ] **Step 6: Commit storage primitives**

```bash
git add server/migrations/0085_workspace_object_gc.sql server/src/domain/object-storage.ts server/src/infrastructure/storage/local-object-storage.ts server/src/infrastructure/storage/local-object-storage.test.ts
git commit -m "feat: journal and delete unreferenced workspace objects"
```

### Task 3: Implement GC candidate creation and sweep

**Files:**
- Create: `server/src/modules/workbench/application/workspace-object-gc-service.ts`
- Create: `server/src/modules/workbench/application/workspace-object-gc-service.test.ts`
- Modify: `server/src/modules/workbench/application/postgres-content-service.ts`
- Modify: `server/src/main.ts`

- [ ] **Step 1: Write failing service tests**

```ts
test('sweep deletes a due candidate only when no metadata row references the key', async () => {
  repository.listDue.mockResolvedValue([{ storageKey: 'workspace-files/a.bin', attempts: 0 }])
  repository.isReferenced.mockResolvedValue(false)
  storage.deleteIfExists.mockResolvedValue(true)
  await service.sweep(10)
  assert.equal(storage.deleteIfExists.mock.callCount(), 1)
  assert.equal(repository.markDeleted.mock.callCount(), 1)
})

test('sweep retains a candidate that became referenced', async () => {
  repository.listDue.mockResolvedValue([{ storageKey: 'workspace-files/a.bin', attempts: 0 }])
  repository.isReferenced.mockResolvedValue(true)
  await service.sweep(10)
  assert.equal(storage.deleteIfExists.mock.callCount(), 0)
  assert.equal(repository.markRetained.mock.callCount(), 1)
})
```

- [ ] **Step 2: Run the unit test**

Run: `pnpm test:unit src/modules/workbench/application/workspace-object-gc-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service contract**

```ts
export class WorkspaceObjectGcService {
  async record(input: { storageKey: string; objectSha256: string; reasonCode: string; notBefore: Date }): Promise<void>
  async sweep(limit = 100): Promise<{ deleted: number; retained: number; failed: number }>
}
```

`isReferenced` must check `file_objects.storage_key` and every other object metadata table used by content/artifacts. The sweep claims rows with `for update skip locked`, increments attempts, stores only a safe error code, and never logs the key at info/error level.

- [ ] **Step 4: Prevalidate and journal failed writes**

In `uploadWorkspaceFileVersion`, query/authorize the active logical file before `prepareObjectWrite`; keep the transaction recheck. Wrap the post-write transaction so any failure records all newly introduced storage keys with a 24-hour grace period. Do not delete synchronously.

- [ ] **Step 5: Register a bounded background sweep**

In `server/src/main.ts`, start one interval after database/storage readiness, execute at most 100 candidates per minute, call `unref()`, and clear it during graceful shutdown. GC failure logs a safe aggregate code/count only.

- [ ] **Step 6: Run unit and shared-file integration tests**

Run: `pnpm test:unit src/modules/workbench/application/workspace-object-gc-service.test.ts && pnpm test:m5:shared-files:integration && pnpm test:m5:file-versions:integration`

Expected: PASS; invalid IDs create no immediate untracked deletion and due unreferenced candidates converge safely.

- [ ] **Step 7: Commit GC service**

```bash
git add server/src/modules/workbench/application/workspace-object-gc-service.ts server/src/modules/workbench/application/workspace-object-gc-service.test.ts server/src/modules/workbench/application/postgres-content-service.ts server/src/main.ts
git commit -m "fix: compensate failed workspace object writes"
```

### Task 4: Return one canonical file projection from writes and reads

**Files:**
- Modify: `server/src/modules/workbench/application/postgres-content-service.ts`
- Modify: `server/src/domain/types.ts`
- Modify: `server/src/http/workbench/content-routes.ts`
- Modify: `apps/workbench-web/src/types/domain.ts`
- Modify: `apps/workbench-web/src/api/client.ts`
- Test: `server/src/http/team-workspace-shared-files-api.integration.test.ts`
- Test: `server/src/http/team-workspace-file-versions-api.integration.test.ts`

- [ ] **Step 1: Add failing projection tests**

```ts
assert.deepEqual(Object.keys(uploaded.body.data).sort(), [
  'canDownload', 'canReference', 'createdAt', 'id', 'logicalFileId', 'name',
  'parseErrorCode', 'parseStatus', 'sizeLabel', 'source', 'updatedAt', 'versionCount', 'versionNo',
].sort())
assert.equal(uploaded.body.data.canReference, true)
```

Add a parser-failure case asserting HTTP 201 with `parseStatus: 'failed'`, a stable `logicalFileId`, safe `parseErrorCode`, and one logical file row.

- [ ] **Step 2: Run integration tests**

Run: `pnpm test:m5:shared-files:integration && pnpm test:m5:file-versions:integration`

Expected: FAIL because write responses omit derived fields and parser failure throws.

- [ ] **Step 3: Define the canonical DTO**

```ts
export interface WorkspaceFileProjection {
  id: string
  logicalFileId: string
  name: string
  source: 'workspace'
  sizeLabel: string
  versionNo: number
  versionCount: number
  parseStatus: 'pending' | 'succeeded' | 'failed'
  parseErrorCode: string | null
  canReference: boolean
  canDownload: boolean
  createdAt: string
  updatedAt: string
}
```

Create one private `projectWorkspaceFile(logicalFileId, actorUserId, transaction?)` method and call it from list, first upload, version upload and restore paths.

- [ ] **Step 4: Change durable parse failure semantics**

After file/version persistence, catch extraction failure, mark the version failed, and return the canonical projection instead of throwing. Only failures before durable file creation remain request failures.

- [ ] **Step 5: Run server and client tests**

Run: `pnpm test:m5:shared-files:integration && pnpm test:m5:file-versions:integration && pnpm --filter @dsh-work/workbench-web test -- api/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit canonical projection**

```bash
git add server/src/modules/workbench/application/postgres-content-service.ts server/src/domain/types.ts server/src/http/workbench/content-routes.ts apps/workbench-web/src/types/domain.ts apps/workbench-web/src/api/client.ts server/src/http/team-workspace-shared-files-api.integration.test.ts server/src/http/team-workspace-file-versions-api.integration.test.ts
git commit -m "fix: return canonical workspace file projections"
```

### Task 5: Replace fake reference text with a real file picker

**Files:**
- Create: `apps/workbench-web/src/components/WorkspaceFilePickerDialog.vue`
- Create: `apps/workbench-web/src/components/WorkspaceFilePickerDialog.test.ts`
- Modify: `packages/workbench-components/src/TaskComposer.vue`
- Modify: `apps/workbench-web/src/components/team-space-composer/team-space-composer.vue`
- Modify: `apps/workbench-web/src/components/ConversationStarter.vue`
- Test: `apps/workbench-web/src/components/TaskComposer.test.ts`

- [ ] **Step 1: Write failing composer and picker tests**

```ts
it('emits open-workspace-files instead of inserting marker text', async () => {
  await wrapper.get('[aria-label="引用团队文件"]').trigger('click')
  expect(wrapper.emitted('open-workspace-files')).toHaveLength(1)
  expect(wrapper.find('textarea').element.value).not.toContain('@工作空间文件')
})

it('selects only a server-referenceable file', async () => {
  await wrapper.getByRole('button', { name: '选择 月报.csv' }).trigger('click')
  expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ logicalFileId: 'wfile-1', canReference: true })
})
```

- [ ] **Step 2: Run frontend tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- TaskComposer.test.ts WorkspaceFilePickerDialog.test.ts`

Expected: FAIL because no picker/event exists.

- [ ] **Step 3: Implement the picker contract**

Props: `workspaceId`, `modelValue`; emits `update:modelValue`, `select(WorkspaceFileProjection)`. Load `listWorkspaceFiles` with cursor, show pending/failed states, disable `canReference !== true`, and expose accessible “加载更多”.

- [ ] **Step 4: Wire the composer**

`TaskComposer` emits `open-workspace-files`; `team-space-composer` owns the dialog and forwards the selected stable `logicalFileId`; `ConversationStarter` maintains `referencedWorkspaceFileIds` and visible selected filename. Remove the dead `/files` navigation branch.

- [ ] **Step 5: Run component tests**

Run: `pnpm test:m5:frontend`

Expected: PASS; no marker-only reference path remains.

- [ ] **Step 6: Commit file picker**

```bash
git add apps/workbench-web/src/components/WorkspaceFilePickerDialog.vue apps/workbench-web/src/components/WorkspaceFilePickerDialog.test.ts packages/workbench-components/src/TaskComposer.vue apps/workbench-web/src/components/team-space-composer/team-space-composer.vue apps/workbench-web/src/components/ConversationStarter.vue apps/workbench-web/src/components/TaskComposer.test.ts
git commit -m "feat: select real team files from the composer"
```

### Task 6: Enforce UI capabilities and split workspace loading

**Files:**
- Modify: `apps/workbench-web/src/stores/content.ts`
- Create: `apps/workbench-web/src/stores/content.test.ts`
- Modify: `apps/workbench-web/src/views/WorkspacesView.vue`
- Modify: `apps/workbench-web/src/views/WorkspacesView.test.ts`
- Modify: `apps/workbench-web/src/views/WorkspaceDetailView.vue`
- Modify: `apps/workbench-web/src/views/WorkspaceDetailView.test.ts`
- Modify: `server/src/modules/workbench/application/postgres-content-service.ts`

- [ ] **Step 1: Write failing partial-success Store test**

```ts
it('keeps successful workspaces when artifacts fail', async () => {
  api.getWorkspaces.mockResolvedValue([teamWorkspace])
  api.getArtifacts.mockRejectedValue(new Error('503'))
  api.getAgents.mockResolvedValue([])
  const store = useContentStore()
  await store.refreshWorkspaces()
  expect(store.workspaces).toEqual([teamWorkspace])
  expect(store.workspaceError).toBe('')
})
```

- [ ] **Step 2: Write viewer capability tests**

Assert both toolbar and empty-state upload buttons are absent for `currentUserRole: 'viewer'`, while version/download controls follow server projection.

- [ ] **Step 3: Run frontend tests**

Run: `pnpm --filter @dsh-work/workbench-web test -- content.test.ts WorkspacesView.test.ts WorkspaceDetailView.test.ts`

Expected: FAIL on coupled `Promise.all` and visible viewer buttons.

- [ ] **Step 4: Split Store state**

Expose independent methods and errors:

```ts
refreshWorkspaces(): Promise<void>
refreshArtifacts(): Promise<void>
refreshAgents(): Promise<void>
loadWorkspaceFiles(workspaceId: string, cursor?: string): Promise<void>
```

`refresh()` may call `Promise.allSettled` for shell convenience but must apply every fulfilled result independently and retain previous successful data on rejection.

- [ ] **Step 5: Slim workspace list projection**

Stop querying/attaching all file summaries in `listWorkspaces`; return `fileCount` and at most the already-approved minimal preview fields. Files Tab calls paginated `listWorkspaceFiles` and owns `items/nextCursor/hasMore`.

- [ ] **Step 6: Apply one capability predicate**

Define `canUploadWorkspaceFiles = !isPersonal && workspace.status === 'active' && ['owner','admin','member'].includes(currentUserRole)` and use it for toolbar, empty state and version upload. Keep backend checks unchanged.

- [ ] **Step 7: Run frontend and integration tests**

Run: `pnpm test:m5:frontend && pnpm test:m5:shared-files:integration`

Expected: PASS.

- [ ] **Step 8: Commit workspace loading changes**

```bash
git add apps/workbench-web/src/stores/content.ts apps/workbench-web/src/stores/content.test.ts apps/workbench-web/src/views/WorkspacesView.vue apps/workbench-web/src/views/WorkspacesView.test.ts apps/workbench-web/src/views/WorkspaceDetailView.vue apps/workbench-web/src/views/WorkspaceDetailView.test.ts server/src/modules/workbench/application/postgres-content-service.ts
git commit -m "fix: decouple workspace reads and enforce file capabilities"
```

### Task 7: Add P1 browser coverage and API documentation

**Files:**
- Create: `e2e/content-workspace-contracts.integration.spec.ts`
- Create: `playwright.content-workspace.config.ts`
- Modify: `docs/development/openapi-workbench.json`

- [ ] **Step 1: Implement the dedicated journeys**

Cover real file selection, viewer UI/403, parse failure row, immediate reference, partial endpoint failure and paginated loading. Use separate browser contexts for member/viewer.

- [ ] **Step 2: Run the P1 suite**

Run: `pnpm exec playwright test --config playwright.content-workspace.config.ts`

Expected: PASS using disposable PostgreSQL/storage; no development or production data.

- [ ] **Step 3: Update OpenAPI**

Document canonical file projection, parse-failed success semantics, paginated files and slim workspace list compatibility fields.

- [ ] **Step 4: Run contract tests**

Run: `pnpm test:unit src/http/openapi-coverage.test.ts && pnpm verify contracts`

Expected: PASS.

- [ ] **Step 5: Commit browser/API coverage**

```bash
git add e2e/content-workspace-contracts.integration.spec.ts playwright.content-workspace.config.ts docs/development/openapi-workbench.json
git commit -m "test: cover content workspace contracts"
```

### Task 8: Verify and package Batch 2 independently

**Files:**
- Create: `docs/release/2026-10-21-b2-content-workspace-acceptance.md`

- [ ] **Step 1: Record migration, GC, compatibility and rollback evidence fields**

Include candidate counts, retained/deleted/failed metrics, list response p95 size, parse failure counts, P0/P1/P2 status and the read-only target checks from the review questionnaire.

- [ ] **Step 2: Run focused suites**

Run: `pnpm test:m4:file:integration && pnpm test:m5:shared-files:integration && pnpm test:m5:file-versions:integration && pnpm test:m5:frontend`

Expected: PASS.

- [ ] **Step 3: Run repository gates**

Run: `pnpm verify && pnpm check:architecture && pnpm typecheck && pnpm lint && pnpm build`

Expected: all exit 0.

- [ ] **Step 4: Run P0 and dedicated P1**

Run: `pnpm test:e2e && pnpm exec playwright test --config playwright.content-workspace.config.ts`

Expected: PASS, recorded separately.

- [ ] **Step 5: Commit acceptance record**

```bash
git add docs/release/2026-10-21-b2-content-workspace-acceptance.md
git commit -m "docs: record batch 2 acceptance evidence"
```

## Independent rollback

1. Stop the GC sweep before switching Releases; in-flight object deletion must finish or fail atomically.
2. Atomically restore the prior frontend/API Release; leave `0085` and candidates intact.
3. Do not delete candidates manually. Old code ignores the table; the next forward Release resumes safe evaluation.
4. Confirm workspace list/file downloads work on the old Release and collect read-only orphan counts.
