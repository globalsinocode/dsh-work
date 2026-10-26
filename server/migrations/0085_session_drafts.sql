alter table sessions drop constraint if exists sessions_status_check;
alter table sessions add constraint sessions_status_check
  check (status in ('draft', 'active', 'archived'));
alter table sessions add column if not exists client_intent_id text;
create unique index if not exists sessions_creator_intent_unique
  on sessions (tenant_id, created_by, client_intent_id)
  where client_intent_id is not null;
create index if not exists sessions_draft_created_at_idx
  on sessions (tenant_id, created_at)
  where status = 'draft';
