-- Skill 创建专家：管理员审核（docs/design/skill-creator-plan.md 4.4）。
--
-- 管理员在审核详情点“开始试运行”时，平台以该管理员身份把提交的当前版本存为 Skill 的待发布版本
-- （新 Skill 或已通过 Skill 的新版本），之后沿用现有严格试运行与发布门禁。
--
-- 1. 安装来源新增 submission：与 ZIP / 链接一样不经安装助手（run_id 为空），使存入的 Skill 成为安装根节点，
--    发布后按同一口径进入 Skill 广场。
alter table skill_installations drop constraint skill_installations_channel_check;
alter table skill_installations add constraint skill_installations_channel_check
  check (channel in ('assistant', 'zip', 'link', 'submission'));
alter table skill_installations drop constraint skill_installations_channel_source;
alter table skill_installations add constraint skill_installations_channel_source
  check ((channel = 'assistant' and run_id is not null)
      or (channel in ('zip', 'link', 'submission') and run_id is null));

-- 2. 提交版本对应的 Skill 待发布版本（开始试运行时写入，一个提交版本至多一个）。
alter table skill_submission_versions add column skill_version_id text;
alter table skill_submission_versions add foreign key (tenant_id, skill_version_id)
  references skill_versions (tenant_id, id);
create unique index skill_submission_versions_skill_version_idx
  on skill_submission_versions (tenant_id, skill_version_id) where skill_version_id is not null;

-- 3. 审核结论针对的提交版本。
alter table skill_submissions add column reviewed_version_id text;
alter table skill_submissions add foreign key (tenant_id, reviewed_version_id)
  references skill_submission_versions (tenant_id, id);
