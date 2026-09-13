alter table skill_installations alter column run_id drop not null;
alter table skill_installations
  add column channel text not null default 'assistant' check (channel in ('assistant', 'zip'));
alter table skill_installations
  add constraint skill_installations_channel_source check (
    (channel = 'assistant' and run_id is not null)
    or (channel = 'zip' and run_id is null)
  );
