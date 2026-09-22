-- MCP capability snapshots become effective immediately after successful DSH
-- discovery. Preserve explicit disablement and real connectivity failures.
update mcp_connector_profiles
   set approval_status = 'approved',
       approved_digest = capability_digest,
       reviewed_at = coalesce(reviewed_at, now()),
       updated_at = now()
 where capability_digest is not null
   and jsonb_array_length(capability_snapshot) > 0;

update connectors c
   set status = 'healthy', updated_at = now()
 where c.protocol = 'mcp'
   and c.status = 'degraded'
   and c.deleted_at is null
   and exists (
     select 1
       from mcp_connector_profiles p
      where p.tenant_id = c.tenant_id
        and p.connector_id = c.id
        and p.approval_status = 'approved'
        and p.capability_digest = p.approved_digest
   )
   and exists (
     select 1
       from connector_health_checks h
      where h.tenant_id = c.tenant_id
        and h.connector_id = c.id
        and h.id = (
          select latest.id
            from connector_health_checks latest
           where latest.tenant_id = c.tenant_id
             and latest.connector_id = c.id
           order by latest.checked_at desc, latest.id desc
           limit 1
        )
        and (h.message like '%等待整体审核%' or h.message like '%需要重新审核%')
        and (
          c.auth_type <> 'bearer'
          or exists (
            select 1
              from credential_secrets cs
             where cs.tenant_id = c.tenant_id
               and cs.credential_ref_id = c.credential_ref_id
               and cs.updated_at < h.checked_at
          )
        )
   );
