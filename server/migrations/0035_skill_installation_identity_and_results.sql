alter table skills
  add column if not exists installation_key text;

alter table skill_installations
  add column if not exists result_type text,
  add column if not exists installed_version text;

alter table skill_installations
  add constraint skill_installations_result_type check (
    result_type is null or result_type in ('created', 'updated', 'duplicate')
  );

-- Historical package installs may already contain duplicate display names. Keep
-- the oldest row as the canonical package identity so the migration is safe,
-- while every future package install is protected by the unique index below.
with installed_skills as (
  select
    s.tenant_id,
    s.id,
    lower(btrim(s.name)) as installation_key,
    row_number() over (
      partition by s.tenant_id, lower(btrim(s.name))
      order by s.updated_at, s.id
    ) as ordinal
  from skills s
  where exists (
    select 1
    from skill_versions sv
    where sv.tenant_id = s.tenant_id
      and sv.skill_id = s.id
      and sv.artifact_ref is not null
      and sv.package_sha256 is not null
  )
)
update skills s
set installation_key = installed_skills.installation_key
from installed_skills
where s.tenant_id = installed_skills.tenant_id
  and s.id = installed_skills.id
  and installed_skills.ordinal = 1
  and s.installation_key is null;

create unique index if not exists skills_by_installation_key
  on skills (tenant_id, installation_key)
  where installation_key is not null;

update skill_installations i
set
  result_type = coalesce(i.result_type, 'created'),
  installed_version = coalesce(i.installed_version, sv.version)
from skill_versions sv
where i.tenant_id = sv.tenant_id
  and i.version_id = sv.id
  and i.status = 'installed';

comment on column skills.installation_key is 'Stable normalized package identity used to prevent duplicate Skill installs';
comment on column skill_installations.result_type is 'Final install resolution: created, updated, or duplicate';
comment on column skill_installations.installed_version is 'Resolved existing or newly created Skill version';
