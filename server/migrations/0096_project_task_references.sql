-- 项目空间 S1 补充约束：任务承接的 Agent 成员必须属于同一空间；完成人、移除人是本租户用户。
-- Agent 成员移除只改状态、不删行，已有任务引用保持有效。
alter table workspace_agent_members
  add constraint workspace_agent_members_workspace_id_unique unique (tenant_id, workspace_id, id);

alter table project_tasks
  add constraint project_tasks_assignee_agent_member_fk
    foreign key (tenant_id, workspace_id, assignee_agent_member_id)
    references workspace_agent_members(tenant_id, workspace_id, id),
  add constraint project_tasks_completed_by_fk
    foreign key (tenant_id, completed_by) references users(tenant_id, id),
  add constraint project_tasks_removed_by_fk
    foreign key (tenant_id, removed_by) references users(tenant_id, id);
