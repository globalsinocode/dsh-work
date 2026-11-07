-- Skill 创建专家（docs/design/skill-creator-plan.md 4.2～4.3）。
--
-- 1. Agent 版本的“可创建 Skill”开关：与推荐开关同一机制，随版本发布、可回滚；关闭时不进入定义与验证指纹。
alter table agent_versions add column skill_creation_enabled boolean not null default false;

-- 2. 员工 Skill 提交：一个提交记录对应一个待审核的 Skill 名称。第一期来源只有“对话创建”（SC6），
--    来源字段为后续员工端表单提交 ZIP / 链接预留。状态：draft（草稿，可提交）→ pending（待审核，
--    可撤回回到 draft）→ approved / rejected（审核切片写入）。被拒或通过后再次保存生成新版本并回到 draft；
--    通过后的修订沿用 skill_id，发布为同一 Skill 的新版本。
create table skill_submissions (
  id text primary key,
  tenant_id text not null references tenants(id),
  submitter_user_id text not null,
  source text not null check (source in ('conversation', 'zip', 'link')),
  session_id text,
  name text not null check (char_length(name) between 1 and 120),
  skill_id text,
  status text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  current_version_id text,
  submitted_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (source <> 'conversation' or session_id is not null),
  foreign key (tenant_id, submitter_user_id) references users (tenant_id, id),
  foreign key (tenant_id, session_id) references sessions (tenant_id, id),
  foreign key (tenant_id, skill_id) references skills (tenant_id, id)
);
-- 同一会话中同名的草稿归为一个提交记录。
create unique index skill_submissions_session_name_idx
  on skill_submissions (tenant_id, session_id, name) where source = 'conversation';
create index skill_submissions_submitter_idx on skill_submissions (tenant_id, submitter_user_id, status);
create index skill_submissions_status_idx on skill_submissions (tenant_id, status, submitted_at);

-- 3. 提交的不可变版本：内容按现有包规则校验后存入 Skill 文件夹存储（只保存引用与文件索引）。
--    对话创建的版本记录保存它的 Run 与 Attempt，会话详情据此把草稿卡片挂在对应回复下。
create table skill_submission_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  submission_id text not null,
  version_number integer not null check (version_number >= 1),
  run_id text,
  attempt_id text,
  artifact jsonb not null,
  package_sha256 text not null,
  compatibility jsonb not null,
  script_count integer not null default 0 check (script_count >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, submission_id, version_number),
  foreign key (tenant_id, submission_id) references skill_submissions (tenant_id, id),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts (tenant_id, id)
);
create index skill_submission_versions_run_idx on skill_submission_versions (tenant_id, run_id);

alter table skill_submissions add foreign key (tenant_id, current_version_id)
  references skill_submission_versions (tenant_id, id);
