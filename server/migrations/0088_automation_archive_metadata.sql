-- Batch 4：归档元数据；产品层「已归档」仍映射 status = disabled。
alter table agent_automations add column if not exists archived_at timestamptz;
alter table agent_automations add column if not exists archived_by text;

create index if not exists agent_automations_owner_status_created_idx
  on agent_automations (tenant_id, owner_user_id, status, created_at desc);
