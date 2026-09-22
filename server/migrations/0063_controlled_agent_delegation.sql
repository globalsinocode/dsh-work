-- PF-06: governed tool-style Agent delegation on the existing Task/Run chain.
-- Delegation policy is platform-owned configuration fixed with each Agent Version;
-- packages cannot grant it. Child Tasks share the root Task budget account.

alter table agent_versions
  add column delegation_policy jsonb not null default '{"allowedAgentVersionIds":[],"maxDepth":1,"maxParallel":1,"timeoutSeconds":120}'::jsonb,
  add constraint agent_versions_delegation_policy_shape check (
    jsonb_typeof(delegation_policy) = 'object'
    and delegation_policy ?& array['allowedAgentVersionIds', 'maxDepth', 'maxParallel', 'timeoutSeconds']
    and delegation_policy - array['allowedAgentVersionIds', 'maxDepth', 'maxParallel', 'timeoutSeconds'] = '{}'::jsonb
    and jsonb_typeof(delegation_policy->'allowedAgentVersionIds') = 'array'
    and jsonb_array_length(delegation_policy->'allowedAgentVersionIds') <= 16
    and jsonb_typeof(delegation_policy->'maxDepth') = 'number'
    and jsonb_typeof(delegation_policy->'maxParallel') = 'number'
    and jsonb_typeof(delegation_policy->'timeoutSeconds') = 'number'
    and (delegation_policy->>'maxDepth')::integer between 1 and 4
    and (delegation_policy->>'maxParallel')::integer between 1 and 4
    and (delegation_policy->>'timeoutSeconds')::integer between 10 and 300
  );

alter table tasks drop constraint tasks_source_type_check;
alter table tasks add constraint tasks_source_type_check
  check (source_type in ('session', 'automation', 'api', 'event', 'system', 'delegation'));

create table task_delegations (
  id text primary key,
  tenant_id text not null references tenants(id),
  root_task_id text not null,
  parent_task_id text not null,
  parent_run_id text not null,
  parent_attempt_id text not null,
  child_task_id text not null,
  child_run_id text not null,
  target_agent_version_id text not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  prompt text not null check (char_length(prompt) between 1 and 12000),
  context jsonb not null default '{}'::jsonb,
  depth integer not null check (depth between 1 and 4),
  role_ceiling jsonb not null default '[]'::jsonb,
  data_scope_ceiling jsonb not null default '[]'::jsonb,
  status text not null check (status in ('accepted', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, parent_attempt_id, request_digest),
  unique (tenant_id, child_task_id),
  unique (tenant_id, child_run_id),
  foreign key (tenant_id, root_task_id) references tasks(tenant_id, id),
  foreign key (tenant_id, parent_task_id, parent_run_id) references runs(tenant_id, task_id, id),
  foreign key (tenant_id, parent_run_id, parent_attempt_id) references run_attempts(tenant_id, run_id, id),
  foreign key (tenant_id, child_task_id, child_run_id) references runs(tenant_id, task_id, id),
  foreign key (tenant_id, target_agent_version_id) references agent_versions(tenant_id, id),
  check (parent_task_id <> child_task_id),
  check (jsonb_typeof(context) = 'object'),
  check (jsonb_typeof(role_ceiling) = 'array'),
  check (jsonb_typeof(data_scope_ceiling) = 'array'),
  check ((status in ('accepted', 'running')) = (completed_at is null)),
  check ((status in ('failed', 'timed_out')) = (error_code is not null))
);

create index task_delegations_by_parent
  on task_delegations (tenant_id, parent_task_id, created_at asc);
create index task_delegations_active_children
  on task_delegations (tenant_id, parent_task_id, status)
  where status in ('accepted', 'running');
