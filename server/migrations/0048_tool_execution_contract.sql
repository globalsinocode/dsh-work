-- I-05: persist the execution semantics attached to each immutable Tool version.

alter table tool_versions
  add column if not exists output_validation text not null default 'unavailable'
    check (output_validation in ('runtime', 'platform', 'unavailable')),
  add column if not exists retry_policy text not null default 'never'
    check (retry_policy in ('safe', 'never', 'verify-first')),
  add column if not exists concurrency_policy text not null default 'serialized'
    check (concurrency_policy in ('concurrent', 'serialized')),
  add column if not exists completion_semantics text not null default 'completed'
    check (completion_semantics in ('completed', 'accepted'));

-- Existing tools did not enforce their documented output schemas at the
-- platform boundary. Preserve those schemas as documentation, but record the
-- actual validation/retry/concurrency semantics explicitly.
update tool_versions tv
   set output_validation = 'unavailable',
       retry_policy = case when t.mode = 'read' then 'safe' else 'never' end,
       concurrency_policy = case when t.mode = 'read' then 'concurrent' else 'serialized' end,
       completion_semantics = 'completed'
  from tools t
 where t.tenant_id = tv.tenant_id and t.id = tv.tool_id;

-- DSH Runtime currently publishes no enforceable output schema for its native
-- file/task tools. Mark that boundary instead of retaining aspirational shapes
-- that the platform cannot validate.
update tool_versions tv
   set output_schema = '{"x-dsh-work-output-validation":"unavailable"}'::jsonb
  from tools t
 where t.tenant_id = tv.tenant_id
   and t.id = tv.tool_id
   and t.system = 'DSH Runtime';
