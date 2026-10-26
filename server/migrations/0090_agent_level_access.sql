-- Agent access belongs to the Agent, not to a version (Agent configuration and
-- release redesign, stage S2). Who may ask the Agent for work becomes an
-- Agent-level property that takes effect immediately; data access is granted
-- only to the Agent's execution principal, so the per-version data-scope
-- ceiling is removed.
-- `if not exists`: upgrade tests that exercise current code against an older
-- schema add the column ahead of this migration.
alter table agents add column if not exists visible_role_ids jsonb not null default '[]'::jsonb
  check (jsonb_typeof(visible_role_ids) = 'array');
-- Optimistic-concurrency token of the whole access setting (audience, roles,
-- data scopes, principal status). It is separate from the execution
-- principal's authorization_version, which pins Attempts: changing only the
-- audience must not invalidate queued work.
alter table agents add column access_revision integer not null default 1
  check (access_revision > 0);

-- Keep what employees see today: the active version's audience, or the
-- draft's audience for an Agent that was never published.
update agents a
   set visible_role_ids = coalesce(
     (select av.visible_role_ids from agent_versions av
       where av.tenant_id = a.tenant_id and av.id = a.active_version_id),
     (select av.visible_role_ids from agent_versions av
       where av.tenant_id = a.tenant_id and av.id = a.draft_version_id),
     '[]'::jsonb);

alter table agent_versions
  drop column visible_role_ids,
  drop column data_scopes;
