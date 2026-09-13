-- Skill source files live in the managed macOS data directory. PostgreSQL keeps
-- only immutable storage references, hashes and file indexes.
alter table skill_versions
  add column artifact_ref text,
  add column package_sha256 text;

alter table run_attempts
  add column legacy_manifest_sha256 text;

create index skill_versions_by_artifact_ref
  on skill_versions (tenant_id, artifact_ref)
  where artifact_ref is not null;

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

comment on column skill_versions.artifact_ref is 'Relative immutable Skill folder reference below DSH_WORK_DATA_ROOT/skills';
comment on column skill_versions.package_sha256 is 'Verified digest of the immutable Skill folder contents';
comment on column run_attempts.legacy_manifest_sha256 is 'Pre-externalization manifest digest retained when legacy inline Skill files are migrated';
