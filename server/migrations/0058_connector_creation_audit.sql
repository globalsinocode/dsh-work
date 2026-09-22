-- Preserve who registered a Connector and when so the management list can show
-- creation provenance separately from the latest operational update.

alter table connectors
  add column created_at timestamptz,
  add column created_by text;

update connectors c
   set created_at = coalesce(
         (
           select min(h.checked_at)
             from connector_health_checks h
            where h.tenant_id = c.tenant_id
              and h.connector_id = c.id
         ),
         c.updated_at,
         now()
       ),
       created_by = coalesce(
         (
           select h.checked_by
             from connector_health_checks h
            where h.tenant_id = c.tenant_id
              and h.connector_id = c.id
            order by h.checked_at, h.id
            limit 1
         ),
         (
           select u.id
             from users u
            where u.tenant_id = c.tenant_id
            order by u.created_at, u.id
            limit 1
         )
       );

alter table connectors
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column created_by set not null,
  add constraint connectors_created_by_fk
    foreign key (tenant_id, created_by) references users(tenant_id, id);
