-- Agent detail page, stage S4: recent Runs per Agent are read through the
-- Task's executor principal (pinned when the first Attempt is created).
create index tasks_by_executor_principal
  on tasks (tenant_id, executed_as_principal_id, created_at desc)
  where executed_as_principal_id is not null;
