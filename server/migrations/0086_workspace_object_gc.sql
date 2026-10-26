-- Batch 2: journal unreferenced workspace object keys for deferred safe deletion.
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
