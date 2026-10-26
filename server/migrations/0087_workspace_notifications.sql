-- ---------------------------------------------------------------------------
-- 0086: sequenced notification deliveries (batch 3 / main-flow-hardening B3)
--
-- Adds a tenant-wide monotonic sequence on workspace_activity_events,
-- per-recipient delivery rows, account/workspace sequence watermarks, and
-- new notifiable activity kinds (discussion, mention, run terminal).
-- ---------------------------------------------------------------------------

create sequence if not exists workspace_activity_sequence;

alter table workspace_activity_events add column if not exists sequence bigint;

update workspace_activity_events
   set sequence = nextval('workspace_activity_sequence')
 where sequence is null;

alter table workspace_activity_events
  alter column sequence set default nextval('workspace_activity_sequence');

alter table workspace_activity_events
  alter column sequence set not null;

create unique index if not exists workspace_activity_events_sequence_unique
  on workspace_activity_events (tenant_id, sequence);

alter table workspace_activity_events drop constraint if exists workspace_activity_events_kind_check;

alter table workspace_activity_events add constraint workspace_activity_events_kind_check
  check (kind in (
    'member_added',
    'member_removed',
    'member_exit',
    'role_changed',
    'owner_transferred',
    'agent_member_added',
    'agent_member_removed',
    'file_uploaded',
    'file_removed',
    'file_version_added',
    'workspace_archived',
    'workspace_restored',
    'discussion_posted',
    'member_mentioned',
    'run_completed',
    'run_failed'
  ));

alter table workspace_activity_events drop constraint if exists workspace_activity_events_object_type_check;

alter table workspace_activity_events add constraint workspace_activity_events_object_type_check
  check (object_type in ('member', 'agent_member', 'file', 'workspace', 'session', 'run'));

create table if not exists workspace_notification_deliveries (
  tenant_id text not null references tenants(id),
  activity_id text not null references workspace_activity_events(id),
  recipient_user_id text not null references users(id),
  workspace_id text not null,
  sequence bigint not null,
  muted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tenant_id, activity_id, recipient_user_id),
  foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id)
);

create index if not exists workspace_notification_recipient_sequence_idx
  on workspace_notification_deliveries (tenant_id, recipient_user_id, sequence desc);

alter table workspace_notification_states
  add column if not exists last_read_sequence bigint not null default 0;

alter table workspace_notification_states drop constraint if exists workspace_notification_states_last_read_sequence_check;

alter table workspace_notification_states add constraint workspace_notification_states_last_read_sequence_check
  check (last_read_sequence >= 0);

create table if not exists workspace_notification_account_states (
  tenant_id text not null references tenants(id),
  user_id text not null references users(id),
  last_read_sequence bigint not null default 0,
  primary key (tenant_id, user_id),
  constraint workspace_notification_account_states_last_read_sequence_check
    check (last_read_sequence >= 0)
);

comment on table workspace_notification_deliveries is
  'Per-recipient projection of notifiable workspace activity. Written in the same transaction as the activity fact.';

comment on column workspace_notification_account_states.last_read_sequence is
  'Account-level read watermark: deliveries at or below this sequence are read for inbox/badge purposes.';
