-- Durable delegation and write-plan confirmations for the general admin assistant.
create table admin_assistant_task_proposals (
  id text primary key,
  tenant_id text not null,
  session_id text not null,
  run_id text not null,
  created_by text not null,
  task_kind text not null check (task_kind in ('skill-install', 'agent-management', 'platform-operations')),
  target_purpose text not null check (target_purpose in ('admin-skill-install', 'admin-agent-manage', 'admin-platform-operations')),
  request_text text not null,
  summary text not null,
  impact text not null,
  source jsonb,
  proposal_sha256 text not null check (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  delegated_run_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, run_id),
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references sessions (tenant_id, id),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, delegated_run_id) references runs (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id)
);

create index admin_assistant_task_proposals_by_session
  on admin_assistant_task_proposals (tenant_id, session_id, created_at);

create table admin_assistant_action_plans (
  id text primary key,
  tenant_id text not null,
  session_id text not null,
  run_id text not null,
  created_by text not null,
  action_type text not null check (action_type in ('agent-update-draft', 'agent-set-status', 'runtime-update-configuration')),
  summary text not null,
  plan jsonb not null,
  plan_sha256 text not null check (plan_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'executing', 'executed', 'cancelled', 'failed')),
  result_summary text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, run_id),
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references sessions (tenant_id, id),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id)
);

create index admin_assistant_action_plans_by_session
  on admin_assistant_action_plans (tenant_id, session_id, created_at);
