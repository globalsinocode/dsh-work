-- 0093 重建 workspace_activity_events 的 kind / object_type 约束时只列了项目空间新增的取值，
-- 把 0087 已有的讨论、@ 提及与 Run 终态通知一并挤掉了：写入 discussion_posted 直接违反
-- check 约束（团队讨论、任务对话首条消息都会失败，且失败被吞成一条 console.error）。
-- 这里按两版取值的并集重建，后续新增取值也必须继续叠加而不是覆盖。
alter table workspace_activity_events drop constraint if exists workspace_activity_events_kind_check;
alter table workspace_activity_events add constraint workspace_activity_events_kind_check
  check (kind in (
    'member_added',
    'member_removed',
    'member_exit',
    'role_changed',
    'owner_transferred',
    'agent_member_added',
    'agent_member_removed',
    'file_uploaded',
    'file_removed',
    'file_version_added',
    'workspace_archived',
    'workspace_restored',
    'discussion_posted',
    'member_mentioned',
    'run_completed',
    'run_failed',
    'brief_updated',
    'project_task_created',
    'project_task_completed'
  ));

alter table workspace_activity_events drop constraint if exists workspace_activity_events_object_type_check;
alter table workspace_activity_events add constraint workspace_activity_events_object_type_check
  check (object_type in (
    'member',
    'agent_member',
    'file',
    'workspace',
    'session',
    'run',
    'brief',
    'project_task'
  ));
