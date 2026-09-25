-- Keep Attempt-scoped operation keys after record deletion, without retaining
-- the deleted record body or its version rows. This also upgrades databases
-- where the AE-03 base migration was already applied.
alter table agent_data_record_operations
  alter column record_version_id drop not null,
  add column deleted_at timestamptz,
  add constraint agent_data_record_operations_deleted_check
    check ((record_version_id is null) = (deleted_at is not null));
