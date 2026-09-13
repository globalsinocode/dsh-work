-- Keep published Skill versions immutable during normal operation while allowing
-- the one-time controlled filesystem migration and administrator-approved reset.
create or replace function prevent_published_skill_version_update() returns trigger language plpgsql as $$
begin
  if old.status = 'published' and coalesce(current_setting('dsh_work.skill_storage_migration', true), '') <> 'on' then
    raise exception 'published versions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists skill_versions_immutable on skill_versions;
create trigger skill_versions_immutable before update or delete on skill_versions
  for each row execute function prevent_published_skill_version_update();
