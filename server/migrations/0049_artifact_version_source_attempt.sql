-- I-06: task-result verification evidence must be scoped to the current
-- Attempt. artifact_versions previously carried only source_run_id, so a
-- failed Attempt's registered artifacts were counted again after a retry,
-- inflating (or fabricating) the new Attempt's deliveries.
--
-- Evidence-metadata column only: no existing table is rewritten and no
-- semantic of artifact_versions.version_no/file_object_id changes.

alter table artifact_versions
  add column if not exists source_attempt_id text;

alter table artifact_versions
  add constraint artifact_versions_source_attempt_fk
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id);

-- Historical rows predate the column: attribute each version to the Attempt
-- that was current when it was registered — the attempt created no later
-- than the version row. For a run that never retried this is its only
-- attempt; for a retried run, versions registered by the failed attempt keep
-- pointing at it instead of leaking into the retry's evidence. Rows whose
-- timestamp precedes every attempt (not producible through the publish path,
-- which requires a current attempt) fall back to the run's first attempt so
-- existing evidence stays attributable rather than silently dropped.
update artifact_versions av
   set source_attempt_id = coalesce(
     (select ra.id
        from run_attempts ra
       where ra.tenant_id = av.tenant_id
         and ra.run_id = av.source_run_id
         and ra.created_at <= av.created_at
       order by ra.attempt_no desc
       limit 1),
     (select ra.id
        from run_attempts ra
       where ra.tenant_id = av.tenant_id
         and ra.run_id = av.source_run_id
       order by ra.attempt_no asc
       limit 1)
   )
 where av.source_attempt_id is null;

create index if not exists artifact_versions_by_source_attempt
  on artifact_versions (tenant_id, source_run_id, source_attempt_id);
