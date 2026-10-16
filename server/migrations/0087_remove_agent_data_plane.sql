-- Remove the Agent work data plane (AE-03): shared collections, records,
-- proposals, private state and installations. No Agent used it and it had no
-- admin page; it will be redesigned for a concrete scenario if needed.
-- Not kept for compatibility: the tables and their rows are dropped. Old
-- agent_versions.agent_spec documents may still carry a `data` key; the
-- platform no longer reads it, and immutable versions are left untouched.

drop trigger agents_create_installation on agents;
drop function create_agent_installation();

drop table agent_data_collection_schema_versions;
drop table agent_data_record_deletions;
drop table agent_data_proposals;
drop table agent_data_write_counters;
drop table agent_data_record_operations;
alter table agent_data_records drop constraint agent_data_records_current_version_fk;
drop table agent_data_record_versions;
drop table agent_data_records;
drop table agent_data_collection_grants;
drop table agent_data_collections;
drop table agent_state;
drop table agent_installations;
