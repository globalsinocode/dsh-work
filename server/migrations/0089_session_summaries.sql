-- EX-02: DSH-generated summaries of the middle of long conversations. A summary
-- covers the session's messages after the first user message up to and including
-- covered_through (ordered by created_at, id). Each turn carries the first message
-- verbatim, the latest succeeded summary and the newest messages verbatim.
-- At most one summary run is pending per session; summaries are never edited,
-- a newer summary supersedes older ones.
create table session_summaries (
  id text primary key,
  tenant_id text not null references tenants(id),
  session_id text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  covered_through_message_id text not null,
  covered_through_created_at timestamptz not null,
  covered_message_count integer not null check (covered_message_count > 0),
  content text check (content is null or char_length(content) <= 8000),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  source_run_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  check ((status = 'succeeded') = (content is not null and content_sha256 is not null))
);

create unique index session_summaries_one_pending
  on session_summaries (tenant_id, session_id) where status = 'pending';
create index session_summaries_latest
  on session_summaries (tenant_id, session_id, covered_through_created_at desc, covered_through_message_id desc)
  where status = 'succeeded';
create index session_summaries_by_run
  on session_summaries (tenant_id, source_run_id) where source_run_id is not null;
