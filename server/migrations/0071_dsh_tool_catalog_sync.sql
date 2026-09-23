-- DSH Runtime tools are synchronized into the platform inventory as a whole.
-- Admission remains separate from discovery so an unreviewed Runtime tool can
-- be visible to administrators without becoming executable by an Agent.

alter table tools
  add column if not exists admission_status text not null default 'approved'
    check (admission_status in ('approved', 'unavailable')),
  add column if not exists admission_message text not null default '已完成平台安全准入';

create index if not exists tools_by_runtime_admission
  on tools (tenant_id, connector_id, admission_status, status);
