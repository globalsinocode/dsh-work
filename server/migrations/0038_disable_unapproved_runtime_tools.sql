-- Fail closed for DSH tools whose required per-call administrator approval is
-- not yet implemented by the platform. Keeping their catalog metadata allows
-- the management UI to explain why they cannot be granted.
update tools
   set status = 'disabled', updated_at = now()
 where tenant_id = 'tenant-dsh-work'
   and connector_id = 'connector-dsh-workspace'
   and dsh_tool_name in ('bash', 'job_kill')
   and status <> 'disabled';
