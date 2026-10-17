-- 项目空间 S2（docs/design/project-space-plan.md 第 7 节）：项目档案与项目档案员。
-- 档案是有序条目列表，每次变更新增一个版本；档案员是平台系统运行（purpose
-- project-archive），按空间串行整理新完成的任务成果。

-- 项目档案：最新版本即当前档案；不覆盖历史版本，回退也生成新版本。
create table workspace_archive_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  version_no integer not null check (version_no > 0),
  -- 条目数组（字符串），上限由服务端校验：最多 50 条，每条 1～500 字。
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 50),
  source_kind text not null check (source_kind in ('archivist', 'manual', 'rollback')),
  source_run_id text,
  -- 档案员版本所依据的项目任务（按处理顺序）。
  source_task_ids text[] not null default '{}',
  rollback_from_version_no integer,
  created_by text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, version_no),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  constraint workspace_archive_versions_source_shape check (
    (source_kind = 'archivist' and source_run_id is not null and created_by is null and rollback_from_version_no is null)
    or (source_kind = 'manual' and source_run_id is null and created_by is not null and rollback_from_version_no is null)
    or (source_kind = 'rollback' and source_run_id is null and created_by is not null and rollback_from_version_no is not null)
  )
);

-- 待整理的任务成果：任务完成时登记，档案员整理时认领（update_id），成功后标记已整理。
-- 失败或被丢弃时释放认领，随下一次触发重试；失败 3 次后不再整理（abandoned_at）。
create table workspace_archive_inputs (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  project_task_id text not null,
  -- Agent 任务对应成功的那次 Run；员工任务为空。
  source_run_id text,
  title text not null,
  content text not null check (length(content) <= 8000),
  update_id text,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  abandoned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, project_task_id) references project_tasks(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id)
);

-- 同一次 Agent 执行只登记一次。
create unique index workspace_archive_inputs_run_unique on workspace_archive_inputs (tenant_id, source_run_id) where source_run_id is not null;
create index workspace_archive_inputs_pending_idx on workspace_archive_inputs (tenant_id, workspace_id, created_at)
  where consumed_at is null and abandoned_at is null;

-- 每个空间最多一次进行中的整理。update_id 为空表示空闲。
create table workspace_archivist_state (
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  update_id text,
  run_id text,
  base_version_no integer not null default 0 check (base_version_no >= 0),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, workspace_id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id)
);
