-- TW-10 空间共享讨论与 @Agent 触发（docs/design/team-workspace-plan.md TW-10）：
--   团队空间会话由「发起人私有的 Agent 会话」改为「全部成员可见、可参与的共享
--   讨论」；普通消息不产生 Run，@Agent 成员才触发执行。
--
--   1) sessions.agent_version_id 放开可空：讨论会话在首次 @Agent 前不绑定 Agent；
--      配套放宽 0027 的 audience 配置约束——workbench 会话只保留 workspace_id
--      非空要求（个人空间既有会话不受影响，admin 会话约束不变）。
--   2) messages.sender_user_id：共享会话中用户消息的作者归属；历史消息保持
--      null，展示层回退到会话创建者。
alter table sessions drop constraint sessions_audience_configuration;
alter table sessions alter column agent_version_id drop not null;
alter table sessions add constraint sessions_audience_configuration check (
  (audience = 'workbench' and workspace_id is not null)
  or (audience = 'admin' and agent_version_id is null and workspace_id is null)
);

alter table messages add column if not exists sender_user_id text;
alter table messages add constraint messages_sender_user_fk
  foreign key (tenant_id, sender_user_id) references users(tenant_id, id);
