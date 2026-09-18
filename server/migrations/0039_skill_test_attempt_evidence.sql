-- Strict trial evidence is tied to the original configuration and exact Attempt.
-- Historical results remain legacy; no fabricated backfill or active-version changes.
create table skill_test_bindings (
  tenant_id text not null references tenants(id),
  run_id text not null,
  skill_id text not null,
  skill_version_id text not null,
  configuration_fingerprint text not null,
  runtime_fingerprint text not null,
  test_prompt text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, skill_id) references skills(tenant_id, id),
  foreign key (tenant_id, skill_version_id) references skill_versions(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create function prevent_skill_test_binding_update()
returns trigger language plpgsql as $$
begin
  raise exception 'skill test start bindings are immutable';
end;
$$;
create trigger skill_test_bindings_immutable
  before update on skill_test_bindings
  for each row execute function prevent_skill_test_binding_update();

alter table skill_test_runs
  add column runtime_run_id text,
  add column runtime_attempt_id text,
  add column evidence_policy text not null default 'legacy',
  add constraint skill_test_runs_runtime_run_fk
    foreign key (tenant_id, runtime_run_id) references runs(tenant_id, id),
  add constraint skill_test_runs_runtime_attempt_fk
    foreign key (tenant_id, runtime_attempt_id) references run_attempts(tenant_id, id),
  add constraint skill_test_runs_attempt_evidence_required
    check (evidence_policy <> 'attempt-v2' or (runtime_run_id is not null and runtime_attempt_id is not null));

create unique index skill_test_runs_one_result_per_attempt
  on skill_test_runs (tenant_id, skill_version_id, runtime_attempt_id)
  where runtime_attempt_id is not null;

-- Activations already have a unique index prefixed by (tenant_id, attempt_id).
create index skill_python_executions_by_attempt
  on skill_python_executions (tenant_id, attempt_id);
