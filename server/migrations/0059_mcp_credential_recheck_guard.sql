-- 0057 originally trusted a successful discovery message without proving that
-- it was produced after the current Bearer credential was stored. Correct any
-- already-upgraded Connector conservatively: an active encrypted credential
-- must have a later health check before the Connector becomes available to Agents.
update connectors c
   set status = 'degraded', updated_at = now()
 where c.protocol = 'mcp'
   and c.auth_type = 'bearer'
   and c.status = 'healthy'
   and c.deleted_at is null
   and not exists (
     select 1
       from credential_secrets cs
      where cs.tenant_id = c.tenant_id
        and cs.credential_ref_id = c.credential_ref_id
        and exists (
          select 1
            from connector_health_checks h
           where h.tenant_id = c.tenant_id
             and h.connector_id = c.id
             and h.checked_at > cs.updated_at
        )
   );
