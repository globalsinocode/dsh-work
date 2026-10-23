-- 项目空间 S6：Agent 查看与维护项目任务（方案第 13 节，D31–D34）。
-- 1. Agent 版本的“项目任务管理”开关：与联网搜索同一机制，随版本发布、可回滚。
alter table agent_versions add column project_tasks_enabled boolean not null default false;

-- 2. 经 Agent 写入的归因：动作人仍是发起成员（created_by / actor_user_id），另记执行的 Agent 成员与 Run。
--    via = {"agentMemberId": ..., "agentName": ..., "runId": ...}；人直接操作时为空。
alter table project_tasks add column created_via jsonb;

-- 3. 任务事件新增 edited（标题、说明、截止日期的修改），Agent 写入时在时间线显示结果卡片。
alter table project_task_events drop constraint project_task_events_kind_check;
alter table project_task_events add constraint project_task_events_kind_check check (kind in (
  'status_changed', 'completed', 'reassigned', 'edited',
  'schedule_changed', 'schedule_paused', 'schedule_resumed', 'schedule_stopped',
  'scheduled_run', 'execution_skipped', 'execution_missed'
));

-- 4. dsh-work 助手发布开启项目任务管理的新版本（D31）。沿用 0036 的做法：复制当前启用版本为新的
--    补丁版本并设为启用；已在群组中的 Agent 成员仍固定在旧版本，由负责人按既有流程升级。
do $$
declare
  source_version agent_versions%rowtype;
  next_patch integer;
  next_version text;
begin
  select av.* into source_version
    from agents a
    join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
   where a.tenant_id = 'tenant-dsh-work' and a.id = 'agent-dsh-work-assistant';

  if source_version.id is not null and not source_version.project_tasks_enabled then
    next_patch := split_part(source_version.version, '.', 3)::integer + 1;
    next_version := split_part(source_version.version, '.', 1) || '.'
      || split_part(source_version.version, '.', 2) || '.' || next_patch;
    while exists (
      select 1 from agent_versions
       where tenant_id = 'tenant-dsh-work' and agent_id = 'agent-dsh-work-assistant' and version = next_version
    ) loop
      next_patch := next_patch + 1;
      next_version := split_part(source_version.version, '.', 1) || '.'
        || split_part(source_version.version, '.', 2) || '.' || next_patch;
    end loop;

    insert into agent_versions
    select * from jsonb_populate_record(null::agent_versions, to_jsonb(source_version) || jsonb_build_object(
      'id', 'agent-version-dsh-work-assistant-project-tasks-1',
      'version', next_version,
      'project_tasks_enabled', true,
      'status', 'published',
      'created_at', now(),
      'published_at', now(),
      'published_by', coalesce(source_version.published_by, source_version.created_by),
      'source_version', source_version.version,
      'change_summary', '开启项目任务管理：在项目空间中查看与维护任务',
      'agent_spec', case
        when source_version.agent_spec is null then null
        else jsonb_set(
          jsonb_set(source_version.agent_spec, '{metadata,version}', to_jsonb(next_version), true),
          '{capabilities,projectTasks}', 'true'::jsonb, true)
      end
    ));

    update agents
       set active_version_id = 'agent-version-dsh-work-assistant-project-tasks-1', updated_at = now()
     where tenant_id = 'tenant-dsh-work' and id = 'agent-dsh-work-assistant';

    -- 0085 起发布记录写入 audit_events（agent_release_records 已删除）。
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type, object_id,
      result, trace_id, safe_context, occurred_at
    ) values (
      'audit-agent-release-dsh-work-assistant-project-tasks-1', 'tenant-dsh-work',
      'user', coalesce(source_version.published_by, source_version.created_by),
      'agent.release.publish', 'agent', 'agent-dsh-work-assistant', 'success',
      'trace-agent-release-dsh-work-assistant-project-tasks-1',
      jsonb_build_object(
        'agentVersionId', 'agent-version-dsh-work-assistant-project-tasks-1',
        'note', '开启项目任务管理：在项目空间中查看与维护任务。'
      ),
      now()
    ) on conflict (id) do nothing;
  end if;
end;
$$;
