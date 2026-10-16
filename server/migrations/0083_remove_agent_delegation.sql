-- Agent delegation (PF-06) is removed; it will be redesigned when AI employees
-- need to hand work to each other. Drops the parent/child delegation ledger and the
-- per-version delegation policy. Historical child Tasks keep source_type
-- 'delegation', which the Task source check still accepts for existing rows; no new
-- delegation Task is created.
drop table task_delegations;

alter table agent_versions
  drop constraint agent_versions_delegation_policy_shape,
  drop column delegation_policy;
