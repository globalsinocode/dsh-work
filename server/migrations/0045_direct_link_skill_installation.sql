-- C7 deterministic import is a draft-only platform operation, not an Agent run.
alter table skill_installations drop constraint skill_installations_channel_check;
alter table skill_installations add constraint skill_installations_channel_check
  check (channel in ('assistant', 'zip', 'link'));
alter table skill_installations drop constraint skill_installations_channel_source;
alter table skill_installations add constraint skill_installations_channel_source
  check ((channel = 'assistant' and run_id is not null)
      or (channel in ('zip', 'link') and run_id is null));

-- Duplicate imports keep original version metadata; the acquisition ledger still
-- protects a reused draft at publish time, without relabelling published versions.
create index skill_link_installations_by_version on skill_installations (tenant_id, version_id)
  where channel = 'link' and status = 'installed';
