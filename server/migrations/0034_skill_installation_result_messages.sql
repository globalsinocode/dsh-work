insert into messages (id, tenant_id, session_id, run_id, role, content, created_at)
select
  'message-' || i.id || '-installed',
  i.tenant_id,
  r.session_id,
  i.run_id,
  'assistant',
  'Skill“' || coalesce(s.name, i.plan->>'rootName', '已安装 Skill') || '”已安装完成，并保存为 0.1.0 待验证草稿。' || chr(10) ||
    'Skill 标识：' || i.skill_id || chr(10) ||
    '下一步：前往 Skill 中心执行严格试运行，确认结果后发布；发布前 Agent 不会使用该 Skill。',
  i.updated_at
from skill_installations i
join runs r on r.tenant_id = i.tenant_id and r.id = i.run_id
left join skills s on s.tenant_id = i.tenant_id and s.id = i.skill_id
where i.channel = 'assistant' and i.status = 'installed' and i.run_id is not null and i.skill_id is not null
on conflict (id) do nothing;

update sessions target
set last_active_at = greatest(target.last_active_at, latest.installed_at)
from (
  select r.tenant_id, r.session_id, max(i.updated_at) as installed_at
  from skill_installations i
  join runs r on r.tenant_id = i.tenant_id and r.id = i.run_id
  where i.channel = 'assistant' and i.status = 'installed'
  group by r.tenant_id, r.session_id
) latest
where target.tenant_id = latest.tenant_id and target.id = latest.session_id;
