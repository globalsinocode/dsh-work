-- dsh-work 助手推荐 AI 同事（docs/design/agent-recommendation-plan.md）。
--
-- 1. Agent 版本的“可推荐其他 AI 同事”开关：与联网搜索、项目任务管理同一机制，随版本发布、可回滚。
alter table agent_versions add column agent_recommendation_enabled boolean not null default false;

-- 2. 推荐记录：由 recommend_agents 工具在 Attempt 内写入，按发起员工当前可用的同事校验后保存。
--    会话详情只展示各 Run 当前 Attempt 的记录；名称与说明在读取时取同事当前启用版本，
--    这里只保存推荐理由（模型生成的纯文本，限长）。
create table agent_recommendations (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  session_id text,
  recommended_for_user_id text not null,
  source_agent_version_id text not null,
  agent_id text not null,
  reason text not null check (char_length(reason) between 1 and 120),
  position integer not null check (position between 1 and 3),
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, position),
  unique (tenant_id, attempt_id, agent_id),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  foreign key (tenant_id, recommended_for_user_id) references users (tenant_id, id)
);
create index agent_recommendations_run_idx on agent_recommendations (tenant_id, run_id);

-- 3. dsh-work 助手发布开启推荐的新版本（推荐方案 R1）。沿用 0100 的做法：复制当前启用版本为新的
--    补丁版本并设为启用；已在群组中的 Agent 成员仍固定在旧版本，推荐本就只在个人对话中装配。
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

  if source_version.id is not null and not source_version.agent_recommendation_enabled then
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
      'id', 'agent-version-dsh-work-assistant-agent-recommendation-1',
      'version', next_version,
      'agent_recommendation_enabled', true,
      'status', 'published',
      'created_at', now(),
      'published_at', now(),
      'published_by', coalesce(source_version.published_by, source_version.created_by),
      'source_version', source_version.version,
      'change_summary', '开启推荐其他 AI 同事：在个人对话中推荐更合适的 AI 同事',
      'agent_spec', case
        when source_version.agent_spec is null then null
        else jsonb_set(
          jsonb_set(source_version.agent_spec, '{metadata,version}', to_jsonb(next_version), true),
          '{capabilities,agentRecommendation}', 'true'::jsonb, true)
      end
    ));

    update agents
       set active_version_id = 'agent-version-dsh-work-assistant-agent-recommendation-1', updated_at = now()
     where tenant_id = 'tenant-dsh-work' and id = 'agent-dsh-work-assistant';

    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type, object_id,
      result, trace_id, safe_context, occurred_at
    ) values (
      'audit-agent-release-dsh-work-assistant-agent-recommendation-1', 'tenant-dsh-work',
      'user', coalesce(source_version.published_by, source_version.created_by),
      'agent.release.publish', 'agent', 'agent-dsh-work-assistant', 'success',
      'trace-agent-release-dsh-work-assistant-agent-recommendation-1',
      jsonb_build_object(
        'agentVersionId', 'agent-version-dsh-work-assistant-agent-recommendation-1',
        'note', '开启推荐其他 AI 同事：在个人对话中推荐更合适的 AI 同事。'
      ),
      now()
    ) on conflict (id) do nothing;
  end if;
end;
$$;
