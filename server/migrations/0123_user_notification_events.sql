-- 站内通知方案 NC-S3：再收三类与本人相关的事件。
--
--   task_schedule_stopped  项目 Agent 任务的定时执行被暂停或停止（接收人：规则设置人）
--   automation_failed      定时任务的一次执行失败、被跳过、错过或未能开始（接收人：定时任务所有者）
--   skill_review_result    员工提交的 Skill 被通过或拒绝（接收人：提交人）
--
-- 新增对象类型 automation、skill_submission。仍只存对象 ID 与代码值（暂停原因、执行结果、
-- 审核结论），名称与可见性在读取时解析；拒绝原因不进入通知。不回填历史。

alter table user_notifications drop constraint user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check check (kind in (
  'mention',
  'task_assigned',
  'task_completed',
  'workspace_member_added',
  'task_schedule_stopped',
  'automation_failed',
  'skill_review_result'
));

alter table user_notifications drop constraint user_notifications_object_type_check;
alter table user_notifications add constraint user_notifications_object_type_check check (
  object_type in ('message', 'project_task', 'workspace', 'automation', 'skill_submission')
);
