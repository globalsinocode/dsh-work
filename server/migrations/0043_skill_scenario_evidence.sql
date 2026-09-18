-- Keep scenario-level passes distinct from legacy whole-bundle trial passes.
-- Criteria live in each immutable Attempt Manifest; no old test is relabelled.
alter table skill_test_runs
  add constraint skill_scenario_attempt_evidence_required
    check (evidence_policy <> 'scenario-v1' or (runtime_run_id is not null and runtime_attempt_id is not null));
