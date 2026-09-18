-- Additive: owner-scoped Session history. Run limits are not Session limits.
create index sessions_personal_history on sessions (tenant_id, created_by, last_active_at desc, id desc)
  where status = 'active' and audience = 'workbench';
