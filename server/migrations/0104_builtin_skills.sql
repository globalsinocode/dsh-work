-- 平台内置 Skill（docs/design/builtin-skills-plan.md）。
--
-- 内置 Skill 随代码发布，不写入 skills / skill_versions。这里只保存两项平台配置：
-- 1. 已安装 Skill 的“覆盖内置场景”：运行中有该 Skill 时去掉对应场景的内置 Skill。
--    Skill 级配置，不随版本固定，修改立即对新运行生效。
-- 2. Runtime 配置追加的内置 Skill 紧急停用清单，与 disabled_tools 同一版本行。

alter table skills add column covered_builtin_scenarios jsonb not null default '[]'::jsonb;
alter table skills add constraint skills_covered_builtin_scenarios_shape
  check (jsonb_typeof(covered_builtin_scenarios) = 'array');

alter table runtime_configurations add column disabled_builtin_skills jsonb not null default '[]'::jsonb;
alter table runtime_configurations add constraint runtime_configurations_disabled_builtin_skills_shape
  check (jsonb_typeof(disabled_builtin_skills) = 'array');
