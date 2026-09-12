-- Earlier local previews applied 0027 before management sessions stopped requiring a workspace.
-- Keep employee sessions bound to a workspace while allowing isolated admin sessions.
alter table sessions alter column workspace_id drop not null;
alter table sessions drop constraint if exists sessions_audience_configuration;
alter table sessions add constraint sessions_audience_configuration check (
  (audience = 'workbench' and agent_version_id is not null and workspace_id is not null)
  or (audience = 'admin' and agent_version_id is null and workspace_id is null)
);
