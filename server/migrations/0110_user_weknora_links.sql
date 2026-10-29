create table user_weknora_links (
  user_id text primary key references users(id) on delete cascade,
  weknora_user_id text not null,
  link_source text not null check (link_source in ('bind', 'directory')),
  linked_at timestamptz not null default now()
);

create table weknora_bind_states (
  state text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create index weknora_bind_states_expires on weknora_bind_states (expires_at);
