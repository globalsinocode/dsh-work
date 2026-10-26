-- 项目空间 S4（docs/design/project-space-plan.md 第 11 节）：执行规则与统一任务状态。
-- 每个 Agent 任务都有一条执行规则（手动 / 每天 / 每周，“工作日”存为每周一至五）；
-- 任务状态与单次执行脱钩，两类任务都由人标记完成；单次执行结果只作为“最近执行”展示。

alter table project_tasks
  add column schedule jsonb,
  add column schedule_revision integer not null default 0,
  add column next_slot_utc timestamptz,
  add column schedule_state text check (schedule_state in ('active', 'paused', 'stopped')),
  add column schedule_reason text check (schedule_reason is null or length(schedule_reason) <= 64),
  add column schedule_set_by text,
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0);

-- 现有 Agent 任务：迁移为“手动”规则，归因人取创建人；执行过的任务进入进行中（状态不再由执行推算）。
update project_tasks
   set schedule = jsonb_build_object('kind', 'manual', 'timezone', 'Asia/Shanghai'),
       schedule_state = 'active',
       schedule_set_by = created_by
 where assignee_type = 'agent';

update project_tasks t
   set status = 'in_progress'
 where t.assignee_type = 'agent' and t.status = 'todo'
   and exists (select 1 from runs r where r.tenant_id = t.tenant_id and r.session_id = t.session_id);

alter table project_tasks
  add constraint project_tasks_schedule_set_by_fk
    foreign key (tenant_id, schedule_set_by) references users(tenant_id, id),
  add constraint project_tasks_schedule_shape check (
    (assignee_type = 'employee' and schedule is null and schedule_state is null and next_slot_utc is null)
    or (assignee_type = 'agent' and schedule is not null and schedule_state is not null and schedule_set_by is not null)
  );

-- 调度扫描：只看启用中、未移除且已到期的定时规则。
create index project_tasks_schedule_due_idx on project_tasks (next_slot_utc)
  where schedule_state = 'active' and removed_at is null and next_slot_utc is not null;

-- 任务事件扩展到 Agent 任务：规则变更、暂停 / 恢复 / 停止，定时执行的受理、跳过与错过。
-- 定时执行的事件以规则设置人为 actor（归因），界面显示为“定时执行”。
alter table project_task_events drop constraint project_task_events_kind_check;
alter table project_task_events add constraint project_task_events_kind_check check (kind in (
  'status_changed', 'completed', 'reassigned',
  'schedule_changed', 'schedule_paused', 'schedule_resumed', 'schedule_stopped',
  'scheduled_run', 'execution_skipped', 'execution_missed'
));
